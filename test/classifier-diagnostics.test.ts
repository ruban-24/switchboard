import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createConfiguredClassifier, classifierStatus } from '../src/classifier.ts';
import { defaultPolicy, bundledCatalog } from '../src/defaults.ts';
import { parseClassification } from '../src/core/policy.ts';
import { Router } from '../src/core/session.ts';
import { Store } from '../src/storage.ts';

const model = { routine: .02, standard: .93, complex: .04, demanding: .01 };
const contextProbabilities = { true: .99, false: .01 };
const effort = { low: .85, medium: .1, high: .03, xhigh: .01, max: .01 };
const context = { tool: 'claude' as const, policy: defaultPolicy, catalog: bundledCatalog };
function response() {
  const answer = (choice: string, probabilities?: Record<string, number>): { type: string; choice: string; confidence: number; probabilities?: Record<string, number> } => ({ type: 'choice', choice, confidence: .91, probabilities });
  return {
    model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0, inputTokens: 100, outputTokens: 0 },
    answers: {
      taskType: answer('implement'), complexity: answer('standard', model),
      sufficientContext: answer('true', contextProbabilities), effort_0: answer('low', effort),
      effort_1: answer('max', { ...effort, 'private-unselected': .5 }),
    } as Record<string, ReturnType<typeof answer> | undefined>,
    providerMetadata: { typesafe: { confidence: { taskType: .91, complexity: .91, sufficientContext: .91, effort_0: .91, effort_1: .91 } } },
    privateBody: 'private-response',
  };
}
function configured(provider: string) {
  return createConfiguredClassifier({ SWITCHBOARD_PROVIDER: provider, TYPESAFE_API_KEY: 'direct-secret', AI_GATEWAY_API_KEY: 'gateway-secret', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0' });
}

for (const provider of ['typesafe', 'vercel']) {
  test(`${provider}: absent or invalid diagnostic task type cannot upgrade a valid Sonnet low route`, async t => {
    const body = response();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(body); });
    for (const invalid of [undefined, { type: 'choice', choice: 'private-invalid-task-type', confidence: .91 }, { type: 'choice', choice: 'implement', confidence: 1.5 }]) {
      body.answers.taskType = invalid;
      body.providerMetadata.typesafe.confidence.taskType = invalid?.confidence ?? .91;
      const router = new Router({ ...context, repository: { async load() { return null; }, async save() {} }, classify: configured(provider) });
      const result = await router.routeTurn({ tool: 'claude', conversationId: `optional-${calls}`, turnId: 'first', kind: 'user', task: 'private-task' });
      assert.equal(result.reason, 'initial');
      assert.equal(result.selection.model, 'claude-sonnet-5');
      assert.equal(result.selection.effort, 'low');
      assert.equal(result.classification?.taskType, null);
      assert.equal(result.classification?.confidences.taskType, null);
      assert.doesNotMatch(JSON.stringify(result), /private-task|private-invalid-task-type/);
    }
    assert.equal(calls, 3);
  });

  test(`${provider}: captures only provenance and the selected distributions, independently of confidence`, async t => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json(response());
    });
    const result = await configured(provider)('private-task', new AbortController().signal, context);
    assert.equal(result.confidences.model, .91);
    assert.deepEqual(result.diagnostics, {
      provider, requestedModel: provider === 'typesafe' ? 'jev-1.13.0' : 'typesafe-ai/jev',
      resolvedModel: provider === 'typesafe' ? 'jev-1.13.0' : null,
      probabilities: { model, context: contextProbabilities, effort },
    });
    assert.deepEqual(parseClassification(result), result);
    assert.doesNotMatch(JSON.stringify(result), /private-|secret|input_tokens|providerMetadata/);
    assert.equal(calls.length, 1);
    if (provider === 'typesafe') assert.equal(calls[0]!.body.model, 'jev-1.13.0');
  });
}

