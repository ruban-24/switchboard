import assert from 'node:assert/strict';
import test from 'node:test';
import { createVercelJevClassifier } from '../src/jev.ts';
import { defaultPolicy, bundledCatalog } from '../src/defaults.ts';
import { mergePolicy } from '../src/core/config.ts';
import { assessInitialRoute, parseClassification } from '../src/core/policy.ts';
import { Router } from '../src/core/session.ts';
import { applyRoute } from '../src/native/protocol.ts';
import { buildJevQuestions } from '../src/jev-questions.ts';
import type { ConversationState } from '../src/core/types.ts';

function response(tier = 'complex', modelConfidence = .95) {
  return {
    answers: {
      taskType: { type: 'choice', choice: 'implement' },
      complexity: { type: 'choice', choice: tier },
      sufficientContext: { type: 'choice', choice: 'true' },
      // Distinct answers expose accidentally using a different model's effort.
      effort_0: { type: 'choice', choice: 'low' },
      effort_1: { type: 'choice', choice: 'medium' },
      effort_2: { type: 'choice', choice: 'max' },
    },
    providerMetadata: { typesafe: { confidence: { taskType: .9, complexity: modelConfidence, sufficientContext: .9, effort_0: .99, effort_1: .93, effort_2: .98 } } },
    usage: { inputTokens: 100, outputTokens: 0 },
  };
}

test('one request selects effort for the model chosen after personal exclusions', async t => {
  const policy = mergePolicy(defaultPolicy, { excludedModels: { claude: ['claude-fable-5-1'] } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.equal(Object.keys(body.questions).length, 5);
    assert.match(body.questions.effort_0.instructions, /Ordinary bounded development/);
    assert.match(body.questions.effort_1.instructions, /resolving uncertain causes/);
    assert.doesNotMatch(JSON.stringify(body), /claude-fable-5-1|gpt-5/);
    const result = response('demanding');
    delete (result.answers as Record<string, unknown>).effort_2;
    delete (result.providerMetadata.typesafe.confidence as Record<string, unknown>).effort_2;
    return Response.json(result);
  });
  const classify = createVercelJevClassifier('fixture-key');
  const classification = await classify('Design the migration', new AbortController().signal, { tool: 'claude', policy, catalog: bundledCatalog });
  const route = assessInitialRoute(policy, bundledCatalog, 'claude', classification);
  assert.equal(calls, 1);
  assert.equal(classification.effortModel, 'claude-opus-5-5');
  assert.equal(classification.reasoning, 'medium');
  assert.equal(classification.confidences.effort, .93);
  assert.deepEqual(route.selection, { profile: 'claude-opus', model: 'claude-opus-5-5', effort: 'medium', excludedModel: 'claude-fable-5-1' });
});

test('model confidence floor uses balanced effort instead of the fast-model answer', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(response('routine', .4)));
  const classification = await createVercelJevClassifier('fixture-key')('Implement a function', new AbortController().signal,
    { tool: 'claude', policy: defaultPolicy, catalog: bundledCatalog });
  assert.equal(classification.effortModel, 'claude-sonnet-5');
  assert.equal(assessInitialRoute(defaultPolicy, bundledCatalog, 'claude', classification).selection.effort, 'low');
});

test('Haiku has no invented effort answer or confidence', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(response('routine')));
  const result = await createVercelJevClassifier('fixture-key')('Fix a typo', new AbortController().signal,
    { tool: 'claude', policy: defaultPolicy, catalog: bundledCatalog });
  assert.equal(result.effortModel, 'claude-haiku-4-5-20251001');
  assert.equal(result.reasoning, null);
  assert.equal(result.confidences.effort, null);
  assert.equal(assessInitialRoute(defaultPolicy, bundledCatalog, 'claude', result).selection.effort, null);
  assert.deepEqual(parseClassification(result), result);
});

