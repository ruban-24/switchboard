import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConversationRepository } from './core/session.ts';
import type { ConversationState, Decision, Selection, Tool } from './core/types.ts';
import { parseClassification } from './core/policy.ts';
import * as v from './core/validate.ts';

export async function atomicJsonWrite(file: string, value: unknown, options: { replace?: boolean } = {}): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    if (options.replace === false) await link(temporary, file);
    else await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function selection(value: unknown): Selection {
  const s = v.object(value, 'selection');
  return {
    profile: s.profile === null ? null : v.text(s.profile, 'profile'), model: v.text(s.model, 'model'), effort: v.effort(s.effort, 'effort'),
    ...(s.excludedModel === undefined ? {} : { excludedModel: v.text(s.excludedModel, 'excludedModel') }),
  };
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value)) throw new Error('Invalid conversation identity');
  return value;
}

function decision(value: unknown, capturePrompts: boolean): Decision {
  const d = v.object(value, 'decision');
  const at = v.text(d.at, 'at');
  if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid decision timestamp');
  const result: Decision = {
    conversationId: identity(d.conversationId), turnId: v.text(d.turnId, 'turnId'), tool: v.oneOf(d.tool, v.tools, 'tool'),
    selection: selection(d.selection), classification: d.classification === null ? null : parseClassification(d.classification),
    recommendation: d.recommendation === null ? null : selection(d.recommendation),
    reason: v.oneOf(d.reason, ['initial', 'uncertain', 'classifier-unavailable', 'pinned', 'manual', 'tool-continuation'] as const, 'reason'),
    policyId: v.text(d.policyId, 'policyId'), at,
    ...(d.adjustments === undefined ? {} : { adjustments: v.array(d.adjustments, 'adjustments').map(a => v.oneOf(a, ['model-confidence-floor', 'effort-default', 'effort-unavailable', 'insufficient-context', 'turn-detection-fallback'] as const, 'adjustment')) }),
    ...(d.turnDetection === undefined ? {} : { turnDetection: v.oneOf(d.turnDetection, ['native', 'hook', 'content', 'saved-route'] as const, 'turnDetection') }),
  };
  if (capturePrompts && typeof d.prompt === 'string') result.prompt = d.prompt.slice(0, 100000);
  return result;
}

export class Store implements ConversationRepository {
  private readonly directory: string;
  private readonly historyLimit: number;
  private readonly capturePrompts: boolean;

  constructor(directory: string, options: { historyLimit?: number; capturePrompts?: boolean } = {}) {
    this.directory = directory;
    this.historyLimit = v.number(options.historyLimit ?? 20, 'historyLimit', 0, 1000);
    this.capturePrompts = options.capturePrompts ?? false;
  }

  private file(tool: Tool, id: string): string {
    v.oneOf(tool, v.tools, 'tool');
    identity(id);
    const key = createHash('sha256').update(`${tool}:${id}`).digest('hex');
    return join(this.directory, 'sessions', `${key}.json`);
  }

  private state(value: unknown): ConversationState {
    const s = v.object(value, 'state');
    if (s.version !== 1) throw new Error('Unsupported conversation state version');
    const tool = v.oneOf(s.tool, v.tools, 'tool');
    const conversationId = identity(s.conversationId);
    const lastDecision = decision(s.lastDecision, false);
    const history = v.array(s.history, 'history').map(d => decision(d, this.capturePrompts));
    for (const item of [lastDecision, ...history]) {
      if (item.tool !== tool || item.conversationId !== conversationId) throw new Error('Decision belongs to another conversation');
    }
    const active = selection(s.selection);
    if (JSON.stringify(active) !== JSON.stringify(lastDecision.selection)) throw new Error('Route state disagrees with last decision');
    return {
      version: 1, tool, conversationId, selection: active, manual: v.boolean(s.manual, 'manual'), lastDecision,
      history: this.historyLimit === 0 ? [] : history.slice(-this.historyLimit),
    };
  }

  async load(tool: Tool, id: string): Promise<ConversationState | null> {
    const file = this.file(tool, id);
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Could not read conversation state', { cause: error });
    }
    try {
      const state = this.state(JSON.parse(raw));
      if (state.tool !== tool || state.conversationId !== id) throw new Error('Identity mismatch');
      return state;
    } catch { throw new Error(`Invalid conversation state for ${tool}/${id}; refusing to silently select another route`); }
  }

  async save(value: ConversationState): Promise<void> {
    const state = this.state(value);
    await atomicJsonWrite(this.file(state.tool, state.conversationId), state);
  }
}
