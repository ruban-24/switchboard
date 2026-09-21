import assert from 'node:assert/strict';
import test from 'node:test';
import { Router } from '../src/core/session.ts';
import type { ConversationRepository, TurnInput } from '../src/core/session.ts';
import type { Classification, ConversationState, Tool } from '../src/core/types.ts';
import { catalogFixture, policyFixture } from './fixtures.ts';

const standard: Classification = { taskType: 'implement', complexity: 'standard', reasoning: 'medium', sufficientContext: true, confidences: { model: 0.95, effort: 0.95, context: 0.95, taskType: 0.95 } };
const complex: Classification = { ...standard, taskType: 'debug', complexity: 'complex', reasoning: 'high' };
const first: TurnInput = { conversationId: 'conversation-1', turnId: 'turn-1', tool: 'codex', kind: 'user', task: 'Implement the endpoint' };

test('effort uncertainty is recorded separately and does not suppress a confident stronger follow-up recommendation', async () => {
  let calls = 0;
  const repo = repository();
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: repo,
    classify: async () => ++calls === 1 ? { ...standard, reasoning: 'low', confidences: { ...standard.confidences, effort: .5 } }
      : { ...complex, confidences: { ...complex.confidences, effort: .5 } },
  });
  const initial = await router.routeTurn(first);
  assert.equal(initial.selection.model, 'fixture-standard');
  assert.equal(initial.selection.effort, 'medium');
  assert.deepEqual(initial.adjustments, ['effort-default']);
  assert.deepEqual((await repo.load('codex', first.conversationId))?.lastDecision.adjustments, ['effort-default']);
  const followUp = await router.routeTurn({ ...first, turnId: 'next' });
  assert.equal(followUp.recommendation?.model, 'fixture-strong');
  assert.equal(followUp.selection.model, 'fixture-standard');
});

function repository(): ConversationRepository {
  const states = new Map<string, ConversationState>();
  return {
    async load(tool: Tool, id: string) { return structuredClone(states.get(`${tool}:${id}`) ?? null); },
    async save(state: ConversationState) { states.set(`${state.tool}:${state.conversationId}`, structuredClone(state)); },
  };
}

test('follow-ups retain both model and effort and can recommend a stronger route', async () => {
  let calls = 0;
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: repository(), classify: async () => ++calls === 1 ? standard : complex });
  const initial = await router.routeTurn(first);
  const later = await router.routeTurn({ ...first, turnId: 'turn-2', task: 'Now debug the race condition' });
  assert.deepEqual(later.selection, initial.selection);
  assert.deepEqual(later.recommendation, { profile: 'strong', model: 'fixture-strong', effort: 'high' });
  assert.equal(later.reason, 'pinned');
  assert.equal(Object.hasOwn(later, 'prompt'), false);
});

test('tool continuations and same-turn retries never classify again', async () => {
  let calls = 0;
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: repository(), classify: async () => { calls++; return standard; } });
  const initial = await router.routeTurn(first);
  assert.deepEqual(await router.routeTurn(first), initial);
  const continued = await router.routeTurn({ ...first, kind: 'tool', task: '' });
  assert.deepEqual(continued.selection, initial.selection);
  assert.equal(continued.classification, null);
  assert.equal(calls, 1);
});

test('resuming with a new router instance restores the conversation route', async () => {
  const store = repository();
  const one = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: store, classify: async () => standard });
  await one.routeTurn(first);
  const two = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: store, classify: async () => complex });
  const resumed = await two.routeTurn({ ...first, turnId: 'turn-2', task: 'Continue' });
  assert.equal(resumed.selection.model, 'fixture-standard');
  assert.equal(resumed.selection.effort, 'medium');
});

test('new exclusions affect new conversations while resume retains the existing top-tier model', async () => {
  const store = repository();
  const classify = async (): Promise<Classification> => ({ ...complex, complexity: 'demanding' });
  const one = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: store, classify });
  const initial = await one.routeTurn(first);
  assert.equal(initial.selection.model, 'fixture-top');
  const policy = policyFixture();
  policy.excludedModels.codex = ['fixture-top'];
  const two = new Router({ policy, catalog: catalogFixture(), repository: store, classify });
  const resumed = await two.routeTurn({ ...first, turnId: 'turn-2' });
  assert.deepEqual(resumed.selection, initial.selection);
  assert.equal(resumed.recommendation, null);
  assert.equal((await two.routeTurn({ ...first, conversationId: 'conversation-2' })).selection.model, 'fixture-strong');
});

