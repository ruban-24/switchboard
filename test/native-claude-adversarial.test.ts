import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bundledCatalog, defaultPolicy } from '../src/defaults.ts';
import { prepareNativeLaunch } from '../src/native/launcher.ts';
import { startProxy, TOKEN_HEADER } from '../src/native/proxy.ts';
import { Store } from '../src/storage.ts';

async function server(t: test.TestContext) {
  const requests: Array<{ path: string; body: any; token: string | string[] | undefined }> = [];
  const listener = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()), token: req.headers[TOKEN_HEADER] });
    res.writeHead(req.url?.startsWith('/_router/') ? 204 : 200).end();
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => { listener.closeAllConnections(); return new Promise<void>(resolve => listener.close(() => resolve())); });
  const address = listener.address(); assert(address && typeof address === 'object');
  return { requests, url: `http://127.0.0.1:${address.port}` };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-adversarial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiver = await server(t);
  const launch = await prepareNativeLaunch({ tool: 'claude', home: root, cwd: root, args: [], env: {}, proxy: { url: receiver.url, token: 'TEST_SECRET' } });
  t.after(() => launch.cleanup());
  const settings = JSON.parse(await readFile(launch.args[1]!, 'utf8'));
  async function hook(event: string, input: unknown, options: { raw?: boolean; end?: boolean; env?: NodeJS.ProcessEnv; split?: number } = {}) {
    const command = settings.hooks[event][0].hooks[0];
    const child = spawn(command.command, command.args, { env: { ...launch.env, ...options.env }, stdio: 'pipe' });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 9000);
    const result = new Promise<{ code: number | null; signal: string | null; out: string; err: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, out, err }));
    });
    const bytes = Buffer.from(options.raw ? String(input) : JSON.stringify(input));
    if (options.split) { child.stdin.write(bytes.subarray(0, options.split)); child.stdin.write(bytes.subarray(options.split)); }
    else child.stdin.write(bytes);
    if (options.end !== false) child.stdin.end();
    try { return await result; } finally { clearTimeout(timer); child.stdin.destroy(); }
  }
  return { root, receiver, hook };
}

test('command helper rejects malformed lifecycle sources before delivering them', async t => {
  const f = await fixture(t);
  for (const source of [['startup'], { toString: 'startup' }, '', null, 1, 'unknown']) {
    const result = await f.hook('SessionStart', { hook_event_name: 'SessionStart', session_id: 'valid', source });
    assert.equal(result.code, 2, `source ${JSON.stringify(source)} must fail`);
  }
  assert.deepEqual(f.receiver.requests, []);
});

test('command helper rejects malformed supplied prompt identities before acknowledging delivery', async t => {
  const f = await fixture(t);
  for (const prompt_id of ['', '   ', 42, [], {}, 'x'.repeat(257)]) {
    const result = await f.hook('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 'valid', prompt_id, prompt: 'PRIVATE_TASK' });
    assert.equal(result.code, 2, `prompt_id ${JSON.stringify(prompt_id)} must fail`);
    assert.equal(result.out, ''); assert.doesNotMatch(result.err, /PRIVATE_TASK|TEST_SECRET/);
  }
  assert.deepEqual(f.receiver.requests, []);
});

test('command helper treats shell syntax and fragmented Unicode as data and sends only required fields', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'must-not-exist');
  const prompt = `Explain 🧭\n$(touch ${marker}) and \`touch ${marker}\` as literal shell text.`;
  const event = { hook_event_name: 'UserPromptSubmit', session_id: 'unicode', prompt, transcript_path: '/private/secret', cwd: '/private/path', unrelated: 'PRIVATE_METADATA' };
  const split = Buffer.from(JSON.stringify(event)).indexOf(Buffer.from('🧭')) + 1;
  const result = await f.hook('UserPromptSubmit', event, { split });
  assert.deepEqual(result, { code: 0, signal: null, out: '', err: '' });
  assert.equal(f.receiver.requests.length, 1);
  const received = f.receiver.requests[0]!;
  assert.equal(received.path, '/_router/turn'); assert.equal(received.token, 'TEST_SECRET');
  assert.deepEqual(Object.keys(received.body).sort(), ['prompt', 'prompt_id', 'session_id']);
  assert.equal(received.body.prompt, prompt); assert.equal(received.body.session_id, 'unicode');
  assert.match(received.body.prompt_id, /^[a-f0-9-]{36}$/);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('command helper rejects invalid JSON, event mismatch, invalid sessions and oversized stdin without delivery', async t => {
  const f = await fixture(t);
  for (const input of ['{"prompt":"PRIVATE_TASK"', 'null', '[]', JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }), ...['', '../escape', 'a\nb', 'x'.repeat(257)].map(session_id => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id, prompt: 'PRIVATE_TASK' })), JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'x'.repeat(16 * 1024 * 1024) })]) {
    const result = await f.hook('UserPromptSubmit', input, { raw: true });
    assert.equal(result.code, 2); assert.equal(result.out, ''); assert.doesNotMatch(result.err, /PRIVATE_TASK|TEST_SECRET/);
  }
  assert.deepEqual(f.receiver.requests, []);
});

