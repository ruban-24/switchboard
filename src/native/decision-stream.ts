import { randomUUID } from 'node:crypto';

import type { Decision } from '../core/types.ts';
import { explainDecision } from '../core/explanation.ts';

const FIRST_FRAME_LIMIT = 64 * 1024;

function findDelimiter(buffer: Buffer): { index: number; length: number; newline: string } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4, newline: '\r\n' };
  return { index: lf, length: 2, newline: '\n' };
}

function parseData(frame: Buffer): unknown {
  const data = frame.toString('utf8').split(/\r?\n/)
    .filter(line => line === 'data' || line.startsWith('data:'))
    .map(line => {
      const value = line.slice(5);
      return value.startsWith(' ') ? value.slice(1) : value;
    });
  if (data.length === 0) throw new Error('missing SSE data');
  return JSON.parse(data.join('\n'));
}

function renderNotice(decision: Decision): string {
  const effort = decision.selection.effort ?? 'no effort';
  let text = `[Router] ${decision.selection.model} / ${effort} — ${explainDecision(decision)}.`;
  if (decision.recommendation) {
    const recommendedEffort = decision.recommendation.effort ?? 'no effort';
    text += ` For the recommended ${decision.recommendation.model} / ${recommendedEffort}, start a new conversation.`;
  }
  return text;
}

function encodeEvent(value: { type: string }, newline: string): Buffer {
  return Buffer.from(`event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`, 'utf8');
}

function noticeEvents(decision: Decision, newline: string): Buffer {
  const itemId = `msg_switchboard_${randomUUID().replaceAll('-', '')}`;
  const text = renderNotice(decision);
  const added = { type: 'response.output_item.added', output_index: 0,
    item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [], phase: 'commentary' } };
  const delta = { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text };
  const done = { type: 'response.output_item.done', output_index: 0,
    item: { id: itemId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }], phase: 'commentary' } };
  return Buffer.concat([encodeEvent(added, newline), encodeEvent(delta, newline), encodeEvent(done, newline)]);
}

export class DecisionStream {
  readonly #decision: Decision;
  #pending = Buffer.alloc(0);
  #resolved = false;
  #finished = false;

  constructor(decision: Decision) { this.#decision = decision; }

  push(chunk: Buffer): Buffer {
    if (this.#finished || this.#resolved) return chunk;
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const delimiter = findDelimiter(this.#pending);
    if (!delimiter) {
      if (this.#pending.length <= FIRST_FRAME_LIMIT) return Buffer.alloc(0);
      this.#resolved = true;
      const output = this.#pending;
      this.#pending = Buffer.alloc(0);
      return output;
    }
    const frameEnd = delimiter.index + delimiter.length;
    if (frameEnd > FIRST_FRAME_LIMIT) {
      this.#resolved = true;
      const output = this.#pending;
      this.#pending = Buffer.alloc(0);
      return output;
    }
    const firstFrame = this.#pending.subarray(0, frameEnd);
    const remainder = this.#pending.subarray(frameEnd);
    this.#pending = Buffer.alloc(0);
    this.#resolved = true;
    try {
      const data = parseData(firstFrame.subarray(0, delimiter.index));
      if (data === null || typeof data !== 'object' || (data as { type?: unknown }).type !== 'response.created') {
        return Buffer.concat([firstFrame, remainder]);
      }
      return Buffer.concat([firstFrame, noticeEvents(this.#decision, delimiter.newline), remainder]);
    } catch {
      return Buffer.concat([firstFrame, remainder]);
    }
  }

  finish(): Buffer {
    if (this.#finished) return Buffer.alloc(0);
    this.#finished = true;
    const output = this.#pending;
    this.#pending = Buffer.alloc(0);
    return output;
  }
}
