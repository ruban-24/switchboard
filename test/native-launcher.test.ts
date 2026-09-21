import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { prepareNativeLaunch, runPreparedNative, validateNativeAutomatic } from '../src/native/launcher.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'router-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  return { root, home };
}

test('manual model, effort, help, admin and post -- values bypass automatic routing', async t => {
  const s = await fixture(t);
  for (const [tool, args] of [
    ['claude', ['--model', 'opus', 'hello']], ['claude', ['--effort=high']], ['claude', ['doctor']],
    ['codex', ['-m', 'gpt-5', 'hello']], ['codex', ['-c', 'model="gpt-5"']], ['codex', ['login']],
    ['codex', ['--help']],
  ] as const) {
    const result = await prepareNativeLaunch({ tool, args: [...args], home: s.home, env: {} });
    assert.equal(result.mode, 'bypass', `${tool} ${args.join(' ')}`);
    assert.deepEqual(result.args, args);
  }
  const automatic = await prepareNativeLaunch({ tool: 'claude', args: ['-p', '--', '--model'], home: s.home, env: {} });
  assert.equal(automatic.mode, 'automatic');
  assert.deepEqual(automatic.args.slice(-3), ['-p', '--', '--model']);
  await automatic.cleanup();
});

test('all launch paths remove classifier credentials while retaining native credentials', async t => {
  const s = await fixture(t);
  for (const tool of ['claude', 'codex'] as const) {
    for (const args of [[], ['--help']]) {
      const result = await prepareNativeLaunch({ tool, args, home: s.home, env: {
        JEV_API_KEY: 'jev-secret', TYPESAFE_API_KEY: 'typesafe-secret', AI_GATEWAY_API_KEY: 'gateway-secret',
        SWITCHBOARD_API_KEY: 'switchboard-secret', OPENROUTER_API_KEY: 'openrouter-secret',
        ANTHROPIC_API_KEY: 'native-claude-secret', OPENAI_API_KEY: 'native-codex-secret',
      } });
      try {
        assert.equal(result.env.JEV_API_KEY, undefined);
        assert.equal(result.env.TYPESAFE_API_KEY, undefined);
        assert.equal(result.env.AI_GATEWAY_API_KEY, undefined);
        assert.equal(result.env.SWITCHBOARD_API_KEY, undefined);
        assert.equal(result.env.OPENROUTER_API_KEY, undefined);
        assert.equal(result.env.ANTHROPIC_API_KEY, 'native-claude-secret');
        assert.equal(result.env.OPENAI_API_KEY, 'native-codex-secret');
      } finally { await result.cleanup(); }
    }
  }
});

for (const key of ['ANTHROPIC_MODEL', 'SWITCHBOARD_HOOK_URL', 'SWITCHBOARD_TOKEN']) {
  test(`automatic Claude rejects settings that override ${key} at every supported settings source`, async t => {
    for (const source of ['home', 'project', 'project-local', 'explicit']) {
      const s = await fixture(t);
      const project = join(s.root, 'project');
      await mkdir(join(project, '.claude'), { recursive: true });
      const settings = JSON.stringify({ env: { [key]: 'PRIVATE_OVERRIDE' }, permissions: { deny: ['Bash(*)'] } });
      const file = source === 'home' ? join(s.home, '.claude/settings.json')
        : source === 'explicit' ? join(s.root, 'explicit.json')
        : join(project, '.claude', source === 'project-local' ? 'settings.local.json' : 'settings.json');
      await writeFile(file, settings);
      const args = source === 'explicit' ? ['--settings', file] : [];
      const checkError = (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /settings.*override.*Switchboard/i);
        assert.doesNotMatch(error.message, /PRIVATE_OVERRIDE/);
        return true;
      };
      await assert.rejects(validateNativeAutomatic('claude', args, s.home, {}, project), checkError);
      await assert.rejects(prepareNativeLaunch({ tool: 'claude', args, home: s.home, cwd: project, env: {} }), checkError);
      assert.equal(await readFile(file, 'utf8'), settings, 'Rejection must leave native settings unchanged');
      const manual = await prepareNativeLaunch({ tool: 'claude', args: ['--model', 'sonnet', ...args], home: s.home, cwd: project, env: {} });
      assert.equal(manual.mode, 'bypass');
    }
  });
}

