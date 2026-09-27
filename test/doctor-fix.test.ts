import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePolicy, validateMappings } from '../src/core/config.ts';
import { bundledCatalog, defaultPolicy } from '../src/defaults.ts';
import { claudeCodeVersion, nativeCodexModels, planClaudeFixes, planClaudeVersionFixes, planCodexFixes, resolveFindings } from '../src/doctor-fix.ts';
import type { FixFinding, FixPlanner } from '../src/doctor-fix.ts';
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

test('an older Codex without a shipped default offers the previous generation first', () => {
  const [finding, ...rest] = plan({}, ['gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol']);
  assert.equal(rest.length, 0);
  assert.match(finding!.message, /gpt-6-sol.*standard, complex, uncertain/);
  assert.deepEqual(finding!.options.map(option => option.key), ['p', 'k', 'e']);
  assert.equal(finding!.fallback, 'p');
  const updated = choose({}, ['gpt-6-luna', 'gpt-6-astra'], ['e']);
  assert.deepEqual(updated, { excludedModels: { codex: ['gpt-6-sol'] } });
  assert.equal(validateMappings(mergePolicy(defaultPolicy, updated), bundledCatalog, 'codex').ready, true);
});

const codex155 = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'];
const confident = (complexity: Classification['complexity']) => ({ taskType: null, complexity, reasoning: null,
  sufficientContext: true, confidences: { model: 1, effort: null, context: 1, taskType: null } }) as Classification;

test('a Codex without GPT-6 Luna and Sol keeps routine work off Astra by default', () => {
  const findings = plan({}, codex155);
  assert.deepEqual(findings.map(finding => finding.fallback), ['p', 'p']);
  const exclude = findings[0]!.options.find(option => option.key === 'e')!;
  assert.match(exclude.label, /routine would use GPT-6 Sol instead/);
  const updated = choose({}, codex155, ['p', 'p']);
  assert.deepEqual(updated, { profiles: {
    'codex-luna': { model: 'gpt-5.6-luna' }, 'codex-sol-balanced': { model: 'gpt-5.6-sol' }, 'codex-sol': { model: 'gpt-5.6-sol' },
  } });
  const policy = mergePolicy(defaultPolicy, updated);
  assert.equal(selectInitialRoute(policy, bundledCatalog, 'codex', confident('routine')).model, 'gpt-5.6-luna');
  assert.equal(selectInitialRoute(policy, bundledCatalog, 'codex', confident('standard')).model, 'gpt-5.6-sol');
  assert.deepEqual(plan(updated, codex155), []);
});

test('excluding every missing GPT-6 model is labeled as moving those tiers to Astra', () => {
  const [sol, ...rest] = plan({ excludedModels: { codex: ['gpt-6-luna'] } }, codex155);
  assert.equal(rest.length, 0);
  assert.match(sol!.options.find(option => option.key === 'e')!.label, /would use GPT-6 Astra instead/);
});

test('after a Codex update the previous generation can be replaced but is kept by default', () => {
  const override = { profiles: { 'codex-luna': { model: 'gpt-5.6-luna' }, 'codex-sol': { model: 'gpt-5.6-sol', defaultReasoning: 'xhigh' } } };
  const both = [...current, 'gpt-5.6-luna', 'gpt-5.6-sol'];
  const findings = plan(override, both);
  assert.equal(findings.length, 2);
  assert.ok(findings.every(finding => finding.fallback === 'k'));
  assert.deepEqual(choose(override, both, ['u', 'u']), { profiles: { 'codex-sol': { defaultReasoning: 'xhigh' } } });
});

test('a Codex that dropped the previous generation defaults to the current model again', () => {
  const override = { profiles: { 'codex-luna': { model: 'gpt-5.6-luna' } } };
  const [finding, ...rest] = plan(override, current);
  assert.equal(rest.length, 0);
  assert.match(finding!.message, /no longer offers GPT-5\.6 Luna/);
  assert.equal(finding!.fallback, 'u');
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

function claudeVersion(override: Record<string, unknown>, version: string) {
  return planClaudeVersionFixes(mergePolicy(defaultPolicy, override), override, version, defaultPolicy, bundledCatalog);
}

test('Claude Code version output is parsed', () => {
  assert.equal(claudeCodeVersion('2.1.283 (Claude Code)\n'), '2.1.283');
  assert.equal(claudeCodeVersion('unknown'), null);
});

test('a Claude Code too old for Opus 5.5 routes its tiers to Opus 5 by default', () => {
  const [finding, ...rest] = claudeVersion({}, '2.1.278');
  assert.equal(rest.length, 0);
  assert.match(finding!.message, /2\.1\.278 cannot use Opus 5\.5.*complex, uncertain.*2\.1\.280/);
  assert.equal(finding!.fallback, 'p');
  const updated: Record<string, unknown> = {};
  finding!.options.find(option => option.key === 'p')!.apply(updated);
  assert.deepEqual(updated, { profiles: { 'claude-opus': { model: 'claude-opus-5' } } });
  const policy = mergePolicy(defaultPolicy, updated);
  assert.equal(selectInitialRoute(policy, bundledCatalog, 'claude', null).model, 'claude-opus-5');
  assert.match(claude(updated)[0]!.options.find(option => option.key === 'o')!.label, /Opus 5 for the highest tier/);
  assert.deepEqual(claudeVersion({}, '2.1.280'), []);
  assert.deepEqual(claudeVersion({}, '2.2.0'), []);
});

test('an updated Claude Code offers Opus 5.5 again and keeps Opus 5 by default', () => {
  const override = { profiles: { 'claude-opus': { model: 'claude-opus-5' } } };
  assert.deepEqual(claudeVersion(override, '2.1.279'), []);
  const [finding] = claudeVersion(override, '2.1.283');
  assert.equal(finding!.fallback, 'k');
  const updated = structuredClone(override) as Record<string, unknown>;
  finding!.options.find(option => option.key === 'u')!.apply(updated);
  assert.deepEqual(updated, {});
});

async function walk(planners: FixPlanner[], answers: string[]) {
  const seen: FixFinding[] = [];
  const result = await resolveFindings(planners, {}, defaultPolicy, async finding => { seen.push(finding); return answers[seen.length - 1]!; });
  return { ...result, seen };
}

test('later doctor questions describe the policy after earlier answers', async () => {
  const codex: FixPlanner = (policy, override) => planCodexFixes(policy, override, codex155, defaultPolicy, bundledCatalog);
  const { seen, updated } = await walk([codex], ['e', 'e']);
  assert.match(seen[0]!.options.find(option => option.key === 'e')!.label, /routine would use GPT-6 Sol/);
  assert.match(seen[1]!.options.find(option => option.key === 'e')!.label, /would use GPT-6 Astra/);
  assert.deepEqual(updated, { excludedModels: { codex: ['gpt-6-luna', 'gpt-6-sol'] } });

  const claudePlanners: FixPlanner[] = [
    (policy, override) => planClaudeVersionFixes(policy, override, '2.1.278', defaultPolicy, bundledCatalog),
    (policy, override) => planClaudeFixes(policy, override, defaultPolicy, bundledCatalog),
  ];
  const claudeWalk = await walk(claudePlanners, ['p', 'o']);
  assert.match(claudeWalk.seen[1]!.options.find(option => option.key === 'o')!.label, /Use Opus 5 for the highest tier/);
  assert.deepEqual(claudeWalk.updated, { profiles: { 'claude-opus': { model: 'claude-opus-5' } }, routing: { claude: { demanding: 'claude-opus' } } });
  assert.equal((await walk([], [])).asked, 0);
});