test('missing selected-model effort preserves that model with its configured default', async t => {
  const body = response('standard');
  delete (body.providerMetadata.typesafe.confidence as Record<string, unknown>).effort_0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const classification = await createVercelJevClassifier('fixture-key')('Build a parser', new AbortController().signal,
    { tool: 'claude', policy: defaultPolicy, catalog: bundledCatalog });
  const route = assessInitialRoute(defaultPolicy, bundledCatalog, 'claude', classification);
  assert.equal(route.selection.model, 'claude-sonnet-5');
  assert.equal(route.selection.effort, 'medium');
  assert.deepEqual(route.adjustments, ['effort-unavailable']);
});

test('omitted selected effort answer uses its default without turning into a model fallback', async t => {
  const body = response('standard');
  delete (body.answers as Record<string, unknown>).effort_0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const router = new Router({ policy: defaultPolicy, catalog: bundledCatalog,
    repository: { async load() { return null; }, async save() {} }, classify: createVercelJevClassifier('fixture-key') });
  const result = await router.routeTurn({ tool: 'claude', conversationId: 'omitted-effort', turnId: 'first', kind: 'user', task: 'Implement an LRU cache' });
  assert.equal(result.selection.model, 'claude-sonnet-5');
  assert.equal(result.selection.effort, 'medium');
  assert.deepEqual(result.adjustments, ['effort-unavailable']);
});

test('omitted or unknown unselected effort answers cannot discard the selected-model result', async t => {
  const body = response('standard');
  delete (body.answers as Record<string, unknown>).effort_1;
  body.answers.effort_2.choice = 'unsupported';
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const result = await createVercelJevClassifier('fixture-key')('Implement an LRU cache', new AbortController().signal,
    { tool: 'claude', policy: defaultPolicy, catalog: bundledCatalog });
  assert.equal(result.effortModel, 'claude-sonnet-5');
  assert.equal(result.reasoning, 'low');
  assert.equal(result.confidences.effort, .99);
});

test('Router supplies its effective tool policy and keeps a model-aware route pinned', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(response()); });
  let state: ConversationState | null = null;
  const router = new Router({ policy: defaultPolicy, catalog: bundledCatalog,
    repository: { async load() { return state; }, async save(value) { state = value; } },
    classify: createVercelJevClassifier('fixture-key') });
  const first = await router.routeTurn({ tool: 'claude', conversationId: 'model-aware', turnId: 'one', kind: 'user', task: 'Review the race' });
  assert.equal(first.selection.model, 'claude-opus-5-5');
  assert.equal(first.selection.effort, 'medium');
  const next = await router.routeTurn({ tool: 'claude', conversationId: 'model-aware', turnId: 'two', kind: 'tool', task: '' });
  assert.deepEqual(next.selection, first.selection);
  assert.equal(calls, 1);
});

test('all 36 pairs survive one-call classification, Router policy, and native request rewriting', async t => {
  const models = [
    ['claude', 'routine', 'claude-haiku-4-5-20251001', null],
    ['claude', 'standard', 'claude-sonnet-5', 0],
    ['claude', 'complex', 'claude-opus-5-5', 1],
    ['claude', 'demanding', 'claude-fable-5-1', 2],
    ['codex', 'routine', 'gpt-6-luna', 0],
    // Sol serves both middle tiers, so one effort question covers both.
    ['codex', 'standard', 'gpt-6-sol', 1],
    ['codex', 'complex', 'gpt-6-sol', 1],
    ['codex', 'demanding', 'gpt-6-astra', 2],
  ] as const;
  let calls = 0;
  let nextResponse: unknown;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(nextResponse); });
  for (const [tool, tier, model, index] of models) {
    for (const effort of index === null ? [null] : ['low', 'medium', 'high', 'xhigh', 'max']) {
      const answers: Record<string, unknown> = {
        taskType: { type: 'choice', choice: 'implement' }, complexity: { type: 'choice', choice: tier },
        sufficientContext: { type: 'choice', choice: 'true' },
      };
      const confidence: Record<string, number> = { taskType: .95, complexity: .95, sufficientContext: .95 };
      for (let q = 0; q < 3; q++) {
        answers[`effort_${q}`] = { type: 'choice', choice: q === index ? effort : effort === 'low' ? 'max' : 'low' };
        confidence[`effort_${q}`] = q === index ? .95 : .99;
      }
      nextResponse = { answers, providerMetadata: { typesafe: { confidence } }, usage: { inputTokens: 100, outputTokens: 0 } };
      const router = new Router({ policy: defaultPolicy, catalog: bundledCatalog,
        repository: { async load() { return null; }, async save() {} }, classify: createVercelJevClassifier('fixture-key') });
      const decision = await router.routeTurn({ tool, conversationId: `pair-${calls}`, turnId: 'first', kind: 'user', task: 'Fixture engineering task' });
      assert.equal(decision.selection.model, model);
      assert.equal(decision.selection.effort, effort);
      assert.equal(decision.classification?.effortModel, model);
      const content = [{ role: 'user', content: 'preserve this exact prefix' }];
      const body = tool === 'claude' ? { model: 'switchboard', messages: content, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
        : { model: 'switchboard', input: content, reasoning: { effort: 'high' } };
      const rewritten = applyRoute(tool, tool === 'claude' ? '/v1/messages' : '/responses', body, decision.selection);
      assert.equal(rewritten.model, model);
      assert.deepEqual(rewritten[tool === 'claude' ? 'messages' : 'input'], content);
      if (effort === null) {
        assert.equal(rewritten.thinking, undefined);
        assert.equal(rewritten.output_config, undefined);
      } else {
        assert.equal((rewritten[tool === 'claude' ? 'output_config' : 'reasoning'] as { effort: string }).effort, effort);
      }
    }
  }
  assert.equal(calls, 36);
});