test('command helper deadline includes unfinished stdin and blocks before the native timeout', async t => {
  const f = await fixture(t);
  const start = Date.now();
  const result = await f.hook('UserPromptSubmit', '{', { raw: true, end: false });
  assert.equal(result.code, 2); assert.equal(result.signal, null); assert.equal(result.out, '');
  assert.match(result.err, /Switchboard.*hook/i); assert.ok(Date.now() - start < 8500);
  assert.deepEqual(f.receiver.requests, []);
});

test('command helper rejects altered URL authority, paths and credentials without network delivery', async t => {
  const f = await fixture(t);
  for (const url of ['https://127.0.0.1:1234', 'http://example.com:1234', 'http://127.0.0.1.example.com:1234', f.receiver.url + '/elsewhere', f.receiver.url + '?x=1', f.receiver.url + '#x', f.receiver.url.replace('http://', 'http://user:pass@')]) {
    const result = await f.hook('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'PRIVATE_TASK' }, { env: { SWITCHBOARD_HOOK_URL: url } });
    assert.equal(result.code, 2); assert.doesNotMatch(result.err, /PRIVATE_TASK|TEST_SECRET/);
  }
  assert.deepEqual(f.receiver.requests, []);
});

async function proxyFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-adversarial-proxy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = await server(t);
  const tasks: string[] = [];
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async task => { tasks.push(task); return { taskType: 'implement', complexity: 'standard', reasoning: 'medium', sufficientContext: true, confidences: { model: 1, effort: 1, context: 1, taskType: 1 } }; }, upstreams: { claude: upstream.url } });
  t.after(() => proxy.close());
  async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(proxy.url + path, { method: 'POST', headers: { [TOKEN_HEADER]: proxy.token, ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.text() };
  }
  return { root, upstream, tasks, call };
}

test('hook endpoints reject malformed JSON shapes and identities with client errors', async t => {
  const f = await proxyFixture(t);
  for (const endpoint of ['/_router/session', '/_router/turn']) {
    const valid = endpoint.endsWith('session') ? { session_id: 's', source: 'startup' } : { session_id: 's', prompt_id: 'p', prompt: 'PRIVATE_TASK' };
    const invalid = [null, [], 1, {}, { ...valid, session_id: '' }, { ...valid, session_id: '../escape' }, { ...valid, session_id: 'x'.repeat(257) }, ...(endpoint.endsWith('session') ? [{ ...valid, source: ['startup'] }] : [{ ...valid, prompt_id: '' }, { ...valid, prompt_id: '   ' }, { ...valid, prompt_id: [] }])];
    for (const body of invalid) {
      const result = await f.call(endpoint, body);
      assert.equal(result.status, 400, `${endpoint} ${JSON.stringify(body)}`);
      assert.doesNotMatch(result.body, /PRIVATE_TASK/);
    }
  }
  assert.equal(f.tasks.length, 0); assert.equal(f.upstream.requests.length, 0);
});

