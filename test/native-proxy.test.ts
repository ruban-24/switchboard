import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy, TOKEN_HEADER } from '../src/native/proxy.ts';
import { Ownership } from '../src/native/ownership.ts';
import { UsageStore } from '../src/native/usage-store.ts';
import { bundledCatalog, defaultPolicy } from '../src/defaults.ts';
import { Store } from '../src/storage.ts';

test('fresh-session evidence permits content routing and saved routes survive missing hooks, retries and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-hybrid-'));
  const upstream = await fixtureUpstream();
  const tasks: string[] = [];
  const options = { tool: 'claude' as const, root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async (task: string) => { tasks.push(task); return { taskType: 'implement' as const, complexity: 'standard' as const, reasoning: 'low' as const, sufficientContext: true, confidences: { model: .9, effort: .5, context: 1, taskType: 1 } }; }, upstreams: { claude: upstream.url } };
  let proxy = await startProxy(options);
  const base = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'hybrid' }) }, tools: [] };
  const first = { ...base, messages: [{ role: 'user', content: 'implement a bounded parser' }, { role: 'system', content: 'native context' }] };
  try {
    assert.equal((await call(proxy.url, proxy.token, '/_router/session', { session_id: 'hybrid', source: 'startup' })).status, 204);
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', first)).status, 200);
    const saved = await new Store(root).load('claude', 'hybrid');
    assert.equal(saved?.selection.model, 'claude-sonnet-5');
    assert.equal(saved?.selection.effort, 'medium');
    assert.equal(saved?.lastDecision.turnDetection, 'content');
    assert.deepEqual(saved?.lastDecision.adjustments, ['effort-default']);
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', first)).status, 200);
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'hybrid', prompt_id: 'next', prompt: 'a queued follow-up' });
    for (const messages of [
      [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'result' }] }],
      [{ role: 'user', content: 'different text from the queued hook' }],
      [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'test' } }] }],
    ]) assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages })).status, 200);
    assert.deepEqual(tasks, ['implement a bounded parser']);
    // The ambiguous request did not consume the unmatched hook.
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: [{ role: 'user', content: 'a queued follow-up' }] })).status, 200);
    assert.deepEqual(tasks, ['implement a bounded parser', 'a queued follow-up']);
    await proxy.close(); proxy = await startProxy(options);
    await call(proxy.url, proxy.token, '/_router/session', { session_id: 'hybrid', source: 'resume' });
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...first, model: 'switchboard' })).status, 200);
    assert.equal(tasks.length, 2);
    assert.ok(upstream.requests.every(r => r.body.model === 'claude-sonnet-5'));
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('a matching prompt hook cannot initialize a resumed conversation whose route is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-hybrid-'));
  const upstream = await fixtureUpstream();
  let calls = 0;
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { calls++; throw new Error('must not classify'); }, upstreams: { claude: upstream.url } });
  try {
    for (const source of ['resume', 'compact', 'fork', 'startup']) {
      await call(proxy.url, proxy.token, '/_router/session', { session_id: source, source });
      await call(proxy.url, proxy.token, '/_router/turn', { session_id: source, prompt_id: 'p', prompt: 'continue' });
      const messages = source === 'startup' ? [{ role: 'assistant', content: 'previous answer' }, { role: 'user', content: 'continue' }] : [{ role: 'user', content: 'continue' }];
      const response = await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: source }) }, messages });
      assert.equal(response.status, 409);
      assert.match(await response.text(), /saved route|original router/i);
    }
    assert.equal(calls, 0); assert.equal(upstream.requests.length, 0);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex with a saved route tolerates missing turn metadata without reclassification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-hybrid-'));
  const upstream = await fixtureUpstream();
  let calls = 0;
  const proxy = await startProxy({ tool: 'codex', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { calls++; throw new Error('offline'); }, upstreams: { codexApi: upstream.url } });
  const body = { model: 'switchboard', client_metadata: { thread_id: 'cx' }, input: [{ role: 'user', content: 'task' }] };
  try {
    assert.equal((await call(proxy.url, proxy.token, '/responses', { ...body, client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'cx', turn_id: 't', request_kind: 'turn' }) } })).status, 200);
    assert.equal((await call(proxy.url, proxy.token, '/responses', { ...body, model: 'switchboard' })).status, 200);
    assert.equal(calls, 1);
    assert.equal(upstream.requests[1]?.body.model, 'gpt-5.6-sol');
    assert.equal((await call(proxy.url, proxy.token, '/responses', { ...body, client_metadata: { thread_id: 'unseen' } })).status, 409);
    assert.equal((await call(proxy.url, proxy.token, '/responses', body, { 'thread-id': 'conflict' })).status, 409);
    assert.equal(upstream.requests.length, 2);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

