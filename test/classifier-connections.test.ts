import assert from 'node:assert/strict';
import test from 'node:test';
import { classifierStatus, createConfiguredClassifier } from '../src/classifier.ts';
import { defaultPolicy, bundledCatalog } from '../src/defaults.ts';
import { parseDiagnostics } from '../src/core/classification-diagnostics.ts';

const context = { tool: 'claude' as const, policy: defaultPolicy, catalog: bundledCatalog };
function response() {
  const answer = (choice: string) => ({ type: 'choice', choice, confidence: .95 });
  return {
    id: 'private-response-id', provider: 'private-provider', model: 'typesafe/jev-1.13-20260917',
    answers: { taskType: answer('implement'), complexity: answer('standard'), sufficientContext: answer('true'), effort_0: answer('low') },
    usage: { input_tokens: 100, output_tokens: 10, inputTokens: 100, outputTokens: 10, cost: .00003 },
    providerMetadata: { typesafe: { confidence: { taskType: .95, complexity: .95, sufficientContext: .95, effort_0: .95 } } },
  };
}

test('OpenRouter preset sends one System One request with its own credential and safe provenance', async t => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(response());
  });
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'openrouter-secret', JEV_API_KEY: 'wrong-provider' });
  const result = await classify('private-task', new AbortController().signal, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer openrouter-secret');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, { task: 'private-task' });
  assert.deepEqual(Object.keys(body.questions), ['taskType', 'complexity', 'sufficientContext', 'effort_0', 'effort_1', 'effort_2']);
  assert.equal(result.effortModel, 'claude-sonnet-5');
  assert.equal(result.reasoning, 'low');
  assert.equal(result.diagnostics?.provider, 'openrouter');
  assert.equal(result.diagnostics?.resolvedModel, 'typesafe/jev-1.13-20260917');
  assert.doesNotMatch(JSON.stringify(result), /private-|secret|cost|input_tokens/);
});

for (const [provider, suffix, selectedModel] of [
  ['typesafe', '/v1/systemone', 'future-jev-2'],
  ['openrouter', '/v1/systemone', 'typesafe/jev-1.13'],
  ['vercel', '/evaluation-model', 'typesafe-ai/jev'],
]) test(`${provider} generic overrides configure its actual adapter request`, async t => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(response()); });
  const env = { SWITCHBOARD_PROVIDER: provider, SWITCHBOARD_BASE_URL: 'https://gateway.example/custom/', SWITCHBOARD_MODEL: selectedModel,
    SWITCHBOARD_API_KEY: 'override-secret', JEV_API_KEY: 'direct-secret', TYPESAFE_API_KEY: 'typesafe-secret',
    OPENROUTER_API_KEY: 'openrouter-secret', AI_GATEWAY_API_KEY: 'vercel-secret' };
  const status = classifierStatus(env);
  assert.equal(status.baseURL, 'https://gateway.example/custom');
  assert.equal(status.modelId, selectedModel);
  assert.doesNotMatch(JSON.stringify(status), /secret/);
  const result = await createConfiguredClassifier(env)('task', new AbortController().signal, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://gateway.example/custom${suffix}`);
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer override-secret');
  if (provider === 'vercel') assert.equal(new Headers(calls[0]!.init.headers).get('ai-model-id'), selectedModel);
  else assert.equal(JSON.parse(String(calls[0]!.init.body)).model, selectedModel);
  assert.equal(result.reasoning, 'low');
});

test('explicit environment controls the direct endpoint without hidden ambient SDK overrides', async t => {
  const previous = process.env.TYPESAFE_BASE_URL;
  process.env.TYPESAFE_BASE_URL = 'https://ambient-private.example';
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = previous; });
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => { urls.push(url); return Response.json(response()); });
  await createConfiguredClassifier({ TYPESAFE_API_KEY: 'key' })('task', new AbortController().signal, context);
  await createConfiguredClassifier({ TYPESAFE_API_KEY: 'key', TYPESAFE_BASE_URL: 'https://explicit.example/api' })('task', new AbortController().signal, context);
  assert.deepEqual(urls, ['https://api.typesafe.ai/v1/systemone', 'https://explicit.example/api/v1/systemone']);
  await createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'key', TYPESAFE_BASE_URL: 'https://wrong-provider.example' })('task', new AbortController().signal, context);
  assert.deepEqual(urls, ['https://api.typesafe.ai/v1/systemone', 'https://explicit.example/api/v1/systemone', 'https://openrouter.ai/api/v1/systemone']);
});

