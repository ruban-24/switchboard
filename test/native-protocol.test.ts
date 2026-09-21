import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRoute, claudeConversationSignature, parseNativeRequest } from '../src/native/protocol.ts';

test('the Switchboard alias routes without changing explicit provider models', () => {
  for (const tool of ['claude', 'codex'] as const) {
    const path = tool === 'claude' ? '/v1/messages' : '/responses';
    const selection = { profile: 'balanced', model: tool === 'claude' ? 'claude-sonnet-5' : 'gpt-5.6-terra', effort: 'medium' as const };
    const payload = tool === 'claude'
      ? { metadata: { user_id: JSON.stringify({ session_id: 'saved-session' }) }, messages: [{ role: 'user', content: 'continue' }] }
      : { client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'saved-session', turn_id: 'next', request_kind: 'turn' }) }, input: [{ role: 'user', content: 'continue' }] };
    const body = { ...payload, model: 'switchboard' };
    const parsed = parseNativeRequest(tool, path, {}, body);
    assert.equal(parsed.automatic, true);
    assert.equal(parsed.conversationId, 'saved-session');
    assert.equal(parsed.kind, 'user');
    const routed = applyRoute(tool, path, body, selection);
    assert.equal(routed.model, selection.model);
    assert.equal((routed[tool === 'claude' ? 'output_config' : 'reasoning'] as { effort: string }).effort, 'medium');
    assert.equal(body.model, 'switchboard');
    const explicit = { ...payload, model: selection.model };
    assert.equal(parseNativeRequest(tool, path, {}, explicit).automatic, false);
    assert.equal(applyRoute(tool, path, explicit, selection), explicit);
  }
});

test('Codex uses canonical logical identity and extracts only the last user task', () => {
  const meta = { session_id: 'session-a', thread_id: 'thread-a', turn_id: 'turn-a', request_kind: 'turn', thread_source: 'user' };
  const parsed = parseNativeRequest('codex', '/responses', { 'thread-id': 'thread-a', 'x-codex-turn-metadata': JSON.stringify(meta) }, {
    model: 'switchboard', instructions: 'private instructions', client_metadata: { session_id: 'session-a', thread_id: 'thread-a', turn_id: 'turn-a', 'x-codex-turn-metadata': JSON.stringify(meta) },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'earlier' }] }, { type: 'function_call_output', output: 'secret output' }, { role: 'user', content: [{ type: 'input_text', text: 'fix the race' }] }],
  });
  assert.deepEqual(parsed, { automatic: true, conversationId: 'thread-a', turnId: 'turn-a', kind: 'user', task: 'fix the race', endpoint: 'responses' });
});

test('Codex rejects disagreeing identity projections', () => {
  const meta = { thread_id: 'canonical', turn_id: 't', request_kind: 'turn' };
  assert.throws(() => parseNativeRequest('codex', '/responses', { 'thread-id': 'other' }, {
    model: 'switchboard', client_metadata: { 'x-codex-turn-metadata': JSON.stringify(meta) }, input: [],
  }), /identity projections disagree/i);
});

test('Codex rejects disagreement between canonical body and header metadata', () => {
  const bodyMeta = { thread_id: 'body-thread', turn_id: 'body-turn', request_kind: 'turn' };
  const headerMeta = { thread_id: 'header-thread', turn_id: 'body-turn', request_kind: 'turn' };
  assert.throws(() => parseNativeRequest('codex', '/responses', { 'x-codex-turn-metadata': JSON.stringify(headerMeta) }, { model: 'switchboard', client_metadata: { 'x-codex-turn-metadata': JSON.stringify(bodyMeta) } }), /projections disagree/i);
});

test('Codex rejects future automatic request kinds', () => {
  const meta = { thread_id: 'thread', turn_id: 'turn', request_kind: 'future-unknown' };
  assert.equal(parseNativeRequest('codex', '/responses', {}, { model: 'switchboard', client_metadata: { 'x-codex-turn-metadata': JSON.stringify(meta) } }).kind, 'unknown');
});