async function fixtureUpstream() {
  const requests: Array<{headers:http.IncomingHttpHeaders; body:Record<string,unknown>}> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown> });
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":1}}}\n\n');
    res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function call(url: string, token: string, path: string, body: unknown, headers: Record<string,string> = {}) {
  const target = new URL(path, url);
  return new Promise<{status:number;text():Promise<string>} >((resolve, reject) => {
    const request = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token, ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('test request timed out')));
    request.end(JSON.stringify(body));
  });
}

test('Claude hook drives first route, follow-up reuses it, and cached request fields survive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const upstream = await fixtureUpstream();
  const tasks: string[] = [];
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async task => { tasks.push(task); return { taskType: 'implement', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: .99, effort: .99, context: .99, taskType: .99 } }; },
    upstreams: { claude: upstream.url } });
  try {
    const hook = await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'session-a', prompt_id: 'prompt-a', prompt: 'build it' });
    assert.equal(hook.status, 204);
    const body = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'session-a' }) }, tools: [], system: [{ text: 'cached', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'build it' }] };
    const first = await call(proxy.url, proxy.token, '/v1/messages?beta=true', body, { authorization: 'Bearer native', connection: 'keep-alive', 'x-claude-code-session-id': 'session-a' });
    assert.equal(first.status, 200); assert.match(await first.text(), /message_start/);
    const duplicate = await call(proxy.url, proxy.token, '/v1/messages?beta=true', body, { authorization: 'Bearer native', 'x-claude-code-session-id': 'session-a' });
    assert.equal(duplicate.status, 200); await duplicate.text();
    assert.deepEqual(tasks, ['build it']);
    assert.equal(upstream.requests[0]?.body.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(upstream.requests[0]?.body.system, body.system);
    assert.equal(upstream.requests[0]?.headers[TOKEN_HEADER], undefined);
    assert.equal(upstream.requests[0]?.headers.connection, 'close');
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('automatic Claude main inference without hook data fails actionably even with tools empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const upstream = await fixtureUpstream();
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { throw new Error('must not classify'); }, upstreams: { claude: upstream.url } });
  try {
    const response = await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'missing-hook' }) }, tools: [], messages: [] }, { 'x-claude-code-session-id': 'missing-hook' });
    assert.equal(response.status, 409); assert.match(await response.text(), /UserPromptSubmit hook data is missing/i);
    assert.equal(upstream.requests.length, 0);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude routes its first subscription request with an untagged system trailer and preserves the trailer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const upstream = await fixtureUpstream();
  const tasks: string[] = [];
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async task => { tasks.push(task); return { taskType: 'edit', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: .99, effort: .99, context: .99, taskType: .99 } }; }, upstreams: { claude: upstream.url } });
  try {
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'subscription', prompt_id: 'first', prompt: 'fix it' });
    const messages = [{ role: 'user', content: 'fix it' }, { role: 'system', content: [{ type: 'text', text: 'Subscription context', cache_control: { type: 'ephemeral' } }] }];
    const result = await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'subscription' }) }, messages });
    assert.equal(result.status, 200);
    assert.deepEqual(tasks, ['fix it']);
    assert.deepEqual(upstream.requests[0]?.body.messages, messages);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude native compatibility retries reuse the hook after system context and cache metadata change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const tasks: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (body.messages.some((message: { role: string }) => message.role === 'system')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: "role 'system' is not supported on this model" } }));
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"content":[{"type":"text","text":"answer"}]}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async task => { tasks.push(task); return { taskType: 'explain', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: .99, effort: .99, context: .99, taskType: .99 } }; }, upstreams: { claude: `http://127.0.0.1:${address.port}` } });
  const metadata = { user_id: JSON.stringify({ session_id: 'retry-session' }) };
  const prompt = 'show me how to reverse a linked list';
  const base = { model: 'switchboard', metadata, tools: [{ name: 'Read' }] };
  const firstMessages = [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>brief context</system-reminder>' }, { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] }, { role: 'system', content: 'native session context' }];
  const retryMessages = [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>expanded context</system-reminder>', cache_control: { type: 'ephemeral' } }, { type: 'text', text: prompt }] }];
  try {
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'retry-session', prompt_id: 'first', prompt });
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: firstMessages })).status, 400);
    const retry = await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: retryMessages });
    assert.equal(retry.status, 200); assert.match(await retry.text(), /answer/);
    assert.deepEqual(tasks, [prompt]);
    assert.equal(requests[1]?.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(requests[1]?.messages, retryMessages);
    // A real subsequent turn with identical wording still requires its new hook
    // and must classify once, even if the retry-shaped body is identical.
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'retry-session', prompt_id: 'second', prompt });
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: retryMessages })).status, 200);
    assert.deepEqual(tasks, [prompt, prompt]);
    const unrelated = await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: [{ role: 'user', content: 'different task without a hook' }] });
    assert.equal(unrelated.status, 200);
    assert.deepEqual(tasks, [prompt, prompt]);
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

