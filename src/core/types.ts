export type Tool = 'claude' | 'codex';
export type Provider = 'anthropic' | 'openai';
export type Reasoning = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Complexity = 'routine' | 'standard' | 'complex' | 'demanding';
export type RouteGroup = Complexity | 'uncertain';
export type Effort = string | null;

export interface Profile {
  tool: Tool;
  model: string;
  efforts: Record<Reasoning, Effort>;
  defaultReasoning?: Reasoning;
}

export interface Policy {
  version: 1;
  id: string;
  enabledTools: Tool[];
  classifier: { timeoutMs: number; maxContextChars: number; modelMinConfidence: number; effortMinConfidence: number };
  history: { limit: number; capturePrompts: boolean };
  excludedModels: Record<Tool, string[]>;
  profiles: Record<string, Profile>;
  routing: Record<Tool, Record<RouteGroup, string | null>>;
}

export interface Model {
  id: string;
  tool: Tool;
  provider: Provider;
  family: string;
  efforts: Effort[];
}

export interface Environment {
  model: string;
  tool: Tool;
  cliVersion: string;
  connection: 'api-key' | 'subscription';
  mode: string;
}

export interface Compatibility {
  model: string;
  tool: Tool;
  cliVersions: string[];
  connection: Environment['connection'];
  mode: string;
  mechanism: 'fixed' | 'openai-configuration-update' | 'anthropic-message-effort';
  status: 'verified' | 'unverified' | 'unsupported';
  sourceUrl: string;
  checkedAt: string;
  evidence: string | null;
  restrictions: string[];
}

export interface Catalog {
  version: 1;
  models: Model[];
  compatibility: Compatibility[];
}

export interface ClassificationDiagnostics {
  provider: 'typesafe' | 'vercel' | 'openrouter';
  requestedModel: string | null;
  resolvedModel: string | null;
  probabilities: {
    model: Record<Complexity, number> | null;
    context: Record<'true' | 'false', number> | null;
    effort: Record<Reasoning, number> | null;
  };
}

export interface Classification {
  taskType: 'explain' | 'edit' | 'implement' | 'debug' | 'review' | 'architecture' | 'other' | null;
  complexity: Complexity;
  reasoning: Reasoning | null;
  sufficientContext: boolean;
  confidences: { model: number; effort: number | null; context: number; taskType: number | null };
  /** Model whose conditional effort answer was read. Absent on legacy records. */
  effortModel?: string;
  /** Compact, non-routing diagnostics. Absent on legacy records. */
  diagnostics?: ClassificationDiagnostics;
}

export interface ClassificationContext { tool: Tool; policy: Policy; catalog: Catalog }
export type Classifier = (task: string, signal: AbortSignal, context: ClassificationContext) => Promise<Classification>;

export type Adjustment = 'model-confidence-floor' | 'effort-default' | 'effort-unavailable' | 'insufficient-context' | 'turn-detection-fallback';

export interface Selection {
  profile: string | null;
  model: string;
  effort: Effort;
  excludedModel?: string;
}

export interface Decision {
  conversationId: string;
  turnId: string;
  tool: Tool;
  selection: Selection;
  classification: Classification | null;
  recommendation: Selection | null;
  reason: 'initial' | 'uncertain' | 'classifier-unavailable' | 'pinned' | 'manual' | 'tool-continuation';
  policyId: string;
  adjustments?: Adjustment[];
  turnDetection?: 'native' | 'hook' | 'content' | 'saved-route';
  at: string;
  prompt?: string;
}

export interface ConversationState {
  version: 1;
  conversationId: string;
  tool: Tool;
  selection: Selection;
  manual: boolean;
  lastDecision: Decision;
  history: Decision[];
}

export interface CacheUsage {
  totalInputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
}