test('URLs reject embedded secrets and insecure remote transport without echoing input', () => {
  for (const baseURL of ['https://private-user:private-password@example.com', 'https://example.com?key=private-key',
    'https://example.com#private-fragment', 'http://remote-private.example', 'file:///private-secret', 'private-invalid-url']) {
    assert.throws(() => classifierStatus({ SWITCHBOARD_BASE_URL: baseURL }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(String(error), /private-|remote-private/);
      assert.match(String(error), /base URL/i);
      return true;
    });
  }
  for (const baseURL of ['http://localhost:3000/api', 'http://127.0.0.1:3000/api', 'http://[::1]:3000/api']) {
    assert.equal(classifierStatus({ SWITCHBOARD_BASE_URL: baseURL }).baseURL, baseURL);
  }
});

test('OpenRouter credentials are required independently of other providers', () => {
  assert.equal(classifierStatus({ SWITCHBOARD_PROVIDER: 'openrouter', TYPESAFE_API_KEY: 'wrong-secret' }).credentialPresent, false);
  assert.throws(() => createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'openrouter', TYPESAFE_API_KEY: 'wrong-secret' }), /OPENROUTER_API_KEY/);
});

test('OpenRouter transport failures are private and never retried', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { message: 'private-task openrouter-secret' } }, { status: 503 }); });
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'openrouter-secret' });
  await assert.rejects(classify('private-task', new AbortController().signal, context), /^Error: Jev classification failed$/);
  assert.equal(calls, 1);
});

test('OpenRouter model diagnostics accept documented model forms and drop arbitrary payloads', () => {
  for (const modelId of ['jev-1.13', 'jev-latest', 'typesafe/jev-1.13', 'typesafe/jev-1.13-20260917', '~typesafe/jev-latest']) {
    const parsed = parseDiagnostics({ provider: 'openrouter', requestedModel: modelId, resolvedModel: modelId });
    assert.equal(parsed?.requestedModel, modelId);
    assert.equal(parsed?.resolvedModel, modelId);
  }
  for (const modelId of ['private-secret', 'typesafe/jev-private-secret', 'typesafe/jev-1.13?key=secret', 'typesafe/jev-1.13\nprivate', '~typesafe/jev-latest-private']) {
    const parsed = parseDiagnostics({ provider: 'openrouter', requestedModel: modelId, resolvedModel: modelId, apiKey: 'private-key' });
    assert.equal(parsed?.requestedModel, null);
    assert.equal(parsed?.resolvedModel, null);
    assert.doesNotMatch(JSON.stringify(parsed), /private|secret/);
  }
});

test('model overrides reject terminal controls without echoing the configured value', () => {
  for (const provider of ['typesafe', 'openrouter', 'vercel']) {
    for (const modelId of ['private-model\u001b[31m', 'private-model\nprivate-line', 'private model']) {
      assert.throws(() => classifierStatus({ SWITCHBOARD_PROVIDER: provider, SWITCHBOARD_MODEL: modelId }), error => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(String(error), /private-/);
        assert.match(String(error), /model ID/);
        return true;
      });
    }
  }
});

test('direct credential aliases preserve priority and model overrides beat the SDK alias', async t => {
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { calls.push(init); return Response.json(response()); });
  const env = { JEV_API_KEY: 'jev-key', TYPESAFE_API_KEY: 'typesafe-key', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0', SWITCHBOARD_MODEL: 'jev-1.14' };
  await createConfiguredClassifier(env)('task', new AbortController().signal, context);
  assert.equal(new Headers(calls[0]!.headers).get('authorization'), 'Bearer jev-key');
  assert.equal(JSON.parse(String(calls[0]!.body)).model, 'jev-1.14');
});

test('OpenRouter cancellation reaches the TypeSafe transport and hides the abort reason', async t => {
  const controller = new AbortController();
  let reachedTransport!: () => void;
  const started = new Promise<void>(resolve => { reachedTransport = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    reachedTransport();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  });
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'openrouter-key' });
  const pending = classify('private-task', controller.signal, context);
  await started;
  controller.abort(new Error('private-abort-reason'));
  await assert.rejects(pending, /^Error: Jev classification failed$/);
});