for (const contentType of ['text/event-stream', undefined]) test(`Codex streams the actual model and effort with content-type ${contentType ?? 'absent'}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, contentType ? { 'content-type': contentType } : {});
    res.write('event: response.created\r\ndata: {"type":"response.created","response":{"id":"r"}}\r');
    setImmediate(() => res.end('\n\r\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const proxy = await startProxy({ tool: 'codex', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { throw new Error('unavailable'); }, upstreams: { codexApi: `http://127.0.0.1:${address.port}` } });
  try {
    const body = { model: 'switchboard', client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread', turn_id: 'first', request_kind: 'turn' }) }, input: [{ role: 'user', content: 'task' }] };
    const result = await call(proxy.url, proxy.token, '/responses', body);
    assert.equal(result.status, 200);
    const stream = await result.text();
    assert.match(stream, /gpt-5.6-sol.*high.*classifier unavailable/i);
    assert.ok(stream.indexOf('response.created') < stream.indexOf('[Router]'));
    assert.ok(stream.indexOf('[Router]') < stream.indexOf('response.completed'));
    assert.equal((stream.match(/response.output_item.done/g) ?? []).length, 2); // event and JSON type
    assert.equal((await new UsageStore(root).load('codex', 'thread'))?.totalInputTokens, 12);
    const explicit = await call(proxy.url, proxy.token, '/responses', { ...body, model: 'gpt-6-astra' });
    assert.doesNotMatch(await explicit.text(), /\[Router\]/);
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('malformed hook errors are generic and do not echo private input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const upstream = await fixtureUpstream();
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { throw new Error('unused'); }, upstreams: { claude: upstream.url } });
  try {
    const target = new URL('/_router/turn', proxy.url);
    const result = await new Promise<{status:number;body:string}>((resolve, reject) => {
      const request = http.request(target, { method: 'POST', headers: { [TOKEN_HEADER]: proxy.token } }, response => { const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() })); });
      request.on('error', reject); request.end('{"PRIVATE-MARKER":');
    });
    assert.equal(result.status, 400); assert.doesNotMatch(result.body, /PRIVATE-MARKER/);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('queued Claude hook is not consumed by a tool continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const upstream = await fixtureUpstream();
  const tasks: string[] = [];
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async task => { tasks.push(task); return { taskType: 'implement', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: .99, effort: .99, context: .99, taskType: .99 } }; }, upstreams: { claude: upstream.url } });
  const metadata = { user_id: JSON.stringify({ session_id: 'session-q' }) };
  try {
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'session-q', prompt_id: 'p1', prompt: 'first' });
    await (await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata, messages: [{ role: 'user', content: 'first' }] })).text();
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'session-q', prompt_id: 'p2', prompt: 'second' });
    await (await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata, messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'done' }] }] })).text();
    await (await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata, messages: [{ role: 'user', content: 'second' }] })).text();
    assert.deepEqual(tasks, ['first', 'second']);
    const missing = await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata, messages: [{ role: 'user', content: 'third' }] });
    assert.equal(missing.status, 200);
    assert.deepEqual(tasks, ['first', 'second']);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude classifies a hook-matched prompt bundled with a denied tool result exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-mixed-'));
  const upstream = await fixtureUpstream();
  const tasks: string[] = [];
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async task => { tasks.push(task); return { taskType: 'review', complexity: task === 'first' ? 'routine' : 'complex', reasoning: 'high', sufficientContext: true, confidences: { model: 1, effort: 1, context: 1, taskType: 1 } }; }, upstreams: { claude: upstream.url } });
  const metadata = { user_id: JSON.stringify({ session_id: 'mixed' }) };
  const base = { model: 'switchboard', metadata, tools: [], system: [{ type: 'text', text: 'unchanged prefix', cache_control: { type: 'ephemeral' } }] };
  const prompt = 'Review atomicity and concurrent retries.';
  const parts = [{ type: 'tool_result', tool_use_id: 'edit-1', is_error: true, content: 'Permission denied' },
    { type: 'text', text: '[Request interrupted by user for tool use]' }, { type: 'text', text: prompt }];
  const mixed = { ...base, messages: [{ role: 'user', content: parts }, { role: 'system', content: 'native trailer' }] };
  const store = new Store(root);
  try {
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'mixed', prompt_id: 'p1', prompt: 'first' });
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: [{ role: 'user', content: 'first' }] })).status, 200);
    const initial = (await store.load('claude', 'mixed'))!;
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'mixed', prompt_id: 'p2', prompt });
    // Matching text nested in tool output, unmatched top-level text and helpers
    // must not consume the actual user's pending event.
    for (const content of [
      [{ type: 'tool_result', content: [{ type: 'text', text: prompt }] }],
      [parts[0], { type: 'text', text: 'unrelated text' }],
    ]) assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: [{ role: 'user', content }] })).status, 200);
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', mixed, { 'x-claude-code-agent-id': 'helper' })).status, 200);
    assert.deepEqual(tasks, ['first']);
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', mixed)).status, 200);
    assert.deepEqual(tasks, ['first', prompt]);
    const after = (await store.load('claude', 'mixed'))!;
    assert.equal(after.history.length, 2);
    assert.equal(after.lastDecision.turnId, 'p2');
    assert.equal(after.lastDecision.turnDetection, 'hook');
    assert.equal(after.lastDecision.recommendation?.model, 'claude-opus-5');
    assert.deepEqual(after.selection, initial.selection);
    assert.deepEqual(upstream.requests.at(-1)?.body.messages, mixed.messages);
    assert.deepEqual(upstream.requests.at(-1)?.body.system, base.system);
    // Compatibility retry changes only reminders/cache metadata, not identity.
    const retry = { ...mixed, messages: [{ role: 'user', content: [...parts.slice(0, 2), { type: 'text', text: `<system-reminder>retry</system-reminder>${prompt}`, cache_control: { type: 'ephemeral' } }] }] };
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', retry)).status, 200);
    assert.deepEqual(tasks, ['first', prompt]);
    assert.equal((await store.load('claude', 'mixed'))?.history.length, 2);
    // A new event with identical wording still represents another user turn.
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'mixed', prompt_id: 'p3', prompt });
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', retry)).status, 200);
    assert.deepEqual(tasks, ['first', prompt, prompt]);
    assert.equal((await store.load('claude', 'mixed'))?.history.length, 3);
    assert.ok(upstream.requests.every(r => r.body.model === initial.selection.model));
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