test('TypeSafe status and request use the explicit environment version rather than a misleading alias', () => {
  assert.equal(classifierStatus({ TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0' }).modelId, 'jev-1.13.0');
  assert.equal(classifierStatus({}).modelId, 'jev-latest');
});

test('missing or malformed distributions and resolved versions are unknown, never fabricated or routing failures', async t => {
  const body = response();
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  for (const invalid of [undefined, { low: .9 }, { ...effort, low: -1 }, { ...effort, low: 1.1 }, { ...effort, low: .1 }, { ...effort, 'private-field': 0 }]) {
    body.answers.effort_0!.probabilities = invalid;
    body.model = 'private-model\u001b[31m';
    const result = await configured('typesafe')('task', new AbortController().signal, context);
    assert.equal(result.reasoning, 'low');
    assert.equal(result.diagnostics?.probabilities.effort, null);
    assert.equal(result.diagnostics?.resolvedModel, null);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
  body.answers.complexity!.choice = 'routine';
  const haiku = await configured('typesafe')('task', new AbortController().signal, context);
  assert.equal(haiku.diagnostics?.probabilities.effort, null);
  assert.equal(haiku.reasoning, null);
});

test('optional diagnostics survive saving, explain, and resume; unknown payloads do not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'router-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = response();
  delete body.answers.taskType;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const firstRouter = new Router({ ...context, repository: new Store(root), classify: configured('typesafe') });
  const first = await firstRouter.routeTurn({ tool: 'claude', conversationId: 'diagnostics', turnId: 'first', kind: 'user', task: 'private-task' });
  assert.equal(first.reason, 'initial');
  const state = (await new Store(root).load('claude', 'diagnostics'))!;
  assert.deepEqual(state.lastDecision.classification, first.classification);
  Object.assign(state.lastDecision.classification!.diagnostics!, { privateBody: 'private-response' });
  await new Store(root).save(state);
  const files = await readdir(join(root, 'sessions'));
  assert.doesNotMatch(await readFile(join(root, 'sessions', files[0]!), 'utf8'), /private-|secret/);
  const cli = spawnSync(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname, 'explain', 'claude', 'diagnostics'], {
    env: { ...process.env, SWITCHBOARD_HOME: root }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Task: unavailable/);
  assert.match(cli.stdout, /requested jev-1.13.0; resolved jev-1.13.0/);
  assert.match(cli.stdout, /Capability probabilities:.*standard 93%/);
  assert.match(cli.stdout, /Selected effort probabilities:.*low 85%/);
  const resumed = new Router({ ...context, repository: new Store(root), classify: async () => { throw Error('must not classify a tool continuation'); } });
  const continuation = await resumed.routeTurn({ tool: 'claude', conversationId: 'diagnostics', turnId: 'next', kind: 'tool', task: '' });
  assert.deepEqual(continuation.selection, first.selection);
});

test('Gateway malformed optional answer shapes and probability payloads cannot invalidate a route', async t => {
  let body: unknown;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(body); });
  const classify = configured('vercel');
  for (const taskType of [null, {}, [], { type: 'choice', choice: 4 }, { type: 'boolean', probability: .9 }]) {
    for (const probabilities of [null, [], 'private-probabilities', { standard: 'private-probability' }]) {
      const fixture = response();
      body = { ...fixture, answers: { ...fixture.answers, taskType,
        complexity: { ...fixture.answers.complexity, probabilities },
        sufficientContext: { ...fixture.answers.sufficientContext, probabilities },
        effort_0: { ...fixture.answers.effort_0, probabilities },
      } };
      const result = await classify('task', new AbortController().signal, context);
      assert.equal(result.taskType, null);
      assert.equal(result.confidences.taskType, null);
      assert.equal(result.effortModel, 'claude-sonnet-5');
      assert.equal(result.reasoning, 'low');
      assert.deepEqual(result.diagnostics?.probabilities, { model: null, context: null, effort: null });
      assert.doesNotMatch(JSON.stringify(result), /private-/);
    }
  }
  assert.equal(calls, 20);
  for (const key of ['complexity', 'sufficientContext']) {
    const fixture = response();
    body = { ...fixture, answers: { ...fixture.answers, taskType: null, [key]: null } };
    await assert.rejects(classify('task', new AbortController().signal, context), /classification failed/);
  }
});
