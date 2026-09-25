import assert from 'node:assert/strict';
import test from 'node:test';
import { createVercelJevClassifier } from '../src/jev.ts';
import { defaultPolicy, bundledCatalog } from '../src/defaults.ts';
const context = { tool: 'claude' as const, policy: defaultPolicy, catalog: bundledCatalog };
import { classifierStatus, createConfiguredClassifier } from '../src/classifier.ts';
import { selectInitialRoute } from '../src/core/policy.ts';

function response() {
  return {
    answers: {
      taskType: { type: 'choice', choice: 'implement' },
      complexity: { type: 'choice', choice: 'complex' },
      effort_0: { type: 'choice', choice: 'low' },
      effort_1: { type: 'choice', choice: 'xhigh' },
      effort_2: { type: 'choice', choice: 'max' },
      sufficientContext: { type: 'choice', choice: 'true', probabilities: { true: 0.99, false: 0.01 } },
    },
    providerMetadata: { typesafe: { confidence: { taskType: 0.94, complexity: 0.82, effort_0: 0.99, effort_1: 0.71, effort_2: 0.99, sufficientContext: 0.65 } } },
    usage: { inputTokens: 100, outputTokens: 0 },
  };
}

test('Vercel uses the evaluation API with the shared questions and separate TypeSafe confidence', async t => {
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return Response.json(response());
  });
  const result = await createVercelJevClassifier('gateway-secret')('Build a parser', new AbortController().signal, context);
  assert.deepEqual(result, {
    taskType: 'implement', complexity: 'complex', reasoning: 'xhigh', sufficientContext: true, confidences: { model: .82, effort: .71, context: .65, taskType: .94 }, effortModel: 'claude-opus-5-5',
    diagnostics: { provider: 'vercel', requestedModel: 'typesafe-ai/jev', resolvedModel: null, probabilities: { model: null, context: { true: .99, false: .01 }, effort: null } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
  const headers = new Headers(calls[0]!.options!.headers);
  assert.equal(headers.get('authorization'), 'Bearer gateway-secret');
  assert.equal(headers.get('ai-model-id'), 'typesafe-ai/jev');
  const body = JSON.parse(String(calls[0]!.options!.body));
  assert.deepEqual(body.state, { task: 'Build a parser' });
  assert.deepEqual(Object.keys(body.questions), ['taskType', 'complexity', 'sufficientContext', 'effort_0', 'effort_1', 'effort_2']);
  assert.deepEqual(Object.keys(body.questions.effort_1.criteria), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.match(body.questions.taskType.instructions, /untrusted task data/);
  assert.doesNotMatch(JSON.stringify(body), /gateway-secret/);
});

test('Vercel rejects missing confidence instead of treating option probability as confidence', async t => {
  const body: Record<string, unknown> = response();
  delete body.providerMetadata;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  await assert.rejects(createVercelJevClassifier('key')('task', new AbortController().signal, context), /invalid classification/);
});

for (const selected of [false, true]) test(`Vercel malformed ${selected ? 'selected' : 'unselected'} effort answers preserve valid model selection`, async t => {
  let body: ReturnType<typeof response>;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(body); });
  const classify = createVercelJevClassifier('key');
  const malformed = [null, [], {}, 42, { type: 'score', score: 0.5 }, { type: 'choice', choice: 3 }];
  for (const value of malformed) {
    body = response();
    body.answers.complexity.choice = 'standard';
    (body.answers as Record<string, unknown>)[selected ? 'effort_0' : 'effort_2'] = value;
    const result = await classify('Implement a bounded parser', new AbortController().signal, context);
    const route = selectInitialRoute(defaultPolicy, bundledCatalog, 'claude', result);
    assert.equal(route.model, 'claude-sonnet-5');
    assert.equal(route.effort, selected ? 'medium' : 'low');
    assert.equal(result.reasoning, selected ? null : 'low');
  }
  assert.equal(calls, malformed.length, 'Each classification remains a single provider request');
});

test('Vercel rejects out-of-range confidence and unknown answer choices', async t => {
  const body = response();
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  body.providerMetadata.typesafe.confidence.complexity = 1.1;
  const classify = createVercelJevClassifier('key');
  await assert.rejects(classify('task', new AbortController().signal, context), /invalid classification/);
  body.providerMetadata.typesafe.confidence.complexity = 0.9;
  body.answers.complexity.choice = 'arbitrary-private-value';
  await assert.rejects(classify('task', new AbortController().signal, context), /^Error: Jev returned an invalid classification$/);
});