test('Codex title detection requires system origin and the native naming instruction', () => {
  const instructions = 'Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb.';
  for (const source of ['system', 'user', undefined]) {
    for (const instruction of [instructions, 'Review the code.']) {
      const meta = { thread_id: 'thread', turn_id: 'turn', request_kind: 'turn', thread_source: source };
      for (const inHeader of [false, true]) {
        const result = parseNativeRequest('codex', '/responses', inHeader ? { 'x-codex-turn-metadata': JSON.stringify(meta) } : {}, {
          model: 'switchboard', instructions: instruction,
          client_metadata: inHeader ? {} : { 'x-codex-turn-metadata': JSON.stringify(meta) },
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Generate a concise, single-line task title of at most 36 characters' }] }],
        });
        const title = source === 'system' && instruction === instructions;
        assert.equal(result.kind, title ? 'auxiliary' : 'user');
        assert.equal(result.auxiliaryType, title ? 'title' : undefined);
      }
    }
  }
});

test('Codex recognizes the observed system title with its naming instruction in user-role input', () => {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb.\n\nTask: reverse a linked list' }] }];
  for (const source of ['system', 'user']) {
    const result = parseNativeRequest('codex', '/responses', {}, { model: 'switchboard', instructions: 'You are a coding agent.', input,
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread', turn_id: 'turn', request_kind: 'turn', thread_source: source }) } });
    assert.equal(result.kind, source === 'system' ? 'auxiliary' : 'user');
    assert.equal(result.auxiliaryType, source === 'system' ? 'title' : undefined);
  }
});

test('Claude tool result tails are continuations and human text is isolated', () => {
  const base = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 's' }) } };
  const continuation = parseNativeRequest('claude', '/v1/messages', {}, { ...base, messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'private' }] }] });
  assert.equal(continuation.kind, 'auxiliary');
  const main = parseNativeRequest('claude', '/v1/messages', {}, { ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'do it\n<system-reminder>noise</system-reminder>' }] }] });
  assert.equal(main.task, 'do it');
});

test('Claude locates human text before observed trailing token metadata', () => {
  const parsed = parseNativeRequest('claude', '/v1/messages', {}, { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 's' }) }, messages: [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }, { type: 'text', text: '  fix the issue\n' }] },
    { role: 'system', content: [{ type: 'text', text: '<total_tokens>100 tokens left</total_tokens>', cache_control: { type: 'ephemeral' } }] },
  ] });
  assert.equal(parsed.kind, 'user'); assert.equal(parsed.task, 'fix the issue');
});

test('Claude subscription system trailers do not turn a new user prompt into a continuation', () => {
  const base = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'subscription' }) } };
  const trailer = { role: 'system', content: [{ type: 'text', text: 'Subscription session context', cache_control: { type: 'ephemeral' } }] };
  const main = parseNativeRequest('claude', '/v1/messages', {}, { ...base, messages: [{ role: 'user', content: 'fix the issue' }, trailer] });
  assert.equal(main.kind, 'user');
  assert.equal(main.task, 'fix the issue');
  const continuation = parseNativeRequest('claude', '/v1/messages', {}, { ...base, messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'done' }] }, trailer] });
  assert.equal(continuation.auxiliaryType, 'continuation');
});

test('Claude retry identity keeps images, tool results, and preceding turns distinct', () => {
  const message = { role: 'user', content: [{ type: 'text', text: 'same task' }] };
  const signature = claudeConversationSignature([message]);
  assert.equal(claudeConversationSignature([{ role: 'user', content: 'same task' }]), signature);
  assert.notEqual(claudeConversationSignature([{ role: 'assistant', content: 'prior answer' }, message]), signature);
  assert.notEqual(claudeConversationSignature([{ ...message, content: [...message.content, { type: 'image', source: { data: 'image' } }] }]), signature);
  assert.notEqual(claudeConversationSignature([{ ...message, content: [...message.content, { type: 'tool_result', tool_use_id: 'tool', content: 'result' }] }]), signature);
});

test('Codex identifies helper and compaction traffic without classifying it', () => {
  const helper = { thread_id: 'child', parent_thread_id: 'parent', turn_id: 't', request_kind: 'turn', subagent_kind: 'worker' };
  assert.equal(parseNativeRequest('codex', '/responses', {}, { model: 'switchboard', client_metadata: { 'x-codex-turn-metadata': JSON.stringify(helper) } }).kind, 'auxiliary');
  const compact = { thread_id: 'thread', turn_id: 'c', request_kind: 'compaction' };
  assert.equal(parseNativeRequest('codex', '/responses/compact', {}, { model: 'switchboard', client_metadata: { 'x-codex-turn-metadata': JSON.stringify(compact) } }).kind, 'compact');
});

