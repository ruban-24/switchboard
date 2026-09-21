import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import type { ConversationState } from '../src/core/types.ts';
import { prepareNativeLaunch, validateNativeAutomatic } from '../src/native/launcher.ts';
import { Store } from '../src/storage.ts';

async function fixture(t: test.TestContext, repository = false) {
  const root = await realpath(await mkdtemp(join(repository ? '/tmp' : tmpdir(), 'switchboard-status-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  const stateDirectory = join(root, 'state with spaces \' $(touch INJECTED)');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(cwd, '.claude'), { recursive: true });
  async function launch(args: string[] = [], env: NodeJS.ProcessEnv = {}, workingDirectory = cwd) {
    const prepared = await prepareNativeLaunch({ tool: 'claude', args, home, cwd: workingDirectory, stateDirectory, env: { PATH: process.env.PATH, ...env } });
    t.after(prepared.cleanup);
    const settings = JSON.parse(await readFile(prepared.args[1]!, 'utf8'));
    return { prepared, settings };
  }
  return { root, home, cwd, stateDirectory, launch };
}

function run(command: string, input: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: 'pipe', detached: true });
    let stdout = '';
    let stderr = '';
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const timer = setTimeout(() => { stop(); reject(new Error('Status helper exceeded test deadline')); }, 5000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 100_000) stop(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.stdin.end(input);
  });
}

const payload = JSON.stringify({ session_id: 'session-one', model: { id: 'switchboard' } });
const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');
const exec = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], {
    cwd, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, timeout: 5000,
  });
}