for (const variant of ['long mixed prompt', 'interrupted text prompt']) test(`Claude retains hook identity for a ${variant}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-hook-identity-'));
  const upstream = await fixtureUpstream(); const tasks: string[] = [];
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async task => { tasks.push(task); return { taskType: 'review', complexity: 'complex', reasoning: 'high', sufficientContext: true, confidences: { model: 1, effort: 1, context: 1, taskType: 1 } }; }, upstreams: { claude: upstream.url } });
  const base = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'identity' }) } };
  const long = variant === 'long mixed prompt';
  const prompt = long ? 'x'.repeat(defaultPolicy.classifier.maxContextChars + 2) : 'Reply exactly CANCEL_RECOVERED.';
  const content = [...(long ? [{ type: 'tool_result', tool_use_id: 'edit', is_error: true, content: 'denied' }] : []),
    { type: 'text', text: '[Request interrupted by user]' }, { type: 'text', text: prompt }];
  try {
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'identity', prompt_id: 'p1', prompt: 'first' });
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: [{ role: 'user', content: 'first' }] })).status, 200);
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'identity', prompt_id: 'p2', prompt });
    const body = { ...base, messages: [{ role: 'user', content }] };
    for (let i = 0; i < 2; i++) assert.equal((await call(proxy.url, proxy.token, '/v1/messages', body)).status, 200);
    assert.deepEqual(tasks, ['first', prompt.slice(0, defaultPolicy.classifier.maxContextChars)]);
    const saved = (await new Store(root).load('claude', 'identity'))!;
    assert.equal(saved.history.length, 2);
    assert.equal(saved.lastDecision.turnId, 'p2');
    assert.equal(saved.lastDecision.classification?.sufficientContext, !long);
    assert.deepEqual(upstream.requests.at(-1)?.body.messages, body.messages);
    if (long) {
      // A retry's stored/truncated text must not consume another real prompt
      // whose full text happens to equal that prefix.
      const prefix = prompt.slice(0, defaultPolicy.classifier.maxContextChars + 1);
      await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'identity', prompt_id: 'p3', prompt: prefix });
      assert.equal((await call(proxy.url, proxy.token, '/v1/messages', body)).status, 200);
      assert.equal(tasks.length, 2);
      assert.equal((await new Store(root).load('claude', 'identity'))?.lastDecision.turnId, 'p2');
      assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: [{ role: 'user', content: prefix }] })).status, 200);
      assert.equal(tasks.length, 3);
      assert.equal((await new Store(root).load('claude', 'identity'))?.lastDecision.turnId, 'p3');
    }
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

for (const excludeRoutine of [false, true]) test(`Codex task titles use eligible routine mapping without classification or user state (exclude routine: ${excludeRoutine})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-codex-title-'));
  const upstream = await fixtureUpstream();
  const policy = structuredClone(defaultPolicy);
  if (excludeRoutine) policy.excludedModels.codex.push('gpt-5.6-luna');
  const tasks: string[] = [];
  const decisions: unknown[] = [];
  const proxy = await startProxy({ tool: 'codex', root, policy, catalog: bundledCatalog,
    classify: async task => { tasks.push(task); return { taskType: 'review', complexity: 'complex', reasoning: 'high', sufficientContext: true, confidences: { model: 1, effort: 1, context: 1, taskType: 1 } }; },
    onDecision: d => decisions.push(d), upstreams: { codexApi: upstream.url } });
  const title = { model: 'switchboard', instructions: 'You are a coding agent.',
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'title', turn_id: 'title-1', request_kind: 'turn', thread_source: 'system' }) },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb.\n\nTask: Investigate a transaction race' }] }], reasoning: { effort: 'xhigh' } };
  const main = { ...title, instructions: 'You are a coding agent.',
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'main', turn_id: 'main-1', request_kind: 'turn', thread_source: 'user' }) } };
  const store = new Store(root);
  try {
    assert.equal((await call(proxy.url, proxy.token, '/responses', title)).status, 200);
    assert.deepEqual(tasks, []);
    assert.equal(await store.load('codex', 'title'), null);
    assert.deepEqual(decisions, []);
    assert.equal(upstream.requests[0]?.body.model, excludeRoutine ? 'gpt-5.6-terra' : 'gpt-5.6-luna');
    assert.deepEqual(upstream.requests[0]?.body.reasoning, { effort: 'low' });
    assert.deepEqual(upstream.requests[0]?.body.input, title.input);
    assert.equal((await call(proxy.url, proxy.token, '/responses', main)).status, 200);
    const before = await store.load('codex', 'main');
    const usage = new UsageStore(root);
    const sentinel = { totalInputTokens: 100, cachedInputTokens: 80, cacheWriteTokens: 0, outputTokens: 3 };
    await usage.save('codex', 'main', sentinel);
    for (let i = 0; i < 2; i++) assert.equal((await call(proxy.url, proxy.token, '/responses', title)).status, 200);
    // A title sharing the user's identity still must not overwrite its route/usage.
    const sameId = { ...title, client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'main', turn_id: 'title-2', request_kind: 'turn', thread_source: 'system' }) } };
    assert.equal((await call(proxy.url, proxy.token, '/responses', sameId)).status, 200);
    assert.deepEqual(await store.load('codex', 'main'), before);
    assert.deepEqual(await usage.load('codex', 'main'), sentinel);
    assert.equal(await usage.load('codex', 'title'), null);
    assert.equal(await store.load('codex', 'title'), null);
    assert.equal(tasks.length, 1); assert.equal(decisions.length, 1);
    assert.equal((await readdir(join(root, 'sessions'))).length, 1);
    assert.equal(upstream.requests[1]?.body.model, 'gpt-5.6-sol');
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude helper before main uses transient fallback without classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-')); const upstream = await fixtureUpstream(); let classified = 0;
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { classified++; throw new Error('unused'); }, upstreams: { claude: upstream.url } });
  try {
    const response = await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'helper-session' }) }, messages: [{ role: 'user', content: 'helper' }] }, { 'x-claude-code-agent-id': 'agent-1' });
    assert.equal(response.status, 200); await response.text(); assert.equal(classified, 0);
    assert.equal(upstream.requests[0]?.body.model, 'claude-opus-5');
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude one-token startup quota probe neither classifies nor adds thinking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-')); const upstream = await fixtureUpstream();
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async () => { throw new Error('must not classify quota'); }, upstreams: { claude: upstream.url } });
  const body = { model: 'switchboard', max_tokens: 1, metadata: { user_id: JSON.stringify({ session_id: 'quota-session' }) }, messages: [{ role: 'user', content: 'quota' }] };
  try {
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', body)).status, 200);
    assert.deepEqual(upstream.requests[0]?.body, { ...body, model: 'claude-opus-5' });
    assert.equal((await readdir(join(root, 'sessions')).catch(() => [])).length, 0);
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...body, max_tokens: 100 })).status, 409);
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...body, tools: [] })).status, 409);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude session-title requests do not require or consume the main prompt hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-')); const upstream = await fixtureUpstream(); const tasks: string[] = [];
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async task => { tasks.push(task); return { taskType: 'explain', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: .99, effort: .99, context: .99, taskType: .99 } }; }, upstreams: { claude: upstream.url } });
  const base = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'title-session' }) }, tools: [] };
  const title = { ...base, system: [{ type: 'text', text: 'You are naming a coding session so the user can pick it out of a long list of sessions. Return JSON with a single "title" field.' }], messages: [{ role: 'user', content: [{ type: 'text', text: '<session>reverse a linked list</session>\nWrite the title in the predominant language of the session.' }] }] };
  try {
    await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'title-session', prompt_id: 'first', prompt: 'reverse a linked list' });
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', title)).status, 200);
    assert.deepEqual(tasks, []);
    assert.equal(upstream.requests[0]?.body.model, 'claude-opus-5');
    assert.equal((await readdir(join(root, 'sessions')).catch(() => [])).length, 0);
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...base, messages: [{ role: 'user', content: 'reverse a linked list' }] })).status, 200);
    assert.deepEqual(tasks, ['reverse a linked list']);
    assert.equal(upstream.requests[1]?.body.model, 'claude-haiku-4-5-20251001');
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', title)).status, 200);
    assert.equal(upstream.requests[2]?.body.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(upstream.requests[2]?.body.messages, title.messages);
    assert.deepEqual(tasks, ['reverse a linked list']);
    // A similarly tagged user prompt keeps the saved route when its hook is absent.
    assert.equal((await call(proxy.url, proxy.token, '/v1/messages', { ...title, system: [] })).status, 200);
    assert.deepEqual(tasks, ['reverse a linked list']);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude count_tokens before main uses transient fallback without classification or state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-')); const upstream = await fixtureUpstream(); let classified = 0;
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { classified++; throw new Error('unused'); }, upstreams: { claude: upstream.url } });
  try {
    const response = await call(proxy.url, proxy.token, '/v1/messages/count_tokens', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'count-session' }) }, messages: [] }, { 'x-claude-code-session-id': 'count-session' });
    assert.equal(response.status, 200); await response.text(); assert.equal(classified, 0);
    assert.equal(upstream.requests[0]?.body.model, 'claude-opus-5');
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('explicit traffic passes unchanged and oversized bodies are rejected before upstream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const upstream = await fixtureUpstream();
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { throw new Error('unused'); }, upstreams: { claude: upstream.url }, maxBodyBytes: 256 });
  try {
    const explicit = { model: 'claude-opus-5', output_config: { effort: 'max' }, messages: [] };
    const ok = await call(proxy.url, proxy.token, '/v1/messages', explicit); assert.equal(ok.status, 200); await ok.text();
    assert.deepEqual(upstream.requests[0]?.body, explicit);
    const large = await call(proxy.url, proxy.token, '/v1/messages', { model: 'claude-opus-5', value: 'x'.repeat(1000) });
    assert.equal(large.status, 413); assert.equal(upstream.requests.length, 1);
  } finally { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); }
});

