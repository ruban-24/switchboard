import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePolicy, parsePolicy, routedFamilies, validateMappings } from '../src/core/config.ts';
import { defaultPolicy, bundledCatalog, eligibleFamilies } from '../src/defaults.ts';
import { catalogFixture, policyFixture } from './fixtures.ts';

test('personal changes preserve unrelated defaults without mutating them', () => {
  const defaults = policyFixture();
  const effective = mergePolicy(defaults, { history: { limit: 3 }, profiles: { standard: { efforts: { low: 'medium' } } } });
  assert.equal(effective.history.limit, 3);
  assert.equal(effective.history.capturePrompts, false);
  assert.equal(effective.profiles.standard?.efforts.high, 'high');
  assert.equal(effective.profiles.standard?.efforts.low, 'medium');
  assert.equal(defaults.profiles.standard?.efforts.low, 'low');
});

test('unknown fields, invalid numeric limits and prototype keys are rejected', () => {
  for (const override of [
    { classifier: { timeotMs: 50 } }, { classifier: { timeoutMs: -1 } },
    { classifier: { minConfidence: 2 } }, { history: { limit: 1.5 } },
    JSON.parse('{"__proto__":{"polluted":true}}'), { enabledTools: ['invalid'] },
  ]) assert.throws(() => mergePolicy(policyFixture(), override));
});

test('route references must exist and belong to the matching tool', () => {
  assert.throws(() => mergePolicy(policyFixture(), { routing: { claude: { routine: 'fast' } } }), /tool/i);
  assert.throws(() => mergePolicy(policyFixture(), { routing: { codex: { routine: 'absent' } } }), /profile/i);
});

test('unsupported model and effort combinations cannot become active', () => {
  const wrong = mergePolicy(policyFixture(), { profiles: { fast: { efforts: { low: 'max' } } } });
  assert.throws(() => validateMappings(wrong, catalogFixture()), /effort/i);
  const unknown = mergePolicy(policyFixture(), { profiles: { fast: { model: 'not-catalogued' } } });
  assert.throws(() => validateMappings(unknown, catalogFixture()), /model/i);
});

test('an explicitly unconfigured tool reports missing bindings', () => {
  const parsed = parsePolicy(policyFixture());
  const readiness = validateMappings(parsed, catalogFixture());
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, [
    'claude.routine', 'claude.standard', 'claude.complex', 'claude.demanding', 'claude.uncertain',
  ]);
});

test('shipped defaults have valid model and effort bindings for both tools', () => {
  assert.deepEqual(validateMappings(parsePolicy(defaultPolicy), bundledCatalog), { ready: true, missing: [] });
});

test('personal overrides can cap max effort without losing the other effort mappings', () => {
  const policy = mergePolicy(defaultPolicy, { profiles: { 'codex-astra': { efforts: { max: 'high' } } } });
  assert.equal(policy.profiles['codex-astra']?.efforts.max, 'high');
  assert.equal(policy.profiles['codex-astra']?.efforts.xhigh, 'xhigh');
  assert.equal(defaultPolicy.profiles['codex-astra']?.efforts.max, 'max');
  assert.equal(validateMappings(policy, bundledCatalog).ready, true);
});

test('personal model exclusions replace the list and must name catalogued models for that tool', () => {
  const effective = mergePolicy(policyFixture(), { excludedModels: { codex: ['fixture-top'] } });
  assert.deepEqual(effective.excludedModels, { claude: [], codex: ['fixture-top'] });
  assert.equal(validateMappings(effective, catalogFixture(), 'codex').ready, true);
  assert.throws(() => mergePolicy(policyFixture(), { excludedModels: { codex: ['fixture-top', 'fixture-top'] } }), /duplicate/i);
  for (const model of ['unknown-model', 'fixture-fixed']) {
    const wrong = mergePolicy(policyFixture(), { excludedModels: { codex: [model] } });
    assert.throws(() => validateMappings(wrong, catalogFixture()), /excluded/i);
  }
});

test('routed families follow the effective routing and exclusions', () => {
  assert.deepEqual(eligibleFamilies, {
    claude: ['Haiku', 'Sonnet', 'Opus 5.5', 'Fable'],
    codex: ['GPT-6 Luna', 'GPT-6 Sol', 'GPT-6 Astra'],
  });
  const policy = mergePolicy(defaultPolicy, {
    routing: { codex: { standard: 'codex-terra' } }, excludedModels: { codex: ['gpt-6-astra'] },
  });
  assert.deepEqual(routedFamilies(policy, bundledCatalog, 'codex'), ['GPT-6 Luna', 'GPT-5.6 Terra', 'GPT-6 Sol']);
});