async function statusFile(directory: string, row: string, extra: Record<string, unknown> = {}) {
  await mkdir(join(directory, '.claude'), { recursive: true });
  await writeFile(join(directory, '.claude/settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: `printf '${row}\\n'` }, ...extra }));
}

function state(reason: ConversationState['lastDecision']['reason'] = 'initial', model = 'claude-sonnet-4-6', effort: string | null = 'high'): ConversationState {
  const selection = { profile: 'claude-standard', model, effort };
  return {
    version: 1, conversationId: 'session-one', tool: 'claude', selection, manual: reason === 'manual', history: [],
    lastDecision: { conversationId: 'session-one', turnId: 'turn-one', tool: 'claude', selection, classification: null,
      recommendation: null, reason, policyId: 'test', at: '2026-09-21T01:00:00Z' },
  };
}

test('appends a waiting row after existing ANSI output and preserves command stdin, cwd and status settings', async t => {
  const s = await fixture(t);
  const file = join(s.home, '.claude/settings.json');
  const original = JSON.stringify({ statusLine: { type: 'command', command: 'printf "\\033[32muser row\\033[0m\\n"; cat; printf "\\n%s" "$PWD"', padding: 3, refreshInterval: 2 } });
  await writeFile(file, original);
  const { prepared, settings } = await s.launch();
  assert.equal(typeof settings.statusLine?.command, 'string', 'automatic launch must install a status wrapper');
  const result = await run(settings.statusLine.command, payload, s.cwd, prepared.env);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.startsWith(`\x1b[32muser row\x1b[0m\n${payload}\n${s.cwd}\n`), JSON.stringify(result.stdout));
  assert.match(plain(result.stdout).split('\n').at(-2)!, /Switchboard.*waiting for first prompt/);
  assert.equal(settings.statusLine.padding, 3);
  assert.equal(settings.statusLine.refreshInterval, 2);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('reads selected model and effort from the explicit state directory without interpreting its shell characters', async t => {
  const s = await fixture(t);
  await new Store(s.stateDirectory).save(state());
  const { settings } = await s.launch();
  assert.equal(typeof settings.statusLine?.command, 'string');
  const result = await run(settings.statusLine.command, payload, s.cwd);
  assert.match(plain(result.stdout), /Switchboard.*claude-sonnet-4-6.*high.*auto/);
  await assert.rejects(readFile(join(s.cwd, 'INJECTED')), { code: 'ENOENT' });
});

for (const [reason, label] of [['pinned', 'pinned'], ['classifier-unavailable', 'fallback'], ['uncertain', 'fallback'], ['manual', 'manual']] as const) {
  test(`renders ${reason} route state`, async t => {
    const s = await fixture(t);
    await new Store(s.stateDirectory).save(state(reason));
    const { settings } = await s.launch();
    assert.equal(typeof settings.statusLine?.command, 'string');
    const result = await run(settings.statusLine.command, payload, s.cwd);
    assert.match(plain(result.stdout), new RegExp(`claude-sonnet-4-6.*high.*${label}`));
  });
}

test('live native model and effort take precedence over a stale saved automatic route', async t => {
  const s = await fixture(t);
  await new Store(s.stateDirectory).save(state('pinned'));
  const { settings } = await s.launch();
  assert.equal(typeof settings.statusLine?.command, 'string');
  const result = await run(settings.statusLine.command, JSON.stringify({ session_id: 'session-one', model: { id: 'claude-opus-4-6' }, effort: { level: 'max' } }), s.cwd);
  assert.match(plain(result.stdout), /Switchboard.*claude-opus-4-6.*max.*manual/);
  assert.doesNotMatch(result.stdout, /sonnet|pinned|high/);
});

test('shows no effort for a stored route without an effort parameter', async t => {
  const s = await fixture(t);
  await new Store(s.stateDirectory).save(state('pinned', 'claude-haiku-4-5', null));
  const { settings } = await s.launch();
  const result = await run(settings.statusLine.command, payload, s.cwd);
  assert.match(plain(result.stdout), /claude-haiku-4-5.*no effort.*pinned/);
  assert.doesNotMatch(result.stdout, /default effort/);
});

test('sanitizes stored labels while preserving the user command ANSI and hiding state prompts', async t => {
  const s = await fixture(t);
  const saved = state('initial', 'claude-\u202esonnet\u0085second', 'high');
  saved.lastDecision.prompt = 'PRIVATE_PROMPT';
  await new Store(s.stateDirectory).save(saved);
  const { settings } = await s.launch(['--settings', JSON.stringify({ statusLine: { type: 'command', command: 'printf "\\033[35muser\\033[0m\\n"' } })]);
  assert.equal(typeof settings.statusLine?.command, 'string');
  const result = await run(settings.statusLine.command, payload, s.cwd);
  assert.ok(result.stdout.startsWith('\x1b[35muser\x1b[0m\n'));
  assert.equal(result.stdout.trimEnd().split('\n').length, 2);
  assert.doesNotMatch(result.stdout, /\u202e|\u0085|PRIVATE_PROMPT/);
});

test('malformed input and corrupt state fail quietly while keeping the existing line', async t => {
  const s = await fixture(t);
  const { settings } = await s.launch(['--settings', JSON.stringify({ statusLine: { type: 'command', command: 'printf "user\\n"' } })]);
  assert.equal(typeof settings.statusLine?.command, 'string');
  const key = createHash('sha256').update('claude:session-one').digest('hex');
  await mkdir(join(s.stateDirectory, 'sessions'), { recursive: true });
  await writeFile(join(s.stateDirectory, 'sessions', `${key}.json`), 'PRIVATE_CORRUPT_STATE');
  for (const input of ['{PRIVATE_BAD_JSON', JSON.stringify({ session_id: '../../PRIVATE_PATH' }), payload]) {
    const result = await run(settings.statusLine.command, input, s.cwd);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.startsWith('user\n'));
    assert.match(result.stdout, /Switchboard/);
    assert.doesNotMatch(result.stdout, /PRIVATE/);
  }
});

test('bounds a hanging existing command and still appends routing status', async t => {
  const s = await fixture(t);
  const { settings } = await s.launch(['--settings', JSON.stringify({ statusLine: { type: 'command', command: 'printf "user\\n"; sleep 30' } })]);
  assert.equal(typeof settings.statusLine?.command, 'string');
  const started = Date.now();
  const result = await run(settings.statusLine.command, payload, s.cwd);
  assert.ok(Date.now() - started < 3500);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.startsWith('user\n'));
  assert.match(result.stdout, /Switchboard/);
});

test('caps noisy existing output and suppresses command errors', async t => {
  const s = await fixture(t);
  const { settings } = await s.launch(['--settings', JSON.stringify({ statusLine: { type: 'command', command: 'printf PRIVATE_ERROR >&2; yes output' } })]);
  assert.equal(typeof settings.statusLine?.command, 'string');
  const result = await run(settings.statusLine.command, payload, s.cwd);
  assert.ok(result.stdout.length < 70_000);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Switchboard/);
  assert.doesNotMatch(result.stdout, /PRIVATE_ERROR/);
});

