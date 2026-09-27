import assert from 'node:assert/strict';
import test from 'node:test';
import { classifierStatus, createConfiguredClassifier } from '../src/classifier.ts';
import { defaultPolicy, bundledCatalog } from '../src/defaults.ts';
import { selectInitialRoute } from '../src/core/policy.ts';

const context = { tool: 'claude' as const, policy: defaultPolicy, catalog: bundledCatalog };
// Laya reports normalized entropy as `confidence` and the calibrated top-choice
// probability as `answer_confidence`; the low entropy values prove which one is used.
const answer = (choice: string, answerConfidence = .9) => ({
  type: 'choice', choice, confidence: .05, answer_confidence: answerConfidence, probabilities: {}, action: { act_probability: 1 },
});
function response(answers: Record<string, unknown> = {}) {
  return {
    model: 'laya-rl-agent', usage: { input_tokens: 250, output_tokens: 0 }, routing: { model: 'english', reason: 'private-routing' },
    answers: { taskType: answer('implement'), complexity: answer('standard'), sufficientContext: answer('A'), effort: answer('high'), ...answers },
  };
}

test('Laya sends one short request to the local laya-serve default without a key', async t => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(response()); });
  const result = await createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'laya' })('private-task', new AbortController().signal, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:8000/v1/systemone');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), null);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'english');
  assert.deepEqual(body.state, { task: 'private-task' });
  assert.deepEqual(Object.keys(body.questions), ['taskType', 'complexity', 'sufficientContext', 'effort']);
  assert.deepEqual(Object.keys(body.questions.sufficientContext.criteria), ['A', 'B']);
  assert.doesNotMatch(JSON.stringify(body.questions), /claude|sonnet|opus|fable|haiku|gpt/i);
  assert.deepEqual(result, {
    taskType: 'implement', complexity: 'standard', sufficientContext: true, reasoning: 'high', effortModel: 'claude-sonnet-5',
    confidences: { model: .9, effort: .9, context: .9, taskType: .9 },
  });
  assert.deepEqual(selectInitialRoute(defaultPolicy, bundledCatalog, 'claude', result), { profile: 'claude-sonnet', model: 'claude-sonnet-5', effort: 'high' });
});

test('Laya context labels, low calibrated confidence, and no-effort models normalize like Jev answers', async t => {
  let next = response();
  t.mock.method(globalThis, 'fetch', async () => Response.json(next));
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'laya' });
  next = response({ sufficientContext: answer('B', .72) });
  assert.equal((await classify('task', new AbortController().signal, context)).sufficientContext, false);
  next = response({ complexity: answer('standard', .31), effort: answer('medium', .35) });
  const uncertain = await classify('task', new AbortController().signal, context);
  assert.deepEqual(uncertain.confidences, { model: .31, effort: .35, context: .9, taskType: .9 });
  next = response({ complexity: answer('routine'), effort: answer('max') });
  const routine = await classify('task', new AbortController().signal, context);
  assert.equal(routine.effortModel, 'claude-haiku-4-5-20251001');
  assert.equal(routine.reasoning, null);
  assert.equal(routine.confidences.effort, null);
});

test('Laya rejects answers without a calibrated confidence or with Jev context labels', async t => {
  let next: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(next));
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'laya' });
  for (const answers of [
    { complexity: { type: 'choice', choice: 'standard', confidence: .9 } },
    { complexity: answer('standard', 1.5) },
    { sufficientContext: answer('true') },
    { complexity: answer('private-tier') },
  ]) {
    next = response(answers);
    await assert.rejects(classify('private-task', new AbortController().signal, context), /^Error: Laya returned an invalid classification$/);
  }
  next = { ...response(), answers: { ...response().answers, taskType: undefined, effort: undefined } };
  const partial = await classify('task', new AbortController().signal, context);
  assert.equal(partial.taskType, null);
  assert.equal(partial.reasoning, null);
});

test('a Laya server on another host requires HTTPS and a key; a local server may use either', async t => {
  const headers: (string | null)[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { headers.push(new Headers(init.headers).get('authorization')); return Response.json(response()); });
  const remote = { SWITCHBOARD_PROVIDER: 'laya', SWITCHBOARD_BASE_URL: 'https://laya.internal.example' };
  assert.equal(classifierStatus(remote).credentialRequired, true);
  assert.throws(() => createConfiguredClassifier(remote), /LAYA_API_KEY.*another host/);
  assert.throws(() => classifierStatus({ ...remote, SWITCHBOARD_BASE_URL: 'http://192.168.1.20:8000' }), /HTTPS/);
  await createConfiguredClassifier({ ...remote, LAYA_API_KEY: 'laya-secret' })('task', new AbortController().signal, context);
  await createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'laya', SWITCHBOARD_BASE_URL: 'http://localhost:9000', SWITCHBOARD_API_KEY: 'local-secret' })('task', new AbortController().signal, context);
  assert.deepEqual(headers, ['Bearer laya-secret', 'Bearer local-secret']);
  const local = classifierStatus({ SWITCHBOARD_PROVIDER: 'laya' });
  assert.equal(local.credentialRequired, false);
  assert.equal(local.credentialPresent, false);
  assert.equal(classifierStatus({ SWITCHBOARD_PROVIDER: 'typesafe' }).credentialRequired, true);
});

test('Laya failures are private, include only the HTTP status, and are never retried', async t => {
  let calls = 0;
  let status = 401;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ detail: 'private-task laya-secret' }, { status }); });
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'laya', LAYA_API_KEY: 'laya-secret' });
  await assert.rejects(classify('private-task', new AbortController().signal, context), /^Error: Laya request failed \(HTTP 401\)$/);
  status = 200;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('private-task not json'); });
  await assert.rejects(classify('private-task', new AbortController().signal, context), /^Error: Laya classification failed$/);
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('private-network laya-secret'); });
  await assert.rejects(classify('private-task', new AbortController().signal, context), /^Error: Laya classification failed$/);
  assert.equal(calls, 3);
});

test('Laya cancellation reaches the transport and hides the abort reason', async t => {
  const controller = new AbortController();
  let reachedTransport!: () => void;
  const started = new Promise<void>(resolve => { reachedTransport = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    reachedTransport();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  });
  const pending = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'laya' })('private-task', controller.signal, context);
  await started;
  controller.abort(new Error('private-abort-reason'));
  await assert.rejects(pending, /^Error: Laya classification failed$/);
});

test('a task longer than Laya reads is sent cut and marked as insufficient context', async t => {
  const tasks: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    tasks.push(JSON.parse(String(init.body)).state.task);
    return Response.json(response());
  });
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'laya' });
  assert.equal((await classify('x'.repeat(700), new AbortController().signal, context)).sufficientContext, true);
  const long = await classify('y'.repeat(701), new AbortController().signal, context);
  assert.equal(tasks[1]!.length, 700);
  assert.equal(long.sufficientContext, false);
  assert.equal(selectInitialRoute(defaultPolicy, bundledCatalog, 'claude', long).profile, 'claude-opus');
});

test('an oversized Laya response is abandoned while streaming, before it is buffered', async t => {
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(64 * 1024);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  })));
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'laya' });
  await assert.rejects(classify('task', new AbortController().signal, context), /^Error: Laya classification failed$/);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 6, `read ${pulls} chunks`);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'content-length': String(1024 * 1024) } }));
  await assert.rejects(classify('task', new AbortController().signal, context), /^Error: Laya classification failed$/);
});