test('invalid tokens never reach upstream and redirects are returned without following', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.writeHead(307, { location: '/credential-sink' }); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { throw new Error('unused'); }, upstreams: { claude: `http://127.0.0.1:${address.port}` } });
  try {
    const bad = await call(proxy.url, 'wrong', '/v1/messages', { model: 'claude-opus-5' });
    assert.equal(bad.status, 401); assert.equal(requests, 0);
    const redirected = await call(proxy.url, proxy.token, '/v1/messages', { model: 'claude-opus-5' });
    assert.equal(redirected.status, 307); assert.equal(requests, 1);
  } finally { await proxy.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('client disconnect cancels the upstream stream and close handles active work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  let upstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"started"}\n\n');
    res.on('close', upstreamClosed);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { throw new Error('unused'); }, upstreams: { claude: `http://127.0.0.1:${address.port}` } });
  try {
    await new Promise<void>((resolve, reject) => {
      const target = new URL('/v1/messages', proxy.url);
      const request = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: proxy.token } }, response => {
        response.once('data', () => { response.destroy(); resolve(); });
      });
      request.on('error', reject); request.end(JSON.stringify({ model: 'claude-opus-5' }));
    });
    await Promise.race([closed, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 2000))]);
    await proxy.close();
  } finally { await proxy.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('usage survives a native client disconnect immediately after the final response event', async t => {
  const root = await mkdtemp(join(tmpdir(), 'router-final-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":80},"output_tokens":3}}}\n\n');
    // The native consumer considers this complete and can disconnect before EOF.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === 'object');
  const proxy = await startProxy({ tool: 'codex', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async () => ({ taskType: 'edit', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: .99, effort: .99, context: .99, taskType: .99 } }),
    upstreams: { codexApi: `http://127.0.0.1:${address.port}` } });
  t.after(proxy.close);
  await new Promise<void>((resolve, reject) => {
    const request = http.request(new URL('/responses', proxy.url), { method: 'POST', headers: { [TOKEN_HEADER]: proxy.token } }, response => {
      response.once('data', () => { response.destroy(); resolve(); });
    });
    request.on('error', reject);
    request.end(JSON.stringify({ model: 'switchboard', input: [{ role: 'user', content: 'task' }],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'completed', turn_id: 't1', request_kind: 'turn' }) } }));
  });
  await proxy.close();
  assert.deepEqual(await new UsageStore(root).load('codex', 'completed'), {
    totalInputTokens: 120, cachedInputTokens: 80, cacheWriteTokens: null, outputTokens: 3,
  });
});