test('a demanding follow-up recommends the fourth tier without applying it', async () => {
  let calls = 0;
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: repository(),
    classify: async () => ++calls === 1 ? standard : { ...complex, complexity: 'demanding' },
  });
  const initial = await router.routeTurn(first);
  const followUp = await router.routeTurn({ ...first, turnId: 'turn-2' });
  assert.deepEqual(followUp.selection, initial.selection);
  assert.equal(followUp.recommendation?.model, 'fixture-top');
});

test('concurrent first requests for one conversation produce one classification', async () => {
  let calls = 0;
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: repository(), classify: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return standard; } });
  const results = await Promise.all([router.routeTurn(first), router.routeTurn(first)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(calls, 1);
});

test('timeouts abort classification, select fallback initially, and retain an established route', async () => {
  const policy = policyFixture();
  policy.classifier.timeoutMs = 10;
  let receivedSignal: AbortSignal | undefined;
  const router = new Router({ policy, catalog: catalogFixture(), repository: repository(), classify: async (_task, signal) => {
    receivedSignal = signal;
    return await new Promise<Classification>(() => {});
  } });
  const result = await router.routeTurn(first);
  assert.equal(result.selection.model, 'fixture-strong');
  assert.equal(result.reason, 'classifier-unavailable');
  assert.equal(receivedSignal?.aborted, true);
  const followUp = await router.routeTurn({ ...first, turnId: 'turn-2' });
  assert.deepEqual(followUp.selection, result.selection);
  assert.equal(followUp.reason, 'pinned');
});

test('an explicit model selection bypasses classification and remains manual on follow-up', async () => {
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: repository(), classify: async () => { throw new Error('Manual traffic must not call Jev'); } });
  const manual = { profile: null, model: 'user-native-model', effort: 'high' };
  assert.deepEqual((await router.routeTurn({ ...first, manual })).selection, manual);
  assert.deepEqual((await router.routeTurn({ ...first, turnId: 'turn-2' })).selection, manual);
});

test('cancellation never persists or forwards a fallback decision', async () => {
  const store = repository();
  const controller = new AbortController();
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: store, classify: async () => { controller.abort(); return standard; } });
  await assert.rejects(router.routeTurn({ ...first, signal: controller.signal }), /abort/i);
  assert.equal(await store.load('codex', first.conversationId), null);
});

test('cancellation during state loading rejects cached retries and tool continuations', async () => {
  const store = repository();
  const seed = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: store, classify: async () => standard });
  await seed.routeTurn(first);
  for (const kind of ['user', 'tool'] as const) {
    const controller = new AbortController();
    const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), classify: async () => standard,
      repository: {
        async load(tool, id) { const saved = await store.load(tool, id); controller.abort(); return saved; },
        save: state => store.save(state),
      },
    });
    await assert.rejects(router.routeTurn({ ...first, kind, signal: controller.signal }), /abort/i);
  }
});

test('cancellation during persistence never returns a decision to forward', async () => {
  const store = repository();
  const controller = new AbortController();
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), classify: async () => standard,
    repository: {
      load: (tool, id) => store.load(tool, id),
      async save(state) { await store.save(state); controller.abort(); },
    },
  });
  await assert.rejects(router.routeTurn({ ...first, signal: controller.signal }), /abort/i);
  // A route already committed to disk can remain pinned, but is not authorization
  // to send a provider request after the caller has canceled.
  assert.equal((await store.load('codex', first.conversationId))?.selection.model, 'fixture-standard');
});

test('missing conversation identity and orphaned tool continuations fail explicitly', async () => {
  const router = new Router({ policy: policyFixture(), catalog: catalogFixture(), repository: repository(), classify: async () => standard });
  await assert.rejects(router.routeTurn({ ...first, conversationId: '' }), /conversation/i);
  await assert.rejects(router.routeTurn({ ...first, kind: 'tool' }), /state/i);
});
