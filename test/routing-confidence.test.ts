import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy, bundledCatalog } from '../src/defaults.ts';
import { mergePolicy, parsePolicy } from '../src/core/config.ts';
import { parseClassification, selectInitialRoute } from '../src/core/policy.ts';
import type { Classification } from '../src/core/types.ts';

function classified(overrides: Record<string, unknown> = {}): Classification {
  return { taskType: 'implement', complexity: 'standard', reasoning: 'low', sufficientContext: true,
    confidences: { model: .9, effort: .57, context: .99, taskType: .1 }, ...overrides } as unknown as Classification;
}

test('uncertain effort uses the balanced default without upgrading either provider model', () => {
  for (const [tool, model] of [['claude', 'claude-sonnet-5'], ['codex', 'gpt-6-sol']] as const) {
    assert.deepEqual(selectInitialRoute(defaultPolicy, bundledCatalog, tool, classified()), {
      profile: tool === 'claude' ? 'claude-sonnet' : 'codex-sol-balanced', model, effort: 'medium',
    });
  }
});

test('low model confidence raises fast to balanced and preserves stronger proposed tiers', () => {
  for (const [complexity, model] of [['routine', 'gpt-6-sol'], ['complex', 'gpt-6-sol'], ['demanding', 'gpt-6-astra']] as const) {
    const route = selectInitialRoute(defaultPolicy, bundledCatalog, 'codex', classified({ complexity, reasoning: 'high',
      confidences: { model: .2, effort: .95, context: 1, taskType: 1 } }));
    assert.equal(route.model, model);
    assert.equal(route.effort, 'high');
  }
});

test('effort uncertainty preserves a higher proposal and uses the selected profile default after exclusion', () => {
  assert.equal(selectInitialRoute(defaultPolicy, bundledCatalog, 'codex', classified({ reasoning: 'max' })).effort, 'max');
  const policy = mergePolicy(defaultPolicy, { excludedModels: { codex: ['gpt-6-astra'] }, profiles: { 'codex-sol': { defaultReasoning: 'high' } } });
  const route = selectInitialRoute(policy, bundledCatalog, 'codex', classified({ complexity: 'demanding' }));
  assert.equal(route.model, 'gpt-6-sol');
  assert.equal(route.effort, 'high');
  assert.equal(route.excludedModel, 'gpt-6-astra');
});

test('confident effort and uncertain task-type/context scores do not override a confident model choice', () => {
  const route = selectInitialRoute(defaultPolicy, bundledCatalog, 'codex', classified({
    confidences: { model: .9, effort: .9, context: .1, taskType: .1 },
  }));
  assert.equal(route.model, 'gpt-6-sol');
  assert.equal(route.effort, 'low');
});

test('unclassifiable tasks and unavailable classifier keep the explicit strong high fallback', () => {
  for (const input of [null, classified({ sufficientContext: false })]) {
    const route = selectInitialRoute(defaultPolicy, bundledCatalog, 'codex', input);
    assert.equal(route.model, 'gpt-6-sol');
    assert.equal(route.effort, 'high');
  }
});

test('independent thresholds and profile defaults are configurable without changing the other axis', () => {
  const policy = mergePolicy(defaultPolicy, { classifier: { effortMinConfidence: .5 }, profiles: { 'codex-sol-balanced': { defaultReasoning: 'high' } } });
  assert.equal(selectInitialRoute(policy, bundledCatalog, 'codex', classified()).effort, 'low');
  const defaults = mergePolicy(defaultPolicy, { profiles: { 'codex-sol-balanced': { defaultReasoning: 'high' } } });
  assert.equal(selectInitialRoute(defaults, bundledCatalog, 'codex', classified()).effort, 'high');
});

test('legacy thresholds migrate to both axes and separate overrides win', () => {
  const migrated = mergePolicy(defaultPolicy, { classifier: { minConfidence: .4, effortMinConfidence: .8 } });
  assert.equal(migrated.classifier.modelMinConfidence, .4);
  assert.equal(migrated.classifier.effortMinConfidence, .8);
  const legacy = structuredClone(defaultPolicy) as unknown as { classifier: Record<string, unknown> };
  legacy.classifier = { timeoutMs: 3000, maxContextChars: 16000, minConfidence: .6 };
  assert.equal(parsePolicy(legacy).classifier.modelMinConfidence, .6);
  assert.throws(() => mergePolicy(defaultPolicy, { classifier: { effortMinConfidence: 1.1 } }));
});

test('legacy saved classification remains readable and invalid separate confidence fails validation', () => {
  const parsed = parseClassification({ taskType: 'implement', complexity: 'standard', reasoning: 'medium', sufficientContext: true, confidence: .57 });
  assert.deepEqual(parsed.confidences, { model: .57, effort: .57, context: .57, taskType: .57 });
  assert.throws(() => parseClassification(classified({ confidences: { model: 1.1, effort: .9, context: 1, taskType: 1 } })));
});

test('Codex Sol keeps a balanced effort default for standard tasks and a strong default for complex tasks', () => {
  const standard = selectInitialRoute(defaultPolicy, bundledCatalog, 'codex', classified({ effortModel: 'gpt-6-sol' }));
  const complex = selectInitialRoute(defaultPolicy, bundledCatalog, 'codex', classified({ complexity: 'complex', effortModel: 'gpt-6-sol' }));
  assert.deepEqual(standard, { profile: 'codex-sol-balanced', model: 'gpt-6-sol', effort: 'medium' });
  assert.deepEqual(complex, { profile: 'codex-sol', model: 'gpt-6-sol', effort: 'high' });
});

test('personal policy can still route the Codex standard tier to GPT-5.6 Terra', () => {
  const policy = mergePolicy(defaultPolicy, { routing: { codex: { standard: 'codex-terra' } } });
  assert.deepEqual(selectInitialRoute(policy, bundledCatalog, 'codex', classified({ effortModel: 'gpt-5.6-terra' })),
    { profile: 'codex-terra', model: 'gpt-5.6-terra', effort: 'medium' });
});
