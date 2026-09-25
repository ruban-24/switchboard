import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { rm } from 'node:fs/promises';
import { Store } from '../src/storage.ts';
import { Router } from '../src/core/session.ts';
import { catalogFixture, policyFixture } from './fixtures.ts';

const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

async function sandbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'router-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const config = join(home, '.config', 'switchboard');
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), '{"unrelated":true}\n');
  await writeFile(join(home, '.codex', 'config.toml'), 'model = "personal-model"\n');
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: bin, SWITCHBOARD_HOME: config, JEV_API_KEY: 'secret-do-not-print' };
  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    return result;
  }
  return { root, home, config, bin, env, cli };
}

test('init with defaults creates only personal configuration and never prints credentials', async t => {
  const s = await sandbox(t);
  const result = s.cli('init', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Fable/);
  assert.match(result.stdout, /Astra/);
  assert.match(result.stdout, /xhigh.*max/);
  assert.doesNotMatch(result.stdout, /mappings are pending/i);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-do-not-print/);
  assert.deepEqual(JSON.parse(await readFile(join(s.config, 'policy.json'), 'utf8')), {});
  const check = s.cli('config', 'check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(await readFile(join(s.home, '.claude', 'settings.json'), 'utf8'), '{"unrelated":true}\n');
  assert.equal(await readFile(join(s.home, '.codex', 'config.toml'), 'utf8'), 'model = "personal-model"\n');
});

test('repeated init preserves personal overrides byte for byte', async t => {
  const s = await sandbox(t);
  s.cli('init', '--yes');
  const personal = '{ "history": { "limit": 3 }, "enabledTools": ["codex"] }\n';
  await writeFile(join(s.config, 'policy.json'), personal);
  const result = s.cli('init', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already initialized/i);
  assert.equal(await readFile(join(s.config, 'policy.json'), 'utf8'), personal);
  const shown = s.cli('config', 'show');
  assert.equal(shown.status, 0, shown.stderr);
  const effective = JSON.parse(shown.stdout);
  assert.deepEqual(effective.enabledTools, ['codex']);
  assert.equal(effective.history.limit, 3);
  assert.equal(effective.history.capturePrompts, false);
});

test('redirected init requires an explicit noninteractive choice without writing or hanging', async t => {
  const s = await sandbox(t);
  const result = s.cli('init');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--yes/);
  await assert.rejects(readFile(join(s.config, 'policy.json')), { code: 'ENOENT' });
});

test('invalid personal config fails validation and init never replaces it', async t => {
  const s = await sandbox(t);
  await mkdir(s.config, { recursive: true });
  const invalid = '{"classifier":{"timeotMs":1}}\n';
  await writeFile(join(s.config, 'policy.json'), invalid);
  for (const args of [['config', 'check'], ['config', 'show'], ['init', '--yes']]) {
    const result = s.cli(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown field/i);
  }
  assert.equal(await readFile(join(s.config, 'policy.json'), 'utf8'), invalid);
  await writeFile(join(s.config, 'policy.json'), '{not json; secret-do-not-print}');
  const result = s.cli('config', 'check');
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /secret-do-not-print/);
});

test('doctor detects executables without running them and reports launcher readiness', async t => {
  const s = await sandbox(t);
  await writeFile(join(s.bin, 'codex'), '#!/bin/sh\necho MUST-NOT-EXECUTE\n', { mode: 0o755 });
  const result = s.cli('doctor');
  assert.equal(result.status, 2);
  assert.match(result.stdout, /codex: found/i);
  assert.match(result.stdout, /claude: not found/i);
  assert.match(result.stdout, /effort.*fixed/i);
  assert.match(result.stdout, /native adapters: available/i);
  assert.doesNotMatch(result.stdout + result.stderr, /MUST-NOT-EXECUTE|secret-do-not-print/);
  assert.deepEqual(await readdir(join(s.home, '.codex')), ['config.toml']);
});

test('init and doctor report only the selected classifier provider and credential presence', async t => {
  const s = await sandbox(t);
  s.env.SWITCHBOARD_PROVIDER = 'vercel';
  s.env.AI_GATEWAY_API_KEY = 'gateway-secret-do-not-print';
  for (const tool of ['claude', 'codex']) {
    await writeFile(join(s.bin, tool), '#!/bin/sh\necho MUST-NOT-EXECUTE\n', { mode: 0o755 });
  }
  for (const args of [['init', '--yes'], ['doctor']]) {
    const result = s.cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Vercel AI Gateway.*typesafe-ai\/jev/);
    assert.match(result.stdout, /Jev credential: present.*not tested/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-do-not-print|MUST-NOT-EXECUTE/);
  }
  assert.doesNotMatch(s.cli('config', 'show').stdout, /secret-do-not-print|API_KEY/);
  delete s.env.AI_GATEWAY_API_KEY;
  const missing = s.cli('doctor');
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /Jev credential: missing.*AI_GATEWAY_API_KEY/);
});