test('resolves status settings by enabled source precedence, including relative explicit settings', async t => {
  const s = await fixture(t);
  for (const [file, label] of [[join(s.home, '.claude/settings.json'), 'user'], [join(s.cwd, '.claude/settings.json'), 'project'], [join(s.cwd, '.claude/settings.local.json'), 'local'], [join(s.cwd, 'explicit.json'), 'explicit']]) {
    await writeFile(file!, JSON.stringify({ statusLine: { type: 'command', command: `printf '${label}\\n'` } }));
  }
  for (const [args, expected] of [[[], 'local'], [['--setting-sources=user,project'], 'project'], [['--setting-sources', 'user'], 'user'], [['--setting-sources=', '--settings', 'explicit.json'], 'explicit']] as const) {
    const { settings } = await s.launch([...args]);
    assert.equal(typeof settings.statusLine?.command, 'string');
    const result = await run(settings.statusLine.command, payload, s.cwd);
    assert.ok(result.stdout.startsWith(`${expected}\n`), result.stdout);
    assert.match(result.stdout, /Switchboard/);
  }
});

test('disabled sources are not read by preflight or used for the status command', async t => {
  const s = await fixture(t);
  await writeFile(join(s.home, '.claude/settings.json'), '{PRIVATE_MALFORMED');
  await writeFile(join(s.cwd, '.claude/settings.local.json'), JSON.stringify({ disableAllHooks: true, statusLine: { type: 'command', command: 'echo PRIVATE_DISABLED' } }));
  await validateNativeAutomatic('claude', ['--setting-sources=project'], s.home, {}, s.cwd);
  const { settings } = await s.launch(['--setting-sources=project']);
  const result = await run(settings.statusLine.command, payload, s.cwd);
  assert.match(result.stdout, /Switchboard/);
  assert.doesNotMatch(result.stdout, /PRIVATE/);
});

test('nested repository launch merges root local over legacy cwd local while shared project settings stay at cwd', async t => {
  const s = await fixture(t, true);
  await git(s.cwd, ['init']);
  const nested = join(s.cwd, 'packages', 'app');
  await statusFile(nested, 'LEGACY_ROW');
  await statusFile(s.cwd, 'ROOT_ROW');
  // A shared root setting does not apply when Claude starts in this subfolder.
  await writeFile(join(s.cwd, '.claude/settings.json'), '{"disableAllHooks":true}');
  await writeFile(join(nested, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'printf PROJECT_ROW' } }));
  const { settings } = await s.launch([], {}, nested);
  const result = await run(settings.statusLine.command, payload, nested);
  assert.ok(result.stdout.startsWith('ROOT_ROW\n'), result.stdout);
  assert.doesNotMatch(result.stdout, /LEGACY_ROW|PROJECT_ROW/);
  const projectOnly = await s.launch(['--setting-sources=project'], {}, nested);
  const projectOutput = await run(projectOnly.settings.statusLine.command, payload, nested);
  assert.ok(projectOutput.stdout.startsWith('PROJECT_ROW\n'), projectOutput.stdout);
});

