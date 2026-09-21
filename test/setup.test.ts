import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectionEnvironment, saveConnection, stateDirectory } from '../src/settings.ts';
import { installProfileBlock, recommendedProfiles } from '../src/setup.ts';

async function sandbox(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'switchboard setup '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('settings respect explicit and absolute XDG directories', () => {
  assert.equal(stateDirectory({ XDG_CONFIG_HOME: '/tmp/custom' }, '/home/person'), '/tmp/custom/switchboard');
  assert.equal(stateDirectory({ XDG_CONFIG_HOME: 'relative' }, '/home/person'), '/home/person/.config/switchboard');
  assert.equal(stateDirectory({ SWITCHBOARD_HOME: '/tmp/explicit', XDG_CONFIG_HOME: '/tmp/custom' }, '/home/person'), '/tmp/explicit');
});

test('saved connection is private and works without shell exports', async t => {
  const root = await sandbox(t);
  await saveConnection(root, { version: 1, provider: 'openrouter', apiKey: 'private-key', model: 'jev-latest' });
  assert.equal((await stat(join(root, 'connection.json'))).mode & 0o777, 0o600);
  const env = await connectionEnvironment(root, { PATH: '/bin' });
  assert.equal(env.SWITCHBOARD_PROVIDER, 'openrouter');
  assert.equal(env.SWITCHBOARD_API_KEY, 'private-key');
  assert.equal(env.SWITCHBOARD_MODEL, 'jev-latest');
  assert.equal(env.PATH, '/bin');
});

test('changing provider cannot reuse a saved provider key, model, or endpoint', async t => {
  const root = await sandbox(t);
  await saveConnection(root, { version: 1, provider: 'openrouter', apiKey: 'old-private-key', baseURL: 'https://openrouter.ai/api', model: 'jev-latest' });
  const env = await connectionEnvironment(root, { SWITCHBOARD_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'new-key' });
  assert.equal(env.SWITCHBOARD_API_KEY, undefined);
  assert.equal(env.SWITCHBOARD_BASE_URL, undefined);
  assert.equal(env.SWITCHBOARD_MODEL, undefined);
  assert.equal(env.TYPESAFE_API_KEY, 'new-key');
});

test('environment credential and model aliases override saved values', async t => {
  const root = await sandbox(t);
  await saveConnection(root, { version: 1, provider: 'typesafe', apiKey: 'old-key', model: 'jev-latest', baseURL: 'https://old.example' });
  const env = await connectionEnvironment(root, { TYPESAFE_API_KEY: 'new-key', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0', TYPESAFE_BASE_URL: 'https://new.example' });
  assert.equal(env.SWITCHBOARD_API_KEY, undefined);
  assert.equal(env.SWITCHBOARD_MODEL, undefined);
  assert.equal(env.SWITCHBOARD_BASE_URL, undefined);
  assert.equal(env.TYPESAFE_API_KEY, 'new-key');
});

test('corrupt saved credentials produce a fixed error without including file data', async t => {
  const root = await sandbox(t);
  await writeFile(join(root, 'connection.json'), '{private-key-bad-json');
  await assert.rejects(connectionEnvironment(root, {}), error => error instanceof Error && /connection.json/.test(error.message) && !error.message.includes('private-key'));
});

test('shell selection respects ZDOTDIR and bash login files', async t => {
  const root = await sandbox(t);
  assert.deepEqual(await recommendedProfiles({ SHELL: '/bin/zsh', ZDOTDIR: '/tmp/zsh-dotfiles' }, root), ['/tmp/zsh-dotfiles/.zshrc']);
  assert.deepEqual(await recommendedProfiles({ SHELL: '/bin/bash' }, root), [join(root, '.bashrc'), join(root, '.bash_profile')]);
  await writeFile(join(root, '.bash_profile'), '# existing login shell\n');
  assert.deepEqual(await recommendedProfiles({ SHELL: '/bin/bash' }, root), [join(root, '.bashrc'), join(root, '.bash_profile')]);
  assert.deepEqual(await recommendedProfiles({ SHELL: '/bin/fish' }, root), []);
});

test('profile installation preserves existing bytes and is idempotent', async t => {
  const root = await sandbox(t);
  const profile = join(root, '.zshrc');
  const before = '# personal preferences\nexport EDITOR=vim\n';
  await writeFile(profile, before, { mode: 0o640 });
  await installProfileBlock(profile, join(root, 'settings'));
  const first = await readFile(profile, 'utf8');
  assert.ok(first.startsWith(before));
  assert.equal((await stat(profile)).mode & 0o777, 0o640);
  await installProfileBlock(profile, join(root, 'settings'));
  assert.equal(await readFile(profile, 'utf8'), first);
  await installProfileBlock(profile, join(root, 'new settings'));
  const changed = await readFile(profile, 'utf8');
  assert.equal((changed.match(/# >>> Switchboard >>>/g) ?? []).length, 1);
  assert.match(changed, /new settings/);
  assert.ok(changed.startsWith(before));
});

test('profile block safely quotes shell metacharacters and contains no API key', async t => {
  const root = await sandbox(t);
  const profile = join(root, '.bashrc');
  const state = join(root, "state ' $(touch ATTACKED) `touch ATTACKED` $HOME");
  await installProfileBlock(profile, state);
  const out = spawnSync('/bin/sh', ['-c', '. "$1"; printf "%s" "$SWITCHBOARD_HOME"', 'sh', profile], { cwd: root, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, state);
  await assert.rejects(stat(join(root, 'ATTACKED')), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(profile, 'utf8'), /API_KEY|eval/);
});

test('malformed managed block is rejected without changing a profile', async t => {
  const root = await sandbox(t);
  const profile = join(root, '.profile');
  const before = '# >>> Switchboard >>>\nunrelated commands\n';
  await writeFile(profile, before);
  await assert.rejects(installProfileBlock(profile, root), /incomplete|ambiguous/i);
  assert.equal(await readFile(profile, 'utf8'), before);
});

test('symlinked shell profiles retain their link and original settings', async t => {
  const root = await sandbox(t);
  await mkdir(join(root, 'dotfiles'));
  const target = join(root, 'dotfiles', 'zshrc');
  await writeFile(target, '# managed dotfiles\n');
  const profile = join(root, '.zshrc');
  await symlink(target, profile);
  await installProfileBlock(profile, root);
  assert.equal(await readFile(profile, 'utf8'), await readFile(target, 'utf8'));
  assert.match(await readFile(target, 'utf8'), /^# managed dotfiles/);
});

test('managed blocks preserve CRLF and do not change on a repeated setup', async t => {
  const root = await sandbox(t);
  const profile = join(root, '.zshrc');
  await writeFile(profile, '# existing\r\n');
  await installProfileBlock(profile, root);
  const first = await readFile(profile, 'utf8');
  await installProfileBlock(profile, root);
  assert.equal(await readFile(profile, 'utf8'), first);
  assert.ok(first.endsWith('\r\n'));
});

test('recommended bash setup selects custom state in login and non-login interactive shells', async t => {
  const root = await sandbox(t);
  for (const loginFile of [null, '.profile', '.bash_login', '.bash_profile']) {
    const home = join(root, loginFile ?? 'fresh');
    await mkdir(home);
    if (loginFile) await writeFile(join(home, loginFile), '# personal shell config\n');
    for (const profile of await recommendedProfiles({ SHELL: '/bin/bash' }, home)) await installProfileBlock(profile, join(root, 'custom state'));
    for (const args of [['--login', '-i'], ['-i']]) {
      const result = spawnSync('/bin/bash', [...args, '-c', 'printf "%s" "$SWITCHBOARD_HOME"'], { env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm' }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, join(root, 'custom state'), `${loginFile ?? 'fresh'} ${args.join(' ')}`);
    }
  }
});

test('provider whitespace accepted by the adapter also keeps matching saved credentials', async t => {
  const root = await sandbox(t);
  await saveConnection(root, { version: 1, provider: 'openrouter', apiKey: 'saved-key' });
  assert.equal((await connectionEnvironment(root, { SWITCHBOARD_PROVIDER: ' openrouter ' })).SWITCHBOARD_API_KEY, 'saved-key');
});

test('empty environment placeholders do not hide a saved connection', async t => {
  const root = await sandbox(t);
  await saveConnection(root, { version: 1, provider: 'typesafe', apiKey: 'saved-key', baseURL: 'https://saved.example', model: 'jev-1.13.0' });
  const env = await connectionEnvironment(root, { SWITCHBOARD_API_KEY: '', TYPESAFE_API_KEY: '  ', JEV_API_KEY: '', SWITCHBOARD_BASE_URL: '', TYPESAFE_BASE_URL: '', SWITCHBOARD_MODEL: '', TYPESAFE_DEFAULT_MODEL: '', SWITCHBOARD_PROVIDER: '' });
  assert.equal(env.SWITCHBOARD_API_KEY, 'saved-key');
  assert.equal(env.SWITCHBOARD_BASE_URL, 'https://saved.example');
  assert.equal(env.SWITCHBOARD_MODEL, 'jev-1.13.0');
  assert.equal(env.SWITCHBOARD_PROVIDER, 'typesafe');
});