test('effort bound to another model is never reused after the eligible model changes', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(response('demanding')));
  const classification = await createVercelJevClassifier('fixture-key')('Design the migration', new AbortController().signal,
    { tool: 'claude', policy: defaultPolicy, catalog: bundledCatalog });
  assert.equal(classification.effortModel, 'claude-fable-5-1');
  assert.equal(classification.reasoning, 'max');
  const changed = mergePolicy(defaultPolicy, { excludedModels: { claude: ['claude-fable-5-1'] } });
  const route = assessInitialRoute(changed, bundledCatalog, 'claude', classification);
  assert.equal(route.selection.model, 'claude-opus-5-5');
  assert.equal(route.selection.effort, 'high');
  assert.deepEqual(route.adjustments, ['effort-unavailable']);
});

test('reused model profiles ask once and apply the selected profile effort cap', async t => {
  const policy = mergePolicy(defaultPolicy, {
    profiles: { 'sonnet-capped': { tool: 'claude', model: 'claude-sonnet-5', defaultReasoning: 'medium',
      efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } } },
    routing: { claude: { complex: 'sonnet-capped', demanding: 'sonnet-capped', uncertain: 'sonnet-capped' } },
  });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.equal(Object.keys(request.questions).length, 4);
    assert.match(request.questions.effort_0.instructions, /Ordinary bounded development/);
    const value = response('complex');
    value.answers.effort_0.choice = 'max';
    for (const key of ['effort_1', 'effort_2']) {
      delete (value.answers as Record<string, unknown>)[key];
      delete (value.providerMetadata.typesafe.confidence as Record<string, unknown>)[key];
    }
    return Response.json(value);
  });
  const classification = await createVercelJevClassifier('fixture-key')('Implement a function', new AbortController().signal,
    { tool: 'claude', policy, catalog: bundledCatalog });
  const route = assessInitialRoute(policy, bundledCatalog, 'claude', classification);
  assert.equal(route.selection.profile, 'sonnet-capped');
  assert.equal(route.selection.effort, 'high');
});

test('Haiku-only personal policy has no effort questions and disabled tools fail before a request', () => {
  const policy = mergePolicy(defaultPolicy, { excludedModels: { claude: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1'] } });
  const request = buildJevQuestions({ tool: 'claude', policy, catalog: bundledCatalog });
  assert.deepEqual(Object.keys(request.questions), ['taskType', 'complexity', 'sufficientContext']);
  assert.deepEqual(request.candidates, []);
  const disabled = mergePolicy(defaultPolicy, { enabledTools: ['codex'] });
  assert.throws(() => buildJevQuestions({ tool: 'claude', policy: disabled, catalog: bundledCatalog }), /not enabled/);
});