test('missing native executables fail explicitly and help remains accessible', async t => {
  const s = await sandbox(t);
  for (const tool of ['claude', 'codex']) {
    const result = s.cli(tool, '--help');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not installed or executable/i);
  }
  const help = s.cli('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /explain <claude\|codex> <conversation-id>/);
  assert.equal(s.cli('unknown-command').status, 2);
});

test('native help bypass preserves arguments, exit status, and removes Jev credentials', async t => {
  const s = await sandbox(t);
  s.env.SWITCHBOARD_PROVIDER = 'invalid-provider-must-not-block-bypass';
  s.env.AI_GATEWAY_API_KEY = 'gateway-secret-do-not-print';
  await writeFile(join(s.bin, 'claude'), '#!/bin/sh\nprintf "%s|%s|%s" "$1" "${JEV_API_KEY-unset}" "${AI_GATEWAY_API_KEY-unset}"\nexit 7\n', { mode: 0o755 });
  const result = s.cli('claude', '--help');
  assert.equal(result.status, 7);
  assert.equal(result.stdout, '--help|unset|unset');
  assert.doesNotMatch(result.stdout + result.stderr, /secret-do-not-print/);
});

test('explain reads durable metadata without invoking a model or revealing captured prompts', async t => {
  const s = await sandbox(t);
  const policy = policyFixture();
  policy.history.capturePrompts = true;
  const store = new Store(s.config, { capturePrompts: true });
  const router = new Router({ policy, catalog: catalogFixture(), repository: store,
    classify: async () => ({ taskType: 'debug', complexity: 'complex', reasoning: 'high', sufficientContext: true, confidences: { model: 0.9, effort: 0.9, context: 0.9, taskType: 0.9 } }),
  });
  await router.routeTurn({ tool: 'codex', conversationId: 'native-session', turnId: 'first', kind: 'user', task: 'private-code-do-not-print' });
  const result = s.cli('explain', 'codex', 'native-session');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture-strong/);
  assert.match(result.stdout, /high/);
  assert.match(result.stdout, /complex/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-code-do-not-print|secret-do-not-print/);
  const absent = s.cli('explain', 'codex', 'unknown');
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /no saved/i);
});

test('explain preserves the reason a personal exclusion changed the initial model', async t => {
  const s = await sandbox(t);
  const policy = policyFixture();
  policy.excludedModels.codex = ['fixture-top'];
  const router = new Router({ policy, catalog: catalogFixture(), repository: new Store(s.config),
    classify: async () => ({ taskType: 'architecture', complexity: 'demanding', reasoning: 'high', sufficientContext: true, confidences: { model: 0.9, effort: 0.9, context: 0.9, taskType: 0.9 } }),
  });
  await router.routeTurn({ tool: 'codex', conversationId: 'excluded-session', turnId: 'first', kind: 'user', task: 'Design the migration' });
  const result = s.cli('explain', 'codex', 'excluded-session');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved automatic model: fixture-strong/);
  assert.match(result.stdout, /excluded.*fixture-top/i);
});

test('doctor succeeds with only the enabled coding agent installed and a saved credential', async t => {
  const s = await sandbox(t);
  delete s.env.JEV_API_KEY;
  s.cli('init', '--yes');
  await writeFile(join(s.config, 'policy.json'), '{"enabledTools":["codex"]}\n');
  await writeFile(join(s.config, 'connection.json'), JSON.stringify({ version: 1, provider: 'typesafe', apiKey: 'saved-private-key' }), { mode: 0o600 });
  await writeFile(join(s.bin, 'codex'), '#!/bin/sh\necho MUST-NOT-EXECUTE\n', { mode: 0o755 });
  const result = s.cli('doctor');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /claude: not found.*disabled/);
  assert.match(result.stdout, /credential: present/);
  assert.doesNotMatch(result.stdout + result.stderr, /saved-private-key|MUST-NOT-EXECUTE/);
});