test('option operands are not mistaken for native commands or flags', async t => {
  const s = await fixture(t);
  const claude = await prepareNativeLaunch({ tool: 'claude', args: ['--append-system-prompt', 'doctor', 'hello'], home: s.home, env: {} });
  assert.equal(claude.mode, 'automatic');
  assert.deepEqual(claude.args.slice(-3), ['--append-system-prompt', 'doctor', 'hello']);
  await claude.cleanup();
  const codex = await prepareNativeLaunch({ tool: 'codex', args: ['--cd', 'login', 'exec', 'hello'], home: s.home, env: {} });
  assert.equal(codex.mode, 'automatic');
  assert.deepEqual(codex.args.slice(-4), ['--cd', 'login', 'exec', 'hello']);
  await codex.cleanup();

  const resumed = await prepareNativeLaunch({ tool: 'claude', args: ['--resume', '--model', 'opus'], home: s.home, env: {} });
  assert.equal(resumed.mode, 'bypass');
  assert.deepEqual(resumed.args, ['--resume', '--model', 'opus']);

  const named = await prepareNativeLaunch({ tool: 'claude', args: ['--name', 'doctor', 'hello'], home: s.home, env: {} });
  assert.equal(named.mode, 'automatic');
  assert.deepEqual(named.args.slice(-3), ['--name', 'doctor', 'hello']);
  await named.cleanup();

  const directories = await prepareNativeLaunch({ tool: 'claude', args: ['--add-dir', 'one', 'doctor', '--print', 'hello'], home: s.home, env: {} });
  assert.equal(directories.mode, 'automatic');
  assert.deepEqual(directories.args.slice(-5), ['--add-dir', 'one', 'doctor', '--print', 'hello']);
  await directories.cleanup();

  const flagValue = await prepareNativeLaunch({ tool: 'claude', args: ['--append-system-prompt', '--model', 'hello'], home: s.home, env: {} });
  assert.equal(flagValue.mode, 'automatic');
  assert.deepEqual(flagValue.args.slice(-3), ['--append-system-prompt', '--model', 'hello']);
  await flagValue.cleanup();
});