test('nested repository preflight rejects a root-local hook restriction and honors local source exclusion', async t => {
  const s = await fixture(t, true);
  await git(s.cwd, ['init']);
  const nested = join(s.cwd, 'packages', 'app');
  await statusFile(nested, 'LEGACY_ROW');
  await statusFile(s.cwd, 'ROOT_ROW', { disableAllHooks: true });
  await assert.rejects(validateNativeAutomatic('claude', [], s.home, {}, nested), /requires Claude hooks/);
  await assert.rejects(s.launch([], {}, nested), /requires Claude hooks/);
  await validateNativeAutomatic('claude', ['--setting-sources=user,project'], s.home, { PATH: '/nonexistent' }, nested);
  const { settings } = await s.launch(['--setting-sources=user,project'], { PATH: '/nonexistent' }, nested);
  const result = await run(settings.statusLine.command, payload, nested);
  assert.match(result.stdout, /Switchboard/);
  assert.doesNotMatch(result.stdout, /ROOT_ROW|LEGACY_ROW/);
});

test('linked worktree launch uses main-checkout local settings above legacy cwd local settings', async t => {
  const s = await fixture(t, true);
  await git(s.cwd, ['init']);
  const linked = join(s.root, 'linked checkout');
  // Git 2.39 cannot add an orphan worktree. Register an unborn fixture using
  // Git's on-disk worktree format, without creating a commit or mocking Git.
  const registration = join(s.cwd, '.git', 'worktrees', 'linked');
  await mkdir(registration, { recursive: true });
  await mkdir(linked);
  await writeFile(join(registration, 'HEAD'), 'ref: refs/heads/linked\n');
  await writeFile(join(registration, 'commondir'), '../..\n');
  await writeFile(join(registration, 'gitdir'), `${join(linked, '.git')}\n`);
  await writeFile(join(linked, '.git'), `gitdir: ${registration}\n`);
  t.after(() => git(s.cwd, ['worktree', 'remove', '--force', linked]).catch(() => {}));
  const listed = (await git(linked, ['worktree', 'list', '--porcelain', '-z'])).stdout;
  assert.ok(listed.startsWith(`worktree ${s.cwd}\0`));
  assert.ok(listed.includes(`worktree ${linked}\0`));
  const nested = join(linked, 'packages', 'app');
  await statusFile(nested, 'LEGACY_WORKTREE_ROW');
  await statusFile(linked, 'LINKED_ROOT_ROW');
  await statusFile(s.cwd, 'MAIN_ROOT_ROW');
  const { settings } = await s.launch([], {}, nested);
  const result = await run(settings.statusLine.command, payload, nested);
  assert.ok(result.stdout.startsWith('MAIN_ROOT_ROW\n'), result.stdout);
  assert.doesNotMatch(result.stdout, /LEGACY_WORKTREE_ROW|LINKED_ROOT_ROW/);
  await statusFile(s.cwd, 'MAIN_ROOT_ROW', { disableAllHooks: true });
  await assert.rejects(validateNativeAutomatic('claude', [], s.home, {}, nested), /requires Claude hooks/);
  await assert.rejects(s.launch([], {}, nested), /requires Claude hooks/);
});

test('a repository rooted at home keeps local settings in the starting directory', async t => {
  const s = await fixture(t, true);
  await git(s.home, ['init']);
  const nested = join(s.home, 'project');
  await statusFile(nested, 'CWD_ROW');
  await statusFile(s.home, 'HOME_ROOT_ROW', { disableAllHooks: true });
  const { settings } = await s.launch([], {}, nested);
  const result = await run(settings.statusLine.command, payload, nested);
  assert.ok(result.stdout.startsWith('CWD_ROW\n'), result.stdout);
  assert.doesNotMatch(result.stdout, /HOME_ROOT_ROW/);
});

test('bounds failed Git discovery instead of silently ignoring repository-local restrictions', async t => {
  const s = await fixture(t, true);
  await git(s.cwd, ['init']);
  const bin = join(s.root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 });
  const started = Date.now();
  await assert.rejects(validateNativeAutomatic('claude', [], s.home, { PATH: bin }, s.cwd), error => {
    assert.match(String(error), /Cannot resolve Claude repository-local settings.*automatic routing did not start/);
    assert.doesNotMatch(String(error), /SIGTERM|sleep|spawn|switchboard-status-/);
    return true;
  });
  assert.ok(Date.now() - started < 3000);
  const prepared = await prepareNativeLaunch({ tool: 'claude', args: ['--model', 'sonnet'], home: s.home, cwd: s.cwd, env: { PATH: bin } });
  t.after(prepared.cleanup);
  assert.equal(prepared.mode, 'bypass');
});

