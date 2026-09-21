import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, atomicJsonWrite } from '../src/storage.ts';
import type { ConversationState, Decision } from '../src/core/types.ts';
import { Router } from '../src/core/session.ts';
import { bundledCatalog, defaultPolicy } from '../src/defaults.ts';

const decision: Decision = {
  conversationId: 'session-1', turnId: 'turn-1', tool: 'codex',
  selection: { profile: 'standard', model: 'fixture-standard', effort: 'medium' },
  classification: null, recommendation: null, reason: 'initial', policyId: 'fixture-policy', at: '2026-09-18T00:00:00.000Z',
};

function state(): ConversationState {
  return { version: 1, conversationId: 'session-1', tool: 'codex', selection: decision.selection, manual: false, lastDecision: decision, history: [decision] };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'router-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: new Store(dir) };
}

test('route state survives a new store instance and files are private', async t => {
  const { dir, store } = await fixture(t);
  await store.save(state());
  assert.deepEqual(await new Store(dir).load('codex', 'session-1'), state());
  const files = await readdir(join(dir, 'sessions'));
  assert.equal(files.length, 1);
  assert.equal((await stat(join(dir, 'sessions', files[0]!))).mode & 0o777, 0o600);
});

test('default persistence strips prompts and unknown payload fields', async t => {
  const { dir, store } = await fixture(t);
  const extra = { ...decision, prompt: 'private task', authorization: 'secret', request: { body: 'private request' } };
  await store.save({ ...state(), lastDecision: extra, history: [extra] });
  const file = (await readdir(join(dir, 'sessions')))[0]!;
  const raw = await readFile(join(dir, 'sessions', file), 'utf8');
  for (const secret of ['private task', 'secret', 'private request', 'authorization']) assert.equal(raw.includes(secret), false);
  assert.equal((await store.load('codex', 'session-1'))?.selection.model, 'fixture-standard');
});

test('history bounds and prompt opt-in do not put prompts into route state', async t => {
  const { dir } = await fixture(t);
  const store = new Store(dir, { historyLimit: 2, capturePrompts: true });
  const history = [1, 2, 3].map(n => ({ ...decision, turnId: `turn-${n}`, prompt: `task-${n}` }));
  await store.save({ ...state(), history, lastDecision: history[2]! });
  const restored = await store.load('codex', 'session-1');
  assert.deepEqual(restored?.history.map(d => d.turnId), ['turn-2', 'turn-3']);
  assert.equal(restored?.history[1]?.prompt, 'task-3');
  assert.equal(Object.hasOwn(restored!.lastDecision, 'prompt'), false);
});

test('different conversations and tools cannot overwrite each other', async t => {
  const { store } = await fixture(t);
  const otherDecision = { ...decision, conversationId: 'session-2' };
  await Promise.all([
    store.save(state()),
    store.save({ ...state(), conversationId: 'session-2', lastDecision: otherDecision, history: [otherDecision] }),
  ]);
  assert.equal((await store.load('codex', 'session-1'))?.conversationId, 'session-1');
  assert.equal((await store.load('codex', 'session-2'))?.conversationId, 'session-2');
  assert.equal(await store.load('claude', 'session-1'), null);
});

test('invalid identities and corrupted existing state fail instead of silently rerouting', async t => {
  const { dir, store } = await fixture(t);
  await assert.rejects(store.load('codex', '../../outside'), /identity/i);
  await store.save(state());
  const file = (await readdir(join(dir, 'sessions')))[0]!;
  await writeFile(join(dir, 'sessions', file), '{invalid');
  await assert.rejects(store.load('codex', 'session-1'), /state/i);
});

test('exclusive atomic creation preserves an existing configuration under concurrent init', async t => {
  const { dir } = await fixture(t);
  const file = join(dir, 'policy.json');
  const results = await Promise.allSettled([
    atomicJsonWrite(file, { id: 'one' }, { replace: false }),
    atomicJsonWrite(file, { id: 'two' }, { replace: false }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const original = await readFile(file, 'utf8');
  await assert.rejects(atomicJsonWrite(file, { id: 'three' }, { replace: false }), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['policy.json']);
});

test('max-effort routes survive persistence and remain pinned through lower-demand follow-ups', async t => {
  const { dir } = await fixture(t);
  for (const tool of ['claude', 'codex'] as const) {
    const conversationId = `max-${tool}`;
    const first = new Router({ policy: defaultPolicy, catalog: bundledCatalog, repository: new Store(dir),
      classify: async () => ({ taskType: 'architecture', complexity: 'demanding', reasoning: 'max', sufficientContext: true, confidences: { model: 0.95, effort: 0.95, context: 0.95, taskType: 0.95 } }),
    });
    const initial = await first.routeTurn({ tool, conversationId, turnId: 'first', kind: 'user', task: 'Design the migration' });
    assert.equal(initial.selection.effort, 'max');
    const resumed = new Router({ policy: defaultPolicy, catalog: bundledCatalog, repository: new Store(dir),
      classify: async () => ({ taskType: 'explain', complexity: 'routine', reasoning: 'low', sufficientContext: true, confidences: { model: 0.95, effort: 0.95, context: 0.95, taskType: 0.95 } }),
    });
    const followUp = await resumed.routeTurn({ tool, conversationId, turnId: 'second', kind: 'user', task: 'Summarize it' });
    assert.deepEqual(followUp.selection, initial.selection);
    assert.equal(followUp.reason, 'pinned');
    const restored = await new Store(dir).load(tool, conversationId);
    assert.equal(restored?.history[0]?.classification?.reasoning, 'max');
    assert.equal(restored?.lastDecision.classification?.reasoning, 'low');
    assert.equal(restored?.selection.effort, 'max');
  }
});

test('model-bound no-effort and unavailable-effort decisions round-trip without affecting saved routes', async t => {
  const { dir, store } = await fixture(t);
  for (const [model, effort] of [['claude-haiku-4-5-20251001', null], ['claude-sonnet-5', 'medium']] as const) {
    const classification = { taskType: 'edit' as const, complexity: 'routine' as const, reasoning: null,
      sufficientContext: true, confidences: { model: .9, effort: null, context: .9, taskType: .9 }, effortModel: model };
    const bound: Decision = { ...decision, tool: 'claude', selection: { profile: 'test', model, effort }, classification,
      adjustments: effort === null ? [] : ['effort-unavailable'] };
    await store.save({ ...state(), tool: 'claude', selection: bound.selection, lastDecision: bound, history: [bound] });
    const restored = await new Store(dir).load('claude', 'session-1');
    assert.deepEqual(restored?.lastDecision, bound);
    assert.deepEqual(restored?.selection, bound.selection);
  }
});