test('automatic Claude launch preserves argv and privately merges explicit settings hooks', async t => {
  const s = await fixture(t);
  const settings = join(s.root, 'settings.json');
  await writeFile(settings, JSON.stringify({ secret: 'do-not-put-in-argv', hooks: { UserPromptSubmit: [{ matcher: 'old', hooks: [{ type: 'command', command: 'true' }] }], SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'true' }] }] } }));
  const result = await prepareNativeLaunch({ tool: 'claude', args: ['--settings', settings, '-p', 'two words'], home: s.home, env: { KEEP: 'yes', JEV_API_KEY: 'remove-me' }, proxy: { url: 'http://127.0.0.1:1234', token: 'local-secret' } });
  assert.equal(result.mode, 'automatic');
  assert.deepEqual(result.args.slice(-2), ['-p', 'two words']);
  assert.equal(result.args.filter(value => value === '--settings').length, 1);
  assert.doesNotMatch(result.args.join(' '), /do-not-put-in-argv|local-secret/);
  assert.equal(result.env.JEV_API_KEY, undefined);
  assert.equal(result.env.KEEP, 'yes');
  assert.equal(result.env.ANTHROPIC_MODEL, 'switchboard');
  const file = result.args[result.args.indexOf('--settings') + 1]!;
  const merged = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(merged.secret, 'do-not-put-in-argv');
  assert.equal(merged.hooks.UserPromptSubmit.length, 2);
  assert.equal(merged.hooks.UserPromptSubmit[1].hooks[0].type, 'command');
  assert.equal(merged.hooks.UserPromptSubmit[1].hooks[0].command, process.execPath);
  assert.equal(merged.hooks.UserPromptSubmit[1].hooks[0].args[1], 'UserPromptSubmit');
  assert.equal(merged.hooks.SessionStart.length, 2);
  assert.equal(merged.hooks.SessionStart[0].matcher, 'resume');
  assert.equal(merged.hooks.SessionStart[1].hooks[0].type, 'command');
  assert.equal(merged.hooks.SessionStart[1].hooks[0].args[1], 'SessionStart');
  assert.doesNotMatch(JSON.stringify(merged), /local-secret/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await result.cleanup();
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('automatic Codex launch prepends process-scoped provider configuration without secrets in argv', async t => {
  const s = await fixture(t);
  const args = ['--ask-for-approval', 'never', 'prompt with spaces'];
  const result = await prepareNativeLaunch({ tool: 'codex', args, home: s.home, env: { TYPESAFE_API_KEY: 'remove-me' }, proxy: { url: 'http://127.0.0.1:3456', token: 'local-secret' } });
  assert.equal(result.mode, 'automatic');
  assert.deepEqual(result.args.slice(-args.length), args);
  assert.deepEqual(result.args.slice(0, 2), ['-m', 'switchboard']);
  assert.match(result.args.join('\n'), /env_http_headers/);
  assert.doesNotMatch(result.args.join('\n'), /local-secret/);
  assert.equal(result.env.SWITCHBOARD_TOKEN, 'local-secret');
  assert.equal(result.env.TYPESAFE_API_KEY, undefined);
  await result.cleanup();
});

test('Codex uses a private temporary catalog and auto effort label without editing user config', async t => {
  const s = await fixture(t);
  const catalog = { models: [{ slug: 'switchboard' }] };
  const result = await prepareNativeLaunch({ tool: 'codex', args: [], home: s.home, env: {}, codexCatalog: catalog });
  const config = result.args.find(value => value.startsWith('model_catalog_json='));
  assert.ok(config);
  const file = JSON.parse(config.slice('model_catalog_json='.length));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), catalog);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(result.args.includes('model_reasoning_effort="auto"'));
  await result.cleanup();
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('Codex exec and resume configuration options cannot replace the injected provider settings', async t => {
  const s = await fixture(t);
  for (const suffix of [
    ['exec', '-c', 'features.shell_tool=false', '--json', 'hello'],
    ['exec', 'resume', '--config=features.shell_tool=false', '--json', 'session-id', 'hello'],
    ['exec', '-cfeatures.shell_tool=false', '--json', 'hello'],
  ]) {
    const result = await prepareNativeLaunch({ tool: 'codex', home: s.home, env: {},
      args: ['-c', 'history.persistence="none"', ...suffix],
      proxy: { url: 'http://127.0.0.1:3456', token: 'local-secret' },
    });
    const execIndex = result.args.indexOf('exec');
    // Codex has separate root/subcommand override vectors. A subcommand -c can
    // discard all root overrides, so every actual override must share one scope.
    const rootConfigs = result.args.slice(0, execIndex).flatMap((arg, index, args) => arg === '-c' ? [args[index + 1]] : []);
    assert.ok(rootConfigs.includes('history.persistence="none"'));
    assert.ok(rootConfigs.includes('features.shell_tool=false'));
    assert.ok(rootConfigs.includes('model_provider="switchboard"'));
    assert.ok(rootConfigs.includes('model_providers.switchboard.base_url="http://127.0.0.1:3456"'));
    assert.equal(result.args.slice(execIndex).some(arg => arg === '-c' || arg.startsWith('-cfeatures') || arg.startsWith('--config=')), false);
    assert.equal(result.args.at(-1), 'hello');
    assert.equal(result.mode, 'automatic');
    await result.cleanup();
  }
});

test('Codex override normalization preserves duplicate precedence, text operands and post-delimiter prompt data', async t => {
  const s = await fixture(t);
  const args = ['exec', '-c', 'history.persistence="none"', '--output-last-message', '--config=literal-file',
    '-c', 'history.persistence="save-all"', '--', '-c', 'literal-prompt'];
  const result = await prepareNativeLaunch({ tool: 'codex', args, home: s.home, env: {} });
  const execIndex = result.args.indexOf('exec');
  assert.deepEqual(result.args.slice(execIndex), ['exec', '--output-last-message', '--config=literal-file', '--', '-c', 'literal-prompt']);
  const configs = result.args.slice(0, execIndex).flatMap((arg, index, args) => arg === '-c' ? [args[index + 1]] : []);
  assert.deepEqual(configs.filter(value => value?.startsWith('history.')), ['history.persistence="none"', 'history.persistence="save-all"']);
  await result.cleanup();
});

test('automatic mode rejects hook disabling and relevant custom connection configuration without exposing values', async t => {
  const s = await fixture(t);
  await assert.rejects(prepareNativeLaunch({ tool: 'claude', args: ['--bare'], home: s.home, env: {} }), /--bare.*explicit.*model/i);
  await writeFile(join(s.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://secret.invalid' } }));
  await assert.rejects(prepareNativeLaunch({ tool: 'claude', args: [], home: s.home, env: {} }), error => {
    assert.doesNotMatch(String(error), /secret\.invalid/); return /custom.*connection/i.test(String(error));
  });
  await writeFile(join(s.home, '.codex', 'config.toml'), 'model_provider = "private-provider"\n');
  await assert.rejects(prepareNativeLaunch({ tool: 'codex', args: [], home: s.home, env: {} }), error => {
    assert.doesNotMatch(String(error), /private-provider/); return /custom.*provider/i.test(String(error));
  });
  await writeFile(join(s.home, '.claude', 'settings.json'), '{}');
  const project = join(s.root, 'project');
  await mkdir(join(project, '.claude'), { recursive: true });
  await writeFile(join(project, '.claude', 'settings.local.json'), '{"disableAllHooks":true}');
  await assert.rejects(prepareNativeLaunch({ tool: 'claude', args: [], cwd: project, home: s.home, env: {} }), /requires Claude hooks/i);
  await writeFile(join(project, '.claude', 'settings.local.json'), '{"allowManagedHooksOnly":true}');
  await assert.rejects(prepareNativeLaunch({ tool: 'claude', args: [], cwd: project, home: s.home, env: {} }), /only managed Claude hooks/i);
});

test('automatic mode rejects Claude detach, cloud, safe mode, and alternate provider selectors', async t => {
  const s = await fixture(t);
  for (const flag of ['--bg', '--background', '--cloud', '--safe-mode']) {
    await assert.rejects(prepareNativeLaunch({ tool: 'claude', args: [flag], home: s.home, env: {} }), /unsupported|hooks|background|cloud/i);
  }
  for (const selector of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    await assert.rejects(prepareNativeLaunch({ tool: 'claude', args: [], home: s.home, env: { [selector]: '1' } }), /alternate|custom|managed/i);
  }
});

test('automatic Codex mode rejects a custom endpoint on the built-in provider', async t => {
  const s = await fixture(t);
  await writeFile(join(s.home, '.codex', 'config.toml'), '[model_providers.openai]\nbase_url = "http://127.0.0.1:9876/v1"\n');
  await assert.rejects(prepareNativeLaunch({ tool: 'codex', args: [], home: s.home, env: {} }), /custom.*provider/i);
});

test('manual bypass precedes unreadable config inspection', async t => {
  const s = await fixture(t);
  await writeFile(join(s.home, '.codex', 'config.toml'), 'invalid = [');
  const result = await prepareNativeLaunch({ tool: 'codex', args: ['--model', 'gpt-5'], home: s.home, env: {} });
  assert.equal(result.mode, 'bypass');
});

test('runner preserves exit status and cleans temporary settings after exit and spawn failure', async t => {
  const s = await fixture(t);
  const first = await prepareNativeLaunch({ tool: 'claude', args: [], home: s.home, env: {}, proxy: { url: 'http://127.0.0.1:1', token: 'x' } });
  const file = first.args[1]!;
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { exitCode: null, signalCode: null, kill: () => true });
  const status = runPreparedNative('/fake/claude', first, { spawn: () => {
    queueMicrotask(() => child.emit('exit', 7, null));
    return child;
  } });
  assert.equal(await status, 7);
  await assert.rejects(readFile(file), { code: 'ENOENT' });

  const second = await prepareNativeLaunch({ tool: 'claude', args: [], home: s.home, env: {}, proxy: { url: 'http://127.0.0.1:1', token: 'x' } });
  const secondFile = second.args[1]!;
  await assert.rejects(runPreparedNative('/missing', second, { spawn: () => { throw new Error('ENOENT'); } }), /Cannot start.*ENOENT/);
  await assert.rejects(readFile(secondFile), { code: 'ENOENT' });
});

test('runner maps platform child signals to conventional exit statuses', async () => {
  for (const [signal, expected] of [['SIGKILL', 137], ['SIGABRT', 134]] as const) {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null, signalCode: null, kill: () => true });
    const prepared = { mode: 'bypass' as const, args: [], env: {}, cleanup: async () => {} };
    const result = runPreparedNative('/fake/native', prepared, { spawn: () => {
      queueMicrotask(() => child.emit('exit', null, signal));
      return child;
    } });
    assert.equal(await result, expected);
  }
});

