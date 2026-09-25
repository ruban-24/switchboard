import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePolicy, validateMappings } from '../src/core/config.ts';
import { bundledCatalog, defaultPolicy } from '../src/defaults.ts';
import { nativeCodexModels, planClaudeFixes, planCodexFixes } from '../src/doctor-fix.ts';
import { selectInitialRoute } from '../src/core/policy.ts';
import type { Classification } from '../src/core/types.ts';

const current = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-terra'];

function plan(override: Record<string, unknown>, native: string[]) {
  return planCodexFixes(mergePolicy(defaultPolicy, override), override, native, defaultPolicy, bundledCatalog);
}

function choose(override: Record<string, unknown>, native: string[], keys: string[]) {
  const updated = structuredClone(override);
  plan(override, native).forEach((finding, index) => finding.options.find(option => option.key === keys[index])!.apply(updated));
  return updated;
}

test('a Codex build offering every routed model needs no policy changes', () => {
  assert.deepEqual(plan({}, current), []);
});

test('an older Codex without a shipped default offers exclusion without restoring routes', () => {
  const [finding, ...rest] = plan({}, ['gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol']);
  assert.equal(rest.length, 0);
  assert.match(finding!.message, /gpt-6-sol.*standard, complex, uncertain/);
  assert.deepEqual(finding!.options.map(option => option.key), ['e', 'k']);
  const updated = choose({}, ['gpt-6-luna', 'gpt-6-astra'], ['e']);
  assert.deepEqual(updated, { excludedModels: { codex: ['gpt-6-sol'] } });
  assert.equal(validateMappings(mergePolicy(defaultPolicy, updated), bundledCatalog, 'codex').ready, true);
});

test('a personal route to a model Codex dropped can return to the shipped route', () => {
  const override = { routing: { codex: { standard: 'codex-terra' } }, history: { limit: 3 } };
  const [finding] = plan(override, ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']);
  assert.match(finding!.message, /gpt-5\.6-terra/);
  assert.equal(finding!.fallback, 'r');
  assert.deepEqual(choose(override, ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'], ['r']), { history: { limit: 3 } });
});

test('keeping the policy unchanged is always available and writes nothing', () => {
  const override = { routing: { codex: { standard: 'codex-terra' } } };
  assert.deepEqual(choose(override, ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'], ['k']), override);
});

test('exclusion is not offered when it would leave no eligible Codex model', () => {
  const override = { excludedModels: { codex: ['gpt-6-luna', 'gpt-6-astra'] } };
  const findings = plan(override, ['gpt-6-luna', 'gpt-6-astra']);
  const missing = findings.find(finding => /does not offer gpt-6-sol/.test(finding.message))!;
  assert.deepEqual(missing.options.map(option => option.key), ['k']);
});

test('an exclusion for a model Codex now offers can be lifted but is kept by default', () => {
  const override = { excludedModels: { codex: ['gpt-6-astra'] } };
  const [finding] = plan(override, current);
  assert.equal(finding!.fallback, 'k');
  assert.deepEqual(choose(override, current, ['i']), { excludedModels: { codex: [] } });
});

test('native Codex catalog parsing ignores the Switchboard alias and rejects malformed input', () => {
  assert.deepEqual(nativeCodexModels({ models: [{ slug: 'switchboard' }, { slug: 'gpt-6-sol' }, {}] }), ['gpt-6-sol']);
  assert.throws(() => nativeCodexModels({ nope: true }), /malformed/);
});

function claude(override: Record<string, unknown>) {
  return planClaudeFixes(mergePolicy(defaultPolicy, override), override, defaultPolicy, bundledCatalog);
}

test('doctor offers Opus for the highest Claude tier when the plan cannot use Fable', () => {
  const [finding, ...rest] = claude({});
  assert.equal(rest.length, 0);
  assert.match(finding!.message, /Fable.*usage credits/);
  assert.equal(finding!.fallback, 'k');
  const updated: Record<string, unknown> = {};
  finding!.options.find(option => option.key === 'o')!.apply(updated);
  assert.deepEqual(updated, { routing: { claude: { demanding: 'claude-opus' } } });
  const demanding = { taskType: 'architecture', complexity: 'demanding', reasoning: 'max', sufficientContext: true,
    confidences: { model: .9, effort: .9, context: .9, taskType: .9 }, effortModel: 'claude-opus-5-5' } as Classification;
  assert.deepEqual(selectInitialRoute(mergePolicy(defaultPolicy, updated), bundledCatalog, 'claude', demanding),
    { profile: 'claude-opus', model: 'claude-opus-5-5', effort: 'max' });
});

test('doctor can return the highest Claude tier to Fable and skips plans that already exclude it', () => {
  const override = { routing: { claude: { demanding: 'claude-opus' } }, history: { limit: 3 } };
  const [finding] = claude(override);
  assert.equal(finding!.fallback, 'k');
  const updated = structuredClone(override) as Record<string, unknown>;
  finding!.options.find(option => option.key === 'r')!.apply(updated);
  assert.deepEqual(updated, { history: { limit: 3 } });
  assert.deepEqual(claude({ excludedModels: { claude: ['claude-fable-5-1'] } }), []);
});
