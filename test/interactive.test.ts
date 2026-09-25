import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { bundledCatalog, defaultPolicy } from '../src/defaults.ts';
import { configMenu, doctorFixes } from '../src/interactive.ts';
import type { InteractiveContext } from '../src/interactive.ts';
import { PromptCancelled } from '../src/prompts.ts';
import type { Prompter } from '../src/prompts.ts';

/** Answers prompts in order and records each question for assertions. */
function scripted(answers: unknown[]) {
  const asked: string[] = [];
  const next = (message: string) => {
    asked.push(message);
    if (!answers.length) throw new Error(`Unexpected prompt: ${message}`);
    const answer = answers.shift();
    if (answer === 'CANCEL') throw new PromptCancelled();
    return answer;
  };
  const prompter: Prompter = {
    async select(message) { return next(message) as never; },
    async multiselect(message) { return next(message) as never; },
    async confirm(message) { return next(message) as boolean; },
    note() {},
  };
  return { prompter, asked, remaining: () => answers.length };
}

async function setup(t: TestContext, answers: unknown[], policy?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-interactive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (policy !== undefined) await writeFile(join(root, 'policy.json'), JSON.stringify(policy));
  const script = scripted(answers);
  const logs: string[] = [];
  const context: InteractiveContext = { root, defaults: defaultPolicy, catalog: bundledCatalog, prompter: script.prompter, log: message => logs.push(message) };
  const saved = async () => JSON.parse(await readFile(join(root, 'policy.json'), 'utf8'));
  return { root, context, script, logs, saved };
}

const allCodex = { models: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-terra'].map(slug => ({ slug })) };

test('doctor asks about Fable once when the user keeps it, and checks Codex only with consent', async t => {
  const first = await setup(t, [false, 'k']);
  let reads = 0;
  const options = { explicit: false, codexExecutable: '/bin/codex', readCodexModels: async () => { reads++; return allCodex; } };
  assert.equal(await doctorFixes(first.context, options), false);
  assert.equal(reads, 0);
  assert.match(first.script.asked[0]!, /Check the models your installed Codex offers/);
  assert.match(first.script.asked[1]!, /Fable/);
  const again = scripted([true]);
  assert.equal(await doctorFixes({ ...first.context, prompter: again.prompter }, options), false);
  assert.equal(reads, 1);
  assert.equal(again.asked.length, 1, 'the kept Fable answer is remembered');
  await assert.rejects(readFile(join(first.root, 'policy.json')), { code: 'ENOENT' });
  const explicit = scripted(['k']);
  await doctorFixes({ ...first.context, prompter: explicit.prompter }, { ...options, explicit: true });
  assert.match(explicit.asked[0]!, /Fable/, 'doctor --fix asks again');
});

test('doctor replaces Fable with Opus and excludes a model Codex lacks in one confirmed save', async t => {
  const s = await setup(t, [true, 'o', 'e', true], { history: { limit: 3 } });
  const saved = await doctorFixes(s.context, { explicit: false, codexExecutable: '/bin/codex',
    readCodexModels: async () => ({ models: [{ slug: 'gpt-6-luna' }, { slug: 'gpt-6-sol' }] }) });
  assert.equal(saved, true);
  assert.deepEqual(await s.saved(), { history: { limit: 3 }, routing: { claude: { demanding: 'claude-opus' } }, excludedModels: { codex: ['gpt-6-astra'] } });
  assert.deepEqual(JSON.parse(await readFile(join(s.root, 'policy.json.bak'), 'utf8')), { history: { limit: 3 } });
});

test('declining the save writes nothing', async t => {
  const s = await setup(t, ['o', false]);
  assert.equal(await doctorFixes(s.context, { explicit: false, codexExecutable: null, readCodexModels: async () => allCodex }), false);
  await assert.rejects(readFile(join(s.root, 'policy.json')), { code: 'ENOENT' });
});

test('the config menu changes a tier, caps effort, and skips a model in one save', async t => {
  const s = await setup(t, [
    'tiers', 'codex', 'standard', 'codex-terra',
    'effort', 'claude', 'claude-sonnet', 'high',
    'skip', 'claude', ['claude-fable-5-1'],
    'save', true,
  ]);
  assert.equal(await configMenu(s.context, async () => {}), true);
  assert.deepEqual(await s.saved(), {
    routing: { codex: { standard: 'codex-terra' } },
    profiles: { 'claude-sonnet': { efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } } },
    excludedModels: { claude: ['claude-fable-5-1'] },
  });
});

test('the config menu restores shipped values and refuses changes that break routing', async t => {
  const s = await setup(t, [
    'tiers', 'codex', 'standard', 'codex-sol-balanced',
    'effort', 'claude', 'claude-sonnet', 'none',
    'skip', 'codex', ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
    'save', true,
  ], { routing: { codex: { standard: 'codex-terra' } }, profiles: { 'claude-sonnet': { efforts: { max: 'high' } } } });
  assert.equal(await configMenu(s.context, async () => {}), true);
  assert.deepEqual(await s.saved(), {});
  assert.ok(s.logs.some(line => /Not applied: .*no eligible models/.test(line)));
});

test('quitting or cancelling the config menu writes nothing', async t => {
  const quit = await setup(t, ['agents', ['codex'], 'quit']);
  assert.equal(await configMenu(quit.context, async () => {}), false);
  await assert.rejects(readFile(join(quit.root, 'policy.json')), { code: 'ENOENT' });
  const cancelled = await setup(t, ['reset', 'CANCEL']);
  await assert.rejects(configMenu(cancelled.context, async () => {}), PromptCancelled);
  await assert.rejects(readFile(join(cancelled.root, 'policy.json')), { code: 'ENOENT' });
});