for (const [status, type] of [[200, 'response.created'], [429, 'response.completed']] as const) {
  test(`early disconnect does not save usage from an incomplete or unsuccessful response (${status}/${type})`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'router-partial-usage-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume */ }
      res.writeHead(status, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type, response: { usage: { input_tokens: 100, output_tokens: 1 } } })}\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address(); assert(address && typeof address === 'object');
    const proxy = await startProxy({ tool: 'codex', root, policy: defaultPolicy, catalog: bundledCatalog,
      classify: async () => ({ taskType: 'edit', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: .99, effort: .99, context: .99, taskType: .99 } }),
      upstreams: { codexApi: `http://127.0.0.1:${address.port}` } });
    t.after(proxy.close);
    await new Promise<void>((resolve, reject) => {
      const request = http.request(new URL('/responses', proxy.url), { method: 'POST', headers: { [TOKEN_HEADER]: proxy.token } }, response => {
        response.once('data', () => { response.destroy(); resolve(); });
      });
      request.on('error', reject);
      request.end(JSON.stringify({ model: 'switchboard', input: [{ role: 'user', content: 'task' }],
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'partial', turn_id: 't1', request_kind: 'turn' }) } }));
    });
    await proxy.close();
    assert.equal(await new UsageStore(root).load('codex', 'partial'), null);
  });
}

