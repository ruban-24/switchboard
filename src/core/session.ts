import type { Catalog, Classification, Classifier, ConversationState, Decision, Policy, Selection, Tool } from './types.ts';
import { assessInitialRoute, isModelUncertain, parseClassification, selectInitialRoute } from './policy.ts';
import { parsePolicy, validateMappings } from './config.ts';
import { parseCatalog } from './catalog.ts';
import * as v from './validate.ts';

export interface ConversationRepository {
  load(tool: Tool, conversationId: string): Promise<ConversationState | null>;
  save(state: ConversationState): Promise<void>;
}

export interface RoutingDependencies {
  policy: Policy;
  catalog: Catalog;
  repository: ConversationRepository;
  classify: Classifier;
}

export interface TurnInput {
  conversationId: string;
  turnId: string;
  tool: Tool;
  kind: 'user' | 'tool';
  task: string;
  manual?: Selection;
  signal?: AbortSignal;
  turnDetection?: Decision['turnDetection'];
}

export class Router {
  private readonly dependencies: RoutingDependencies;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(dependencies: RoutingDependencies) {
    const policy = parsePolicy(dependencies.policy);
    const catalog = parseCatalog(dependencies.catalog);
    validateMappings(policy, catalog);
    this.dependencies = { ...dependencies, policy, catalog };
  }

  async routeTurn(input: TurnInput): Promise<Decision> {
    v.text(input.conversationId, 'conversationId');
    v.text(input.turnId, 'turnId');
    v.oneOf(input.tool, v.tools, 'tool');
    v.oneOf(input.kind, ['user', 'tool'], 'kind');
    input.signal?.throwIfAborted();
    const key = `${input.tool}:${input.conversationId}`;
    const previous = this.pending.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.routeSerialized(input));
    this.pending.set(key, work);
    try {
      const decision = await work;
      input.signal?.throwIfAborted();
      return decision;
    }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }

  private async classify(input: TurnInput): Promise<Classification | null> {
    const { policy, classify } = this.dependencies;
    const timeout = new AbortController();
    const signal = input.signal ? AbortSignal.any([timeout.signal, input.signal]) : timeout.signal;
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => timeout.abort(new Error('Classification deadline exceeded')), policy.classifier.timeoutMs);
    try {
      signal.throwIfAborted();
      const task = input.task.slice(0, policy.classifier.maxContextChars);
      const result = parseClassification(await Promise.race([Promise.resolve().then(() => classify(task, signal, {
        tool: input.tool, policy, catalog: this.dependencies.catalog,
      })), aborted]));
      input.signal?.throwIfAborted();
      return input.task.length > task.length ? { ...result, sufficientContext: false } : result;
    } catch {
      input.signal?.throwIfAborted();
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async routeSerialized(input: TurnInput): Promise<Decision> {
    const { policy, catalog, repository } = this.dependencies;
    input.signal?.throwIfAborted();
    if (!policy.enabledTools.includes(input.tool)) throw new Error(`${input.tool} is not enabled`);
    const state = await repository.load(input.tool, input.conversationId);
    input.signal?.throwIfAborted();
    if (state && (state.tool !== input.tool || state.conversationId !== input.conversationId)) throw new Error('Conversation state identity mismatch');
    if (!input.manual && state?.lastDecision.turnId === input.turnId && input.kind === 'user') return structuredClone(state.lastDecision);
    if (!input.manual && input.kind === 'tool') {
      if (!state) throw new Error('Tool continuation has no conversation state; resume through the original router');
      return { ...state.lastDecision, turnId: input.turnId, selection: { ...state.selection }, classification: null, recommendation: null, reason: 'tool-continuation', at: new Date().toISOString() };
    }

    let selection: Selection;
    let classification: Classification | null = null;
    let recommendation: Selection | null = null;
    let reason: Decision['reason'];
    let adjustments: Decision['adjustments'] = [];
    const manual = Boolean(input.manual) || Boolean(state?.manual);
    if (manual) {
      const chosen = input.manual ?? state!.selection;
      selection = { profile: null, model: v.text(chosen.model, 'manual.model'), effort: v.effort(chosen.effort, 'manual.effort') };
      reason = 'manual';
    } else {
      classification = input.task.trim() ? await this.classify(input) : null;
      if (state) {
        selection = { ...state.selection };
        reason = 'pinned';
        // The foundation intentionally pins effort as well. An adapter must first
        // implement and verify durable effort-update replay before this can change.
        if (!isModelUncertain(policy, classification) && ['complex', 'demanding'].includes(classification!.complexity)
          && validateMappings(policy, catalog, input.tool).ready) {
          const candidate = selectInitialRoute(policy, catalog, input.tool, classification);
          const models = v.tiers.map(tier => policy.profiles[policy.routing[input.tool][tier]!]!.model);
          const currentRank = models.lastIndexOf(selection.model);
          if (currentRank >= 0 && models.lastIndexOf(candidate.model) > currentRank) recommendation = candidate;
        }
      } else {
        ({ selection, adjustments } = assessInitialRoute(policy, catalog, input.tool, classification));
        reason = !classification ? 'classifier-unavailable' : adjustments.length ? 'uncertain' : 'initial';
      }
    }
    input.signal?.throwIfAborted();
    const decision: Decision = {
      conversationId: input.conversationId, turnId: input.turnId, tool: input.tool,
      selection, classification, recommendation, reason, adjustments, policyId: policy.id, at: new Date().toISOString(),
      ...(input.turnDetection ? { turnDetection: input.turnDetection } : {}),
    };
    const record: Decision = policy.history.capturePrompts && policy.history.limit > 0
      ? { ...decision, prompt: input.task.slice(0, policy.classifier.maxContextChars) } : decision;
    const history = [...(state?.history ?? []), record].map(previous => {
      const { prompt, ...metadata } = previous;
      return policy.history.capturePrompts && prompt !== undefined ? { ...metadata, prompt } : metadata;
    });
    await repository.save({
      version: 1, conversationId: input.conversationId, tool: input.tool, selection, manual,
      lastDecision: decision, history: policy.history.limit === 0 ? [] : history.slice(-policy.history.limit),
    });
    return structuredClone(decision);
  }
}