for (const operand of ['--settings', '--settings=private-operand']) {
  for (const realSettings of [[], ['--settings', '{"marker":"merged"}'], ['--settings={"marker":"merged"}']]) {
    test(`settings-looking required operand survives extraction: ${operand}, real option ${JSON.stringify(realSettings)}`, async t => {
      const s = await fixture(t);
      const args = ['--append-system-prompt', operand, ...realSettings, 'hello', '--', '--settings', 'literal.json'];
      await validateNativeAutomatic('claude', args, s.home, {}, s.root);
      const result = await prepareNativeLaunch({ tool: 'claude', args, home: s.home, cwd: s.root, env: {} });
      t.after(result.cleanup);
      assert.deepEqual(result.args.slice(2), ['--append-system-prompt', operand, 'hello', '--', '--settings', 'literal.json']);
      const merged = JSON.parse(await readFile(result.args[1]!, 'utf8'));
      assert.equal(merged.marker, realSettings.length ? 'merged' : undefined);
    });
  }
}

for (const kind of ['missing', 'unreadable', 'malformed', 'empty-file', 'empty-value', 'empty-equals', 'missing-value']) {
  test(`explicit Claude settings reject ${kind} in preflight and preparation without exposing input`, async t => {
    const s = await fixture(t);
    const path = join(s.root, 'PRIVATE-settings.json');
    if (kind === 'unreadable') await mkdir(path);
    if (kind === 'malformed') await writeFile(path, '{"PRIVATE-content":');
    if (kind === 'empty-file') await writeFile(path, '');
    const args = kind === 'empty-value' ? ['--settings', ''] : kind === 'empty-equals' ? ['--settings='] : kind === 'missing-value' ? ['--settings'] : ['--settings', path];
    for (const run of [
      () => validateNativeAutomatic('claude', args, s.home, {}, s.root),
      async () => { const prepared = await prepareNativeLaunch({ tool: 'claude', args, home: s.home, cwd: s.root, env: {} }); await prepared.cleanup(); },
    ]) {
      await assert.rejects(run(), error => {
        assert.match(String(error), /explicit Claude settings.*automatic routing did not start/i);
        assert.doesNotMatch(String(error), /PRIVATE|ENOENT|EISDIR|SyntaxError/);
        return true;
      });
    }
  });
}

test('absent optional native user and project config still permits automatic routing', async t => {
  const s = await fixture(t);
  for (const tool of ['claude', 'codex'] as const) {
    await validateNativeAutomatic(tool, ['hello'], s.home, {}, s.root);
    const result = await prepareNativeLaunch({ tool, args: ['hello'], home: s.home, cwd: s.root, env: {} });
    t.after(result.cleanup);
    assert.equal(result.mode, 'automatic');
    assert.equal(result.args.at(-1), 'hello');
  }
});
