import type { Catalog, Environment, Policy } from '../src/core/types.ts';

export const environment: Environment = {
  tool: 'codex', model: 'fixture-standard', cliVersion: '1.2.3',
  connection: 'subscription', mode: 'standard-single-agent',
};

export function catalogFixture(): Catalog {
  return {
    version: 1,
    models: [
      { id: 'fixture-fast', tool: 'codex', provider: 'openai', family: 'Fast', efforts: ['low', 'medium'] },
      { id: 'fixture-standard', tool: 'codex', provider: 'openai', family: 'Standard', efforts: ['low', 'medium', 'high'] },
      { id: 'fixture-strong', tool: 'codex', provider: 'openai', family: 'Strong', efforts: ['medium', 'high'] },
      { id: 'fixture-top', tool: 'codex', provider: 'openai', family: 'Top', efforts: ['low', 'medium', 'high'] },
      { id: 'fixture-fixed', tool: 'claude', provider: 'anthropic', family: 'Fixed', efforts: [null] },
    ],
    compatibility: [{
      model: 'fixture-standard', tool: 'codex', cliVersions: ['1.2.3'], connection: 'subscription',
      mode: 'standard-single-agent', mechanism: 'openai-configuration-update', status: 'verified',
      sourceUrl: 'https://example.com/documentation', checkedAt: '2026-09-18',
      evidence: 'Synthetic fixture only; not real provider evidence.', restrictions: [],
    }],
  };
}

export function policyFixture(): Policy {
  return {
    version: 1, id: 'fixture-policy', enabledTools: ['claude', 'codex'],
    classifier: { timeoutMs: 100, maxContextChars: 16000, modelMinConfidence: 0.7, effortMinConfidence: 0.7 },
    history: { limit: 20, capturePrompts: false },
    excludedModels: { claude: [], codex: [] },
    profiles: {
      fast: { tool: 'codex', model: 'fixture-fast', efforts: { low: 'low', medium: 'medium', high: 'medium', xhigh: 'medium', max: 'medium' } },
      standard: { tool: 'codex', model: 'fixture-standard', efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } },
      strong: { tool: 'codex', model: 'fixture-strong', efforts: { low: 'medium', medium: 'high', high: 'high', xhigh: 'high', max: 'high' } },
      top: { tool: 'codex', model: 'fixture-top', efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } },
    },
    routing: {
      claude: { routine: null, standard: null, complex: null, demanding: null, uncertain: null },
      codex: { routine: 'fast', standard: 'standard', complex: 'strong', demanding: 'top', uncertain: 'strong' },
    },
  };
}