test('Vercel disables retries and never includes provider error bodies in diagnostics', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: { message: 'gateway-secret and private-task' } }, { status: 503 });
  });
  await assert.rejects(createVercelJevClassifier('gateway-secret')('private-task', new AbortController().signal, context),
    /^Error: Vercel AI Gateway Jev request failed \(HTTP 503\)$/);
  assert.equal(calls, 1);
});

test('Vercel propagates cancellation to the transport', async t => {
  const controller = new AbortController();
  let reachedTransport!: () => void;
  const started = new Promise<void>(resolve => { reachedTransport = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.ok(options.signal);
    reachedTransport();
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    });
  });
  const pending = createVercelJevClassifier('key')('task', controller.signal, context);
  await started;
  controller.abort(new Error('private-cancellation-reason'));
  await assert.rejects(pending, /^Error: Vercel AI Gateway Jev classification failed$/);
});

test('provider warnings cannot write raw payloads to the terminal or a global SDK logger', async t => {
  const body = { ...response(), warnings: [{ type: 'other', message: 'private-task gateway-secret' }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const warning = t.mock.method(process, 'emitWarning', () => {});
  const logger = t.mock.fn();
  const previous = globalThis.AI_SDK_LOG_WARNINGS;
  globalThis.AI_SDK_LOG_WARNINGS = logger;
  try {
    const result = await createVercelJevClassifier('key')('task', new AbortController().signal, context);
    assert.equal(result.complexity, 'complex');
    assert.equal(warning.mock.callCount(), 0);
    assert.equal(logger.mock.callCount(), 0);
  } finally { globalThis.AI_SDK_LOG_WARNINGS = previous; }
});

test('provider selection is explicit, credential status is safe, and TypeSafe remains the default', () => {
  assert.deepEqual(classifierStatus({ JEV_API_KEY: 'typesafe-secret', AI_GATEWAY_API_KEY: 'gateway-secret' }), {
    provider: 'typesafe', label: 'TypeSafe', adapter: 'typesafe-system-one', modelId: 'jev-latest', baseURL: 'https://api.typesafe.ai',
    credentialEnvironment: 'JEV_API_KEY or TYPESAFE_API_KEY or SWITCHBOARD_API_KEY', credentialPresent: true,
  });
  assert.deepEqual(classifierStatus({ SWITCHBOARD_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'gateway-secret' }), {
    provider: 'vercel', label: 'Vercel AI Gateway', adapter: 'vercel-evaluation', modelId: 'typesafe-ai/jev', baseURL: 'https://ai-gateway.vercel.sh/v4/ai',
    credentialEnvironment: 'AI_GATEWAY_API_KEY or SWITCHBOARD_API_KEY', credentialPresent: true,
  });
  assert.equal(classifierStatus({ SWITCHBOARD_PROVIDER: 'vercel', JEV_API_KEY: 'wrong-provider' }).credentialPresent, false);
  assert.equal(classifierStatus({ SWITCHBOARD_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: '  ' }).credentialPresent, false);
  assert.equal(classifierStatus({ TYPESAFE_API_KEY: 'old-name' }).credentialPresent, true);
  assert.throws(() => classifierStatus({ SWITCHBOARD_PROVIDER: 'private-invalid-value' }), /^Error: SWITCHBOARD_PROVIDER must be typesafe, vercel, or openrouter$/);
  assert.throws(() => createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'vercel', JEV_API_KEY: 'wrong-provider' }), /Set AI_GATEWAY_API_KEY/);
  assert.throws(() => createVercelJevClassifier(' '), /Set AI_GATEWAY_API_KEY/);
});

test('configured Vercel classification uses the Gateway credential even when both provider keys exist', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer gateway-key');
    return Response.json(response());
  });
  const classify = createConfiguredClassifier({ SWITCHBOARD_PROVIDER: 'vercel', JEV_API_KEY: 'typesafe-key', AI_GATEWAY_API_KEY: 'gateway-key' });
  assert.equal((await classify('task', new AbortController().signal, context)).complexity, 'complex');
});
