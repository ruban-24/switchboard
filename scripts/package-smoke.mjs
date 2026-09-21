import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check with npm run test:package.');
assert.notEqual(process.platform, 'win32', 'Native Windows support has not yet been verified.');
const scratch = await mkdtemp(join(tmpdir(), 'router package '));
const env = {
  PATH: process.env.PATH,
  HOME: join(scratch, 'home'),
  TMPDIR: scratch,
  npm_config_cache: process.env.SWITCHBOARD_SMOKE_NPM_CACHE || join(scratch, 'npm-cache'),
  npm_config_userconfig: join(scratch, 'empty.npmrc'),
  npm_config_globalconfig: join(scratch, 'empty-global.npmrc'),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_registry: 'https://registry.npmjs.org/',
  SWITCHBOARD_HOME: join(scratch, 'config'),
};
function run(executable, args, cwd = scratch) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function npmRun(args, cwd) { return run(process.execPath, [npm, ...args], cwd); }

try {
  await mkdir(env.HOME);
  const [packed] = JSON.parse(npmRun(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root));
  const archive = join(scratch, packed.filename);
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['bin/switchboard.mjs', 'dist/cli.js', 'dist/index.js', 'dist/native/claude-hook.js', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(files.has(required), `Missing shipped file: ${required}`);
  }
  const publicFiles = new Set([
    'package.json', 'bin/switchboard.mjs', 'README.md', 'LICENSE', 'NOTICE',
    'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
    'docs/routing.md', 'docs/customization.md', 'docs/privacy.md', 'docs/native-cli.md', 'docs/model-catalog.md',
    'docs/classifiers.md', 'docs/distribution.md',
  ]);
  for (const file of files) {
    assert.ok(publicFiles.has(file) || /^dist\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|d\.ts)$/.test(file),
      `Unexpected development or credential file in package: ${file}`);
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const [command] = Object.keys(pkg.bin);
  const prefix = join(scratch, 'global');
  npmRun(['install', '--global', '--prefix', prefix, '--ignore-scripts', archive]);
  const installed = join(prefix, 'bin', command);
  const helper = join(prefix, 'lib', 'node_modules', pkg.name, 'dist', 'native', 'claude-hook.js');
  const rejected = spawnSync(process.execPath, [helper, 'UserPromptSubmit'], {
    env: { ...env, SWITCHBOARD_HOOK_URL: 'http://127.0.0.1:1', SWITCHBOARD_TOKEN: 'test' },
    input: '{}', encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(rejected.status, 2, 'Installed helper must run from paths containing spaces and fail closed on invalid input.');
  assert.match(rejected.stderr, /Switchboard.*hook/);
  assert.equal(rejected.stdout, '');
  assert.match(run(installed, ['--help']), /Switchboard[\s\S]*switchboard claude/);
  run(installed, ['init', '--yes']);
  run(installed, ['config', 'check']);
  const globalPolicy = JSON.parse(run(installed, ['config', 'show']));

  // npm exec is npx's execution engine. A separate working directory prevents
  // accidentally running the checkout's binary or resolving its dependencies.
  const execArgs = ['exec', '--offline', '--yes', `--package=${archive}`, '--', command];
  assert.match(npmRun([...execArgs, '--help']), /Switchboard[\s\S]*switchboard codex/);
  env.SWITCHBOARD_HOME = join(scratch, 'npx-config');
  npmRun([...execArgs, 'init', '--yes']);
  npmRun([...execArgs, 'config', 'check']);
  assert.deepEqual(JSON.parse(npmRun([...execArgs, 'config', 'show'])), globalPolicy);
  console.log('Package smoke passed: isolated npm global install and npx execution, init, and policy checks.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
