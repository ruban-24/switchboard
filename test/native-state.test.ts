import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ownership } from '../src/native/ownership.ts';
import { UsageStore, UsageParser } from '../src/native/usage-store.ts';

test('cross-process ownership rejects a second owner and permits clean release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-owner-'));
  try {
    const first = new Ownership(root, 'one');
    const second = new Ownership(root, 'two');
    await first.acquire('codex', 'thread-a');
    await assert.rejects(second.acquire('codex', 'thread-a'), /already owned by another router process/i);
    await first.close();
    await second.acquire('codex', 'thread-a');
    await second.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('same owner coalesces concurrent lock acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-owner-'));
  try {
    const owner = new Ownership(root, 'one');
    const results = await Promise.allSettled([owner.acquire('codex', 'thread-a'), owner.acquire('codex', 'thread-a')]);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    await owner.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('usage parser reads split SSE events without retaining provider content', () => {
  const parser = new UsageParser('openai');
  parser.push(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":7},"output_tokens":3},"output":[{"text":"private'));
  parser.push(Buffer.from(' payload"}]}}\n\n'));
  assert.deepEqual(parser.finish(), { totalInputTokens: 10, cachedInputTokens: 7, cacheWriteTokens: null, outputTokens: 3 });
});

test('usage parser keeps a fragmented SSE prefix undecided', () => {
  const parser = new UsageParser('openai');
  parser.push(Buffer.from('ev'));
  parser.push(Buffer.from('ent: response.completed\ndata: {"response":{"usage":{"input_tokens":9,"output_tokens":2}}}\n\n'));
  assert.deepEqual(parser.finish(), { totalInputTokens: 9, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 2 });
});

test('usage parser bounds undecided whitespace before a valid SSE prefix', () => {
  const parser = new UsageParser('openai');
  parser.push(Buffer.from(' '.repeat(262144)));
  parser.push(Buffer.from(' '.repeat(262144)));
  assert.ok((parser as unknown as { pending: string }).pending.length <= 262144);
  parser.push(Buffer.from('data: {"usage":{"input_tokens":4,"output_tokens":1}}\n\n'));
  assert.deepEqual(parser.finish(), { totalInputTokens: 4, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 1 });
});

test('usage parser reads pretty JSON with trailing newlines', () => {
  const parser = new UsageParser('openai', 'application/json');
  parser.push(Buffer.from('{\n  "usage": {"input_tokens": 10, "output_tokens": 2}\n}\n'));
  assert.deepEqual(parser.finish(), { totalInputTokens: 10, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 2 });
});

test('usage store persists only normalized bounded counters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-usage-'));
  try {
    const store = new UsageStore(root);
    await store.save('claude', 'session-a', { totalInputTokens: 12, cachedInputTokens: 5, cacheWriteTokens: 2, outputTokens: null });
    assert.deepEqual(await store.load('claude', 'session-a'), { totalInputTokens: 12, cachedInputTokens: 5, cacheWriteTokens: 2, outputTokens: null });
    const files = await readFile(join(root, 'usage', 'claude-session-a.json'), 'utf8');
    assert.doesNotMatch(files, /payload|content|prompt/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
