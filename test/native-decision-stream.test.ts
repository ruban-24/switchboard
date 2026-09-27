import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionStream } from '../src/native/decision-stream.ts';
import type { Decision } from '../src/core/types.ts';

const decision: Decision = { conversationId: 'c', turnId: 't', tool: 'codex', selection: { model: 'gpt-6-sol', effort: 'high', profile: null }, classification: null, recommendation: null, reason: 'uncertain', policyId: 'p', at: 'now' };

test('routing display preserves split UTF-8 provider bytes and inserts only one local notice', () => {
  const created = Buffer.from('event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n');
  const answer = Buffer.from('data: {"type":"response.output_text.delta","delta":"hello 🌍"}\n\n');
  const stream = new DecisionStream(decision);
  const input = Buffer.concat([created, answer]);
  const output = Buffer.concat([...input].map(byte => stream.push(Buffer.from([byte]))).concat(stream.finish()));
  assert.ok(output.subarray(0, created.length).equals(created));
  assert.ok(output.subarray(-answer.length).equals(answer));
  const items = output.toString().split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  const notice = items.filter(item => item.type === 'response.output_item.done');
  assert.equal(notice.length, 1);
  assert.match(notice[0].item.id, /^msg_[a-zA-Z0-9_]{1,60}$/, 'Codex replays this item to the Responses API');
  const added = items.find(item => item.type === 'response.output_item.added');
  const delta = items.find(item => item.type === 'response.output_text.delta' && item.item_id);
  assert.equal(added.item.id, notice[0].item.id);
  assert.equal(delta.item_id, notice[0].item.id);
  assert.match(notice[0].item.content[0].text, /uncertain classification; conservative fallback/);
});

test('error, malformed, incomplete and oversized initial frames pass through without a route notice', () => {
  const created = Buffer.from('data: {"type":"response.created"}\n\n');
  const oversizedCreated = Buffer.from(`data: ${JSON.stringify({ type: 'response.created', padding: 'x'.repeat(70 * 1024) })}\n\n`);
  for (const input of [Buffer.from('data: {"type":"error"}\n\n'), Buffer.from('not SSE\n\n'), Buffer.from('data: incomplete'), Buffer.alloc(70 * 1024, 'x'), oversizedCreated]) {
    const stream = new DecisionStream(decision);
    assert.deepEqual(Buffer.concat([stream.push(input), stream.finish()]), input);
    assert.equal(stream.finish().length, 0);
    assert.deepEqual(stream.push(created), created, 'A finished stream cannot invent a later notice');
  }
});

test('route notice distinguishes uncertain effort from a stronger-model fallback', () => {
  const stream = new DecisionStream({ ...decision, selection: { profile: 'codex-terra', model: 'gpt-5.6-terra', effort: 'medium' }, adjustments: ['effort-default'] });
  const output = stream.push(Buffer.from('data: {"type":"response.created"}\n\n')).toString();
  assert.match(output, /effort confidence below threshold/i);
  assert.doesNotMatch(output, /conservative fallback/i);
});
