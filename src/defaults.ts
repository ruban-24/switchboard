import type { Catalog, Complexity, Policy, Tool } from './core/types.ts';

export const eligibleFamilies = {
  claude: ['Haiku', 'Sonnet', 'Opus', 'Fable'],
  codex: ['GPT-5.6 Luna', 'GPT-5.6 Terra', 'GPT-5.6 Sol', 'GPT-6 Astra'],
} as const;

// Owner-approved family order, resolved to documented provider IDs on 2026-09-18.
export const modelTiers: Record<Tool, Record<Complexity, string>> = {
  claude: {
    routine: 'claude-haiku-4-5-20251001', standard: 'claude-sonnet-5',
    complex: 'claude-opus-5', demanding: 'claude-fable-5-1',
  },
  codex: {
    routine: 'gpt-5.6-luna', standard: 'gpt-5.6-terra',
    complex: 'gpt-5.6-sol', demanding: 'gpt-6-astra',
  },
};

function supportedEfforts() {
  return { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
}

export const defaultPolicy: Policy = {
  version: 1, id: 'default-v0.3', enabledTools: ['claude', 'codex'],
  classifier: { timeoutMs: 3000, maxContextChars: 16000, modelMinConfidence: 0.7, effortMinConfidence: 0.7 },
  history: { limit: 20, capturePrompts: false },
  excludedModels: { claude: [], codex: [] },
  profiles: {
    'claude-haiku': { tool: 'claude', defaultReasoning: 'low', model: modelTiers.claude.routine, efforts: { low: null, medium: null, high: null, xhigh: null, max: null } },
    'claude-sonnet': { tool: 'claude', defaultReasoning: 'medium', model: modelTiers.claude.standard, efforts: supportedEfforts() },
    'claude-opus': { tool: 'claude', defaultReasoning: 'high', model: modelTiers.claude.complex, efforts: supportedEfforts() },
    'claude-fable': { tool: 'claude', defaultReasoning: 'xhigh', model: modelTiers.claude.demanding, efforts: supportedEfforts() },
    'codex-luna': { tool: 'codex', defaultReasoning: 'low', model: modelTiers.codex.routine, efforts: supportedEfforts() },
    'codex-terra': { tool: 'codex', defaultReasoning: 'medium', model: modelTiers.codex.standard, efforts: supportedEfforts() },
    'codex-sol': { tool: 'codex', defaultReasoning: 'high', model: modelTiers.codex.complex, efforts: supportedEfforts() },
    'codex-astra': { tool: 'codex', defaultReasoning: 'xhigh', model: modelTiers.codex.demanding, efforts: supportedEfforts() },
  },
  routing: {
    claude: { routine: 'claude-haiku', standard: 'claude-sonnet', complex: 'claude-opus', demanding: 'claude-fable', uncertain: 'claude-opus' },
    codex: { routine: 'codex-luna', standard: 'codex-terra', complex: 'codex-sol', demanding: 'codex-astra', uncertain: 'codex-sol' },
  },
};

// API capability snapshot, not evidence of subscription/CLI/cache compatibility.
// Sources and scope: docs/model-catalog.md. No live compatibility is claimed.
export const bundledCatalog: Catalog = {
  version: 1,
  models: [
    { id: modelTiers.claude.routine, tool: 'claude', provider: 'anthropic', family: 'Haiku', efforts: [null] },
    { id: modelTiers.claude.standard, tool: 'claude', provider: 'anthropic', family: 'Sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: modelTiers.claude.complex, tool: 'claude', provider: 'anthropic', family: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: modelTiers.claude.demanding, tool: 'claude', provider: 'anthropic', family: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: modelTiers.codex.routine, tool: 'codex', provider: 'openai', family: 'GPT-5.6 Luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { id: modelTiers.codex.standard, tool: 'codex', provider: 'openai', family: 'GPT-5.6 Terra', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { id: modelTiers.codex.complex, tool: 'codex', provider: 'openai', family: 'GPT-5.6 Sol', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { id: modelTiers.codex.demanding, tool: 'codex', provider: 'openai', family: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ],
  compatibility: [],
};