test('noninteractive setup never saves an environment key or modifies shell profiles', async t => {
  const s = await sandbox(t);
  const profile = join(s.home, '.zshrc');
  await writeFile(profile, '# private preferences\n');
  s.env.SHELL = '/bin/zsh';
  assert.equal(s.cli('init', '--yes').status, 0);
  await assert.rejects(readFile(join(s.config, 'connection.json')), { code: 'ENOENT' });
  assert.equal(await readFile(profile, 'utf8'), '# private preferences\n');
});

test('doctor --fix requires a terminal and never writes policy when redirected', async t => {
  const s = await sandbox(t);
  const result = s.cli('doctor', '--fix');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /interactive/);
  await assert.rejects(readFile(join(s.config, 'policy.json')), { code: 'ENOENT' });
});

test('doctor lists the effective lineup and points to the interactive checks', async t => {
  const s = await sandbox(t);
  await mkdir(s.config, { recursive: true });
  await writeFile(join(s.config, 'policy.json'), '{"routing":{"codex":{"standard":"codex-terra"}}}\n');
  const result = s.cli('doctor');
  assert.match(result.stdout, /Automatic codex lineup: GPT-6 Luna → GPT-5\.6 Terra → GPT-6 Sol → GPT-6 Astra/);
  assert.match(result.stdout, /Automatic claude lineup: Haiku → Sonnet → Opus 5\.5 → Fable/);
  assert.match(result.stdout, /Run switchboard doctor in a terminal/);
});

test('codex launch explains how to recover when the installed Codex lacks a routed model', async t => {
  const s = await sandbox(t);
  const catalog = JSON.stringify({ models: ['gpt-6-luna', 'gpt-6-astra'].map(slug => ({ slug })) });
  await writeFile(join(s.bin, 'codex'), `#!/bin/sh\nif [ "$1" = debug ]; then echo '${catalog}'; exit 0; fi\necho MUST-NOT-LAUNCH\n`, { mode: 0o755 });
  const result = s.cli('codex');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /gpt-6-sol.*missing.*Run switchboard doctor to review/);
  assert.doesNotMatch(result.stdout + result.stderr, /MUST-NOT-LAUNCH|secret-do-not-print/);
});

test('config set, get, and unset edit personal policy without opening JSON', async t => {
  const s = await sandbox(t);
  const set = s.cli('config', 'set', 'routing.codex.standard', 'codex-terra');
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /routing\.codex\.standard: "codex-sol-balanced" → "codex-terra"/);
  assert.deepEqual(JSON.parse(await readFile(join(s.config, 'policy.json'), 'utf8')), { routing: { codex: { standard: 'codex-terra' } } });
  assert.equal(s.cli('config', 'get', 'routing.codex.standard').stdout.trim(), 'codex-terra');
  const number = s.cli('config', 'set', 'classifier.modelMinConfidence', '0.8');
  assert.equal(number.status, 0, number.stderr);
  assert.match(number.stdout, /backed up/);
  assert.equal(s.cli('config', 'get', 'classifier.modelMinConfidence').stdout.trim(), '0.8');
  assert.equal(s.cli('config', 'unset', 'routing.codex.standard').status, 0);
  assert.equal(s.cli('config', 'unset', 'classifier.modelMinConfidence').status, 0);
  assert.deepEqual(JSON.parse(await readFile(join(s.config, 'policy.json'), 'utf8')), {});
  assert.match(s.cli('config', 'unset', 'history.limit').stdout, /shipped default already applies/);
});

test('config set rejects invalid settings and leaves the policy untouched', async t => {
  const s = await sandbox(t);
  await mkdir(s.config, { recursive: true });
  const personal = '{ "history": { "limit": 3 } }\n';
  await writeFile(join(s.config, 'policy.json'), personal);
  for (const args of [
    ['routing.codex.standard', 'no-such-profile'], ['classifier.timeotMs', '5'], ['classifier.modelMinConfidence', '7'],
    ['excludedModels.codex', '["gpt-6-luna","gpt-6-sol","gpt-6-astra"]'], ['__proto__.polluted', '1'],
  ]) {
    const result = s.cli('config', 'set', ...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /switchboard:/);
  }
  assert.equal(await readFile(join(s.config, 'policy.json'), 'utf8'), personal);
  await assert.rejects(readFile(join(s.config, 'policy.json.bak')), { code: 'ENOENT' });
  assert.equal(s.cli('config', 'get', 'nope.nothing').status, 2);
});

test('the interactive config menu requires a terminal', async t => {
  const s = await sandbox(t);
  const result = s.cli('config');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /interactive menu/);
});
