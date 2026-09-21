import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareNativeLaunch } from '../src/native/launcher.ts';
import { startProxy } from '../src/native/proxy.ts';
import { TOKEN_HEADER } from '../src/native/protocol.ts';
import { defaultPolicy, bundledCatalog } from '../src/defaults.ts';

type Hook = { type: string; command: string; args: string[] };
async function run(hook: Hook, env: NodeJS.ProcessEnv, input: unknown) {
  assert.equal(hook.type, 'command', 'SessionStart must use a supported command hook, not HTTP');
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(hook.command, hook.args, { env, stdio: 'pipe' });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('generated Claude command hooks deliver native events and establish a fresh route without network permissions', async t => {
  const root = await mkdtemp(join(tmpdir(), "switchboard hook's path "));
  t.after(() => rm(root, { recursive: true, force: true }));
  let routedModel = ''; let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    routedModel = JSON.parse(body).model;
    res.end('{}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address(); assert(address && typeof address === 'object');
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async () => { calls++; return { taskType: 'implement', complexity: 'standard', reasoning: 'medium', sufficientContext: true, confidences: { model: 1, effort: 1, context: 1, taskType: 1 } }; }, upstreams: { claude: `http://127.0.0.1:${address.port}` } });
  t.after(() => proxy.close());
  const settings = { sandbox: { enabled: true }, permissions: { deny: ['WebFetch(domain:127.0.0.1)'] } };
  const prepared = await prepareNativeLaunch({ tool: 'claude', home: root, cwd: root, args: ['--settings', JSON.stringify(settings)], env: { PATH: '/nonexistent' }, proxy });
  t.after(() => prepared.cleanup());
  const merged = JSON.parse(await readFile(prepared.args[1]!, 'utf8'));
  assert.deepEqual(merged.permissions, settings.permissions);
  assert.deepEqual(merged.sandbox, settings.sandbox);
  const session = merged.hooks.SessionStart[0].hooks[0] as Hook;
  const prompt = merged.hooks.UserPromptSubmit[0].hooks[0] as Hook;
  assert.equal((await run(session, prepared.env, { hook_event_name: 'SessionStart', session_id: 'fresh', source: 'startup' })).code, 0);
  // Documented native input has no prompt_id. Prompt text is data, never shell code.
  const task = 'Explain `$(echo PRIVATE_TASK)` in JavaScript <system-reminder>context</system-reminder>';
  const delivered = await run(prompt, prepared.env, { hook_event_name: 'UserPromptSubmit', session_id: 'fresh', prompt: task });
  assert.deepEqual(delivered, { code: 0, out: '', err: '' });
  const body = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'fresh' }) }, messages: [{ role: 'user', content: task }] };
  const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { [TOKEN_HEADER]: proxy.token }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); await response.text();
  assert.equal(routedModel, 'claude-sonnet-5'); assert.equal(calls, 1);
  // Without a prompt event, SessionStart still enables the established content fallback.
  assert.equal((await run(session, prepared.env, { hook_event_name: 'SessionStart', session_id: 'content', source: 'clear' })).code, 0);
  const fallback = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { [TOKEN_HEADER]: proxy.token }, body: JSON.stringify({ ...body, metadata: { user_id: JSON.stringify({ session_id: 'content' }) } }) });
  assert.equal(fallback.status, 200); await fallback.text(); assert.equal(calls, 2);
});

test('Claude helper blocks failed delivery without leaking input, credentials, or broadening its destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-hook-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prepared = await prepareNativeLaunch({ tool: 'claude', home: root, cwd: root, args: [], env: {}, proxy: { url: 'http://127.0.0.1:1', token: 'SECRET_TOKEN' } });
  t.after(() => prepared.cleanup());
  const settings = JSON.parse(await readFile(prepared.args[1]!, 'utf8'));
  const hook = settings.hooks.UserPromptSubmit[0].hooks[0] as Hook;
  for (const input of [null, { hook_event_name: 'Stop', session_id: 'x' }, { hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'PRIVATE_TASK' }]) {
    const result = await run(hook, prepared.env, input);
    assert.equal(result.code, 2); assert.equal(result.out, '');
    assert.match(result.err, /Switchboard.*hook.*restart/i);
    assert.doesNotMatch(result.err, /SECRET_TOKEN|PRIVATE_TASK/);
  }
  const result = await run(hook, { ...prepared.env, SWITCHBOARD_HOOK_URL: 'https://example.com' }, { hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'PRIVATE_TASK' });
  assert.equal(result.code, 2);
});

for (const behavior of ['redirect', 'stall'] as const) test(`Claude helper stops on a local ${behavior} before the native hook deadline`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-hook-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url!); req.resume();
    if (behavior === 'redirect') res.writeHead(307, { location: '/unexpected' }).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === 'object');
  const prepared = await prepareNativeLaunch({ tool: 'claude', home: root, cwd: root, args: [], env: {}, proxy: { url: `http://127.0.0.1:${address.port}`, token: 'PRIVATE_TOKEN' } });
  t.after(() => prepared.cleanup());
  const settings = JSON.parse(await readFile(prepared.args[1]!, 'utf8'));
  const started = Date.now();
  const result = await run(settings.hooks.UserPromptSubmit[0].hooks[0], prepared.env, { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'PRIVATE_PROMPT' });
  assert.equal(result.code, 2); assert.equal(result.out, '');
  assert.deepEqual(paths, ['/_router/turn']);
  assert.doesNotMatch(result.err, /PRIVATE_TOKEN|PRIVATE_PROMPT/);
  assert.ok(Date.now() - started < 9000, 'Helper must report failure before Claude discards timed-out hook output');
});