test('proxy negotiates readable usage streams when a native client accepts gzip', async t => {
  const root = await mkdtemp(join(tmpdir(), 'router-encoding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stream = 'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":15,"cache_creation_input_tokens":5}}}\n\n'
    + 'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\ndata: {"type":"message_stop"}\n\n';
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    const compressed = req.headers['accept-encoding'] !== 'identity';
    res.writeHead(200, { 'content-type': 'text/event-stream', ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
    res.end(compressed ? gzipSync(stream) : stream);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address === 'object');
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async () => ({ taskType: 'edit', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: .99, effort: .99, context: .99, taskType: .99 } }),
    upstreams: { claude: `http://127.0.0.1:${address.port}` } });
  t.after(proxy.close);
  await call(proxy.url, proxy.token, '/_router/turn', { session_id: 'encoding', prompt_id: 'p1', prompt: 'task' });
  const result = await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard',
    metadata: { user_id: JSON.stringify({ session_id: 'encoding' }) }, messages: [{ role: 'user', content: 'task' }] }, { 'accept-encoding': 'gzip' });
  await proxy.close();
  assert.equal(result.status, 200);
  assert.deepEqual(await new UsageStore(root).load('claude', 'encoding'), {
    totalInputTokens: 22, cachedInputTokens: 15, cacheWriteTokens: 5, outputTokens: 3,
  });
  assert.equal(await result.text(), stream);
});

