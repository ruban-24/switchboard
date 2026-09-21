import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClassification, selectInitialRoute } from '../src/core/policy.ts';
import { catalogFixture, policyFixture } from './fixtures.ts';
import type { Classification } from '../src/core/types.ts';
import { bundledCatalog, defaultPolicy } from '../src/defaults.ts';
import { mergePolicy } from '../src/core/config.ts';

export const standard: Classification = {
  taskType: 'implement', complexity: 'standard', reasoning: 'medium', sufficientContext: true, confidences: { model: 0.95, effort: 0.95, context: 0.95, taskType: 0.95 },
};

test('initial model selection uses the task profile and that model\'s effort mapping', () => {
  const policy = policyFixture();
  assert.deepEqual(selectInitialRoute(policy, catalogFixture(), 'codex', standard), {
    profile: 'standard', model: 'fixture-standard', effort: 'medium',
  });
  assert.deepEqual(selectInitialRoute(policy, catalogFixture(), 'codex', { ...standard, complexity: 'complex', reasoning: 'low' }), {
    profile: 'strong', model: 'fixture-strong', effort: 'medium',
  });
});

test('classifier failures and insufficient or uncertain input use the explicit conservative mapping', () => {
  for (const classification of [null, { ...standard, sufficientContext: false }]) {
    assert.deepEqual(selectInitialRoute(policyFixture(), catalogFixture(), 'codex', classification), {
      profile: 'strong', model: 'fixture-strong', effort: 'high',
    });
  }
});

test('an absent mapping or unsupported effort cannot silently substitute another route', () => {
  assert.throws(() => selectInitialRoute(policyFixture(), catalogFixture(), 'claude', standard), /configured/i);
  const policy = policyFixture();
  policy.profiles.standard!.efforts.medium = 'max';
  assert.throws(() => selectInitialRoute(policy, catalogFixture(), 'codex', standard), /effort/i);
});

test('malformed classifier answers are rejected before routing', () => {
  assert.throws(() => parseClassification({ ...standard, confidence: Number.NaN }));
  assert.throws(() => parseClassification({ ...standard, complexity: 'cheapest' }));
});

test('demanding tasks can select the fourth tier automatically', () => {
  const demanding = parseClassification({ ...standard, complexity: 'demanding', reasoning: 'high' });
  assert.deepEqual(selectInitialRoute(policyFixture(), catalogFixture(), 'codex', demanding), {
    profile: 'top', model: 'fixture-top', effort: 'high',
  });
});

test('excluding the top model routes to the highest remaining tier using its own effort map', () => {
  const policy = policyFixture();
  policy.excludedModels.codex = ['fixture-top'];
  assert.deepEqual(selectInitialRoute(policy, catalogFixture(), 'codex', { ...standard, complexity: 'demanding', reasoning: 'low' }), {
    profile: 'strong', model: 'fixture-strong', effort: 'medium', excludedModel: 'fixture-top',
  });
  policy.excludedModels.codex.push('fixture-strong');
  assert.equal(selectInitialRoute(policy, catalogFixture(), 'codex', null).model, 'fixture-standard');
});

test('an excluded lower tier uses the next enabled higher tier and all-excluded fails explicitly', () => {
  const policy = policyFixture();
  policy.excludedModels.codex = ['fixture-standard'];
  assert.equal(selectInitialRoute(policy, catalogFixture(), 'codex', standard).model, 'fixture-strong');
  policy.excludedModels.codex = ['fixture-fast', 'fixture-standard', 'fixture-strong', 'fixture-top'];
  assert.throws(() => selectInitialRoute(policy, catalogFixture(), 'codex', standard), /no eligible/i);
});

test('reusing a profile in multiple tiers does not lower the fallback for a complex task', () => {
  const policy = policyFixture();
  policy.routing.codex.routine = 'strong';
  policy.excludedModels.codex = ['fixture-strong'];
  const complex: Classification = { ...standard, complexity: 'complex' };
  assert.equal(selectInitialRoute(policy, catalogFixture(), 'codex', complex).model, 'fixture-top');
  assert.equal(selectInitialRoute(policy, catalogFixture(), 'codex', null).model, 'fixture-top');
});

test('Haiku omits effort even when the reasoning demand is xhigh or max', () => {
  for (const reasoning of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const classification = parseClassification({ ...standard, complexity: 'routine', reasoning });
    const route = selectInitialRoute(defaultPolicy, bundledCatalog, 'claude', classification);
    assert.equal(route.model, 'claude-haiku-4-5-20251001');
    assert.equal(route.effort, null);
  }
});

test('excluding Fable or Astra retains a max request on the next eligible model', () => {
  const policy = mergePolicy(defaultPolicy, { excludedModels: { claude: ['claude-fable-5-1'], codex: ['gpt-6-astra'] } });
  const classification = parseClassification({ ...standard, complexity: 'demanding', reasoning: 'max' });
  for (const [tool, expected] of [['claude', 'claude-opus-5'], ['codex', 'gpt-5.6-sol']] as const) {
    const route = selectInitialRoute(policy, bundledCatalog, tool, classification);
    assert.equal(route.model, expected);
    assert.equal(route.effort, 'max');
  }
});

test('insufficient context uses the conservative high fallback even with a max proposal', () => {
  for (const [tool, model] of [['claude', 'claude-opus-5'], ['codex', 'gpt-5.6-sol']] as const) {
    const route = selectInitialRoute(defaultPolicy, bundledCatalog, tool, { ...standard, reasoning: 'max', sufficientContext: false });
    assert.equal(route.model, model);
    assert.equal(route.effort, 'high');
  }
});