test('unauthorized and cross-session hook events cannot establish or consume another conversation route', async t => {
  const f = await proxyFixture(t);
  const message = (session: string) => ({ model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: session }) }, messages: [{ role: 'user', content: 'same task' }] });
  for (const endpoint of ['/_router/session', '/_router/turn']) assert.equal((await f.call(endpoint, { session_id: 'b', source: 'startup', prompt_id: 'b', prompt: 'same task' }, { [TOKEN_HEADER]: 'forged' })).status, 401);
  assert.equal((await f.call('/_router/turn', { session_id: 'a', prompt_id: 'a', prompt: 'same task' })).status, 204);
  assert.equal((await f.call('/v1/messages', message('b'))).status, 409);
  assert.equal((await f.call('/v1/messages', message('a'), { 'x-claude-code-session-id': 'b' })).status, 409);
  assert.equal(f.tasks.length, 0); assert.equal(f.upstream.requests.length, 0);
  assert.equal((await f.call('/v1/messages', message('a'))).status, 200);
  assert.equal((await f.call('/v1/messages', message('b'))).status, 409);
  await f.call('/_router/turn', { session_id: 'b', prompt_id: 'b', prompt: 'same task' });
  assert.equal((await f.call('/v1/messages', message('b'))).status, 200);
  assert.deepEqual(f.tasks, ['same task', 'same task']);
  assert.equal(f.upstream.requests.length, 2);
  assert.ok(f.upstream.requests.every(r => r.token === undefined));
  for (const id of ['a', 'b']) assert.equal((await new Store(f.root).load('claude', id))?.selection.model, 'claude-sonnet-5');
});

test('concurrent retries share one classification and cannot change the selected pair', async t => {
  const f = await proxyFixture(t);
  await f.call('/_router/turn', { session_id: 'retry', prompt_id: 'first', prompt: 'same task' });
  const body = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'retry' }) }, messages: [{ role: 'user', content: 'same task' }] };
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.call('/v1/messages', body)));
  assert.ok(responses.every(r => r.status === 200));
  assert.deepEqual(f.tasks, ['same task']);
  assert.equal(f.upstream.requests.length, 12);
  assert.ok(f.upstream.requests.every(r => r.body.model === 'claude-sonnet-5' && r.body.output_config.effort === 'medium'));
  assert.equal((await new Store(f.root).load('claude', 'retry'))?.history.length, 1);
});

test('late startup events cannot make a resumed identity fresh when its saved route is missing', async t => {
  const f = await proxyFixture(t);
  for (const source of ['resume', 'compact', 'fork']) for (const lateSource of ['startup', 'clear']) {
    const id = `${source}-${lateSource}`;
    await f.call('/_router/session', { session_id: id, source });
    await f.call('/_router/session', { session_id: id, source: lateSource });
    await f.call('/_router/turn', { session_id: id, prompt_id: 'next', prompt: 'continue work' });
    const result = await f.call('/v1/messages', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: id }) }, messages: [{ role: 'user', content: 'continue work' }] });
    assert.equal(result.status, 409, `${source} followed by ${lateSource}`);
    assert.match(result.body, /saved route|original router/);
    assert.equal(await new Store(f.root).load('claude', id), null);
  }
  assert.equal(f.tasks.length, 0); assert.equal(f.upstream.requests.length, 0);
  // A genuinely new identity still gets a first route after /clear.
  await f.call('/_router/session', { session_id: 'new-after-clear', source: 'clear' });
  assert.equal((await f.call('/v1/messages', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'new-after-clear' }) }, messages: [{ role: 'user', content: 'new task' }] })).status, 200);
});