test('client disconnect before upstream headers cancels provider work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  let seen!: () => void; const upstreamSeen = new Promise<void>(resolve => { seen = resolve; });
  let closed!: () => void; const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
  const server = http.createServer(async (req, res) => { res.on('close', closed); for await (const _ of req) { /* consume */ } seen(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object');
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { throw new Error('unused'); }, upstreams: { claude: `http://127.0.0.1:${address.port}` } });
  try {
    const request = http.request(new URL('/v1/messages', proxy.url), { method: 'POST', headers: { [TOKEN_HEADER]: proxy.token } });
    request.on('error', () => {}); request.end(JSON.stringify({ model: 'claude-opus-5' }));
    await upstreamSeen; request.destroy();
    await Promise.race([upstreamClosed, new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('pre-header upstream was not cancelled')), 2000))]);
  } finally { await proxy.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('shutdown cancels clients stalled in request-body upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-proxy-'));
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog, classify: async () => { throw new Error('unused'); } });
  const target = new URL(proxy.url);
  const socket = net.connect(Number(target.port), target.hostname);
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.write(`POST /v1/messages HTTP/1.1\r\nHost: ${target.host}\r\n${TOKEN_HEADER}: ${proxy.token}\r\nContent-Length: 100\r\n\r\n{`);
  await Promise.race([proxy.close(), new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('shutdown did not drain partial body')), 2000))]);
  socket.destroy(); await rm(root, { recursive: true, force: true });
});

test('ownership collision gives safe recovery guidance, preserves lock, and never forwards', async t => {
  const root = await mkdtemp(join(tmpdir(), 'router-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new Ownership(root, 'PRIVATE-owner');
  await owner.acquire('claude', 'collision');
  t.after(() => owner.close());
  const lock = join(root, 'native-locks', (await readdir(join(root, 'native-locks')))[0]!);
  const before = await readFile(lock, 'utf8');
  const upstream = await fixtureUpstream();
  t.after(upstream.close);
  let classifications = 0;
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async () => { classifications++; throw new Error('PRIVATE-classifier'); }, upstreams: { claude: upstream.url } });
  t.after(proxy.close);
  const response = await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'collision' }) }, tools: [], messages: [] });
  assert.equal(response.status, 409);
  const message = await response.text();
  assert.match(message, /already owned by another router process/i);
  assert.match(message, /remove.*lock.*after verifying.*no longer running/i);
  assert.doesNotMatch(message, /PRIVATE|router-collision-/);
  assert.equal(await readFile(lock, 'utf8'), before);
  assert.equal(classifications, 0);
  assert.equal(upstream.requests.length, 0);
});

test('unexpected ownership filesystem errors remain generic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'router-private-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'native-locks'), 'PRIVATE-filesystem');
  const upstream = await fixtureUpstream();
  t.after(upstream.close);
  const proxy = await startProxy({ tool: 'claude', root, policy: defaultPolicy, catalog: bundledCatalog,
    classify: async () => { throw new Error('PRIVATE-classifier'); }, upstreams: { claude: upstream.url } });
  t.after(proxy.close);
  const response = await call(proxy.url, proxy.token, '/v1/messages', { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'failure' }) }, tools: [], messages: [] });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /Router request failed/);
  assert.doesNotMatch(await response.text(), /PRIVATE|router-private-failure-|EEXIST|ENOTDIR/);
  assert.equal(upstream.requests.length, 0);
});