test('Codex tool output tail is a continuation even when an older user message exists', () => {
  const meta = { thread_id: 'thread', turn_id: 't', request_kind: 'turn' };
  const parsed = parseNativeRequest('codex', '/responses', {}, { model: 'switchboard', client_metadata: { 'x-codex-turn-metadata': JSON.stringify(meta) }, input: [
    { role: 'user', content: [{ type: 'input_text', text: 'old task' }] }, { type: 'function_call_output', output: 'done' },
  ] });
  assert.equal(parsed.kind, 'auxiliary');
  assert.equal(parsed.task, '');
});

test('explicit model traffic remains untouched', () => {
  const body = { model: 'gpt-6-astra', reasoning: { effort: 'max' }, input: [] };
  assert.equal(parseNativeRequest('codex', '/responses', {}, body).automatic, false);
  assert.deepEqual(applyRoute('codex', '/responses', body, { profile: null, model: 'ignored', effort: 'low' }), body);
});

test('Claude requires agreeing session projections', () => {
  const body = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'session-a' }) } };
  assert.equal(parseNativeRequest('claude', '/v1/messages', { 'x-claude-code-session-id': 'session-a' }, body).conversationId, 'session-a');
  assert.throws(() => parseNativeRequest('claude', '/v1/messages', { 'x-claude-code-session-id': 'other' }, body), /identity projections disagree/i);
});

test('Claude count_tokens is auxiliary and does not represent a user turn', () => {
  const body = { model: 'switchboard', metadata: { user_id: JSON.stringify({ session_id: 'session-a' }) }, messages: [{ role: 'user', content: 'task' }] };
  const parsed = parseNativeRequest('claude', '/v1/messages/count_tokens', { 'x-claude-code-session-id': 'session-a' }, body);
  assert.equal(parsed.kind, 'auxiliary');
  assert.equal(parsed.endpoint, 'other');
  assert.equal(parsed.auxiliaryType, undefined);
});

test('route mutation preserves cached content and removes only Haiku-incompatible effort fields', () => {
  const cache = { type: 'ephemeral', ttl: '1h' };
  const body = { model: 'switchboard', system: [{ type: 'text', text: 'prefix', cache_control: cache }], tools: [{ name: 'Run', input_schema: { type: 'object' } }],
    thinking: { type: 'adaptive' }, output_config: { effort: 'high', format: { type: 'json_schema' } },
    context_management: { edits: [{ type: 'clear_tool_uses_20250919' }, { type: 'clear_thinking_20251015' }] } };
  const routed = applyRoute('claude', '/v1/messages', body, { profile: 'haiku', model: 'claude-haiku-4-5-20251001', effort: null });
  assert.deepEqual(routed.system, body.system);
  assert.deepEqual(routed.tools, body.tools);
  assert.equal(routed.thinking, undefined);
  assert.deepEqual(routed.output_config, { format: { type: 'json_schema' } });
  assert.deepEqual(routed.context_management, { edits: [{ type: 'clear_tool_uses_20250919' }] });
});

test('supported Claude and Codex routes set only model and compatible effort fields', () => {
  const claude = applyRoute('claude', '/v1/messages', { model: 'switchboard', output_config: { trace: true }, thinking: { type: 'enabled', budget_tokens: 4096 } }, { profile: 'x', model: 'claude-opus-5', effort: 'xhigh' });
  assert.deepEqual(claude, { model: 'claude-opus-5', output_config: { trace: true, effort: 'xhigh' }, thinking: { type: 'adaptive' } });
  const compact = applyRoute('codex', '/responses/compact', { model: 'switchboard', input: ['cached'] }, { profile: 'x', model: 'gpt-5.6-sol', effort: 'high' });
  assert.deepEqual(compact, { model: 'gpt-5.6-sol', input: ['cached'] });
});

test('Haiku preserves context management properties when no edits exist', () => {
  const routed = applyRoute('claude', '/v1/messages', { model: 'switchboard', context_management: { strategy: 'compact' } }, { profile: 'h', model: 'claude-haiku-4-5-20251001', effort: null });
  assert.deepEqual(routed.context_management, { strategy: 'compact' });
});