test('preflight strips classifier credentials before Git discovers repository-local settings', async t => {
  const s = await fixture(t, true);
  await git(s.cwd, ['init']);
  const bin = join(s.root, 'bin');
  const captured = join(s.root, 'git-environment');
  await mkdir(bin);
  const keys = ['OPENROUTER_API_KEY', 'SWITCHBOARD_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY'];
  const script = `#!/bin/sh\nprintf '%s|%s|%s|%s|%s' ${keys.map(key => `"$${key}"`).join(' ')} > "$CAPTURE_ENV"\nprintf 'worktree %s\\0\\0' "$MAIN_WORKTREE"\n`;
  await writeFile(join(bin, 'git'), script, { mode: 0o700 });
  await validateNativeAutomatic('claude', [], s.home, {
    PATH: bin, CAPTURE_ENV: captured, MAIN_WORKTREE: s.cwd,
    ...Object.fromEntries(keys.map(key => [key, 'dummy-classifier-key'])),
  }, s.cwd);
  assert.equal(await readFile(captured, 'utf8'), '||||');
});

test('status opt-out leaves the existing status configuration intact', async t => {
  const s = await fixture(t);
  const statusLine = { type: 'command', command: 'printf user', padding: 2 };
  const { settings } = await s.launch(['--settings', JSON.stringify({ statusLine })], { SWITCHBOARD_STATUSLINE: 'off' });
  assert.deepEqual(settings.statusLine, statusLine);
});

test('quotes installed helper paths with spaces, apostrophes and shell substitutions', async t => {
  const s = await fixture(t);
  const installation = join(s.root, 'install \' $(touch INJECTED)');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  await cp(join(repository, 'src'), join(installation, 'src'), { recursive: true });
  await symlink(join(repository, 'node_modules'), join(installation, 'node_modules'), 'dir');
  await writeFile(join(installation, 'package.json'), '{"type":"module"}');
  const installed = await import(pathToFileURL(join(installation, 'src/native/launcher.ts')).href);
  const prepared = await installed.prepareNativeLaunch({ tool: 'claude', args: [], home: s.home, cwd: s.cwd, stateDirectory: s.stateDirectory, env: {} });
  t.after(prepared.cleanup);
  const settings = JSON.parse(await readFile(prepared.args[1], 'utf8'));
  const result = await run(settings.statusLine.command, payload, s.cwd);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Switchboard.*waiting/);
  await assert.rejects(readFile(join(s.cwd, 'INJECTED')), { code: 'ENOENT' });
});

test('strips classifier credentials from the existing status subprocess environment', async t => {
  const s = await fixture(t);
  const keys = ['OPENROUTER_API_KEY', 'SWITCHBOARD_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY'];
  const command = `printf '%s|%s|%s|%s|%s' ${keys.map(key => `"$${key}"`).join(' ')}`;
  const { settings } = await s.launch(['--settings', JSON.stringify({ statusLine: { type: 'command', command } })]);
  const result = await run(settings.statusLine.command, payload, s.cwd, Object.fromEntries(keys.map(key => [key, 'PRIVATE_CLASSIFIER_KEY'])));
  assert.ok(result.stdout.startsWith('||||\n'));
  assert.doesNotMatch(result.stdout, /PRIVATE_CLASSIFIER_KEY/);
});

test('sanitizes native model and effort labels before displaying a manual selection', async t => {
  const s = await fixture(t);
  const { settings } = await s.launch();
  const input = JSON.stringify({ model: { id: 'claude-opus\x1b]0;owned\x07\nsecond' }, effort: { level: 'max\x1b[2J\r\u202e' } });
  const result = await run(settings.statusLine.command, input, s.cwd);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  assert.match(plain(result.stdout), /Switchboard.*claude-opussecond.*max effort.*manual/);
  assert.doesNotMatch(result.stdout, /\x1b\]|\x07|\x1b\[2J|\r|\u202e|owned/);
});
