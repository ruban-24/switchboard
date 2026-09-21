import type { ClassificationDiagnostics } from './types.ts';
import { tiers, reasoning } from './validate.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Preserve only a complete distribution over known choices; never fill or normalize it. */
export function choiceProbabilities<K extends string>(value: unknown, choices: readonly K[]): Record<K, number> | null {
  const p = record(value);
  if (!p || Object.keys(p).length !== choices.length || !choices.every(key => Object.hasOwn(p, key)
    && typeof p[key] === 'number' && Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1)) return null;
  const total = choices.reduce((sum, key) => sum + (p[key] as number), 0);
  // The API can round each probability to two decimal places.
  if (Math.abs(total - 1) > choices.length * .005 + Number.EPSILON) return null;
  return Object.fromEntries(choices.map(key => [key, p[key]])) as Record<K, number>;
}

/** Also applied at persistence boundaries so arbitrary provider payloads cannot be stored. */
export function parseDiagnostics(value: unknown): ClassificationDiagnostics | undefined {
  const d = record(value);
  if (!d || (d.provider !== 'typesafe' && d.provider !== 'vercel' && d.provider !== 'openrouter')) return undefined;
  const p = record(d.probabilities);
  const version = /^jev-\d+\.\d+\.\d+$/;
  const requested = /^(?:jev-(?:latest|preview|\d+\.\d+(?:\.\d+)?)|typesafe-ai\/jev)$/;
  const openrouter = /^(?:(?:typesafe\/)?jev-(?:latest|preview|\d+\.\d+(?:\.\d+)?(?:-\d{8})?)|~typesafe\/jev-latest)$/;
  const requestedModel = d.provider === 'openrouter' ? openrouter : requested;
  const resolvedModel = d.provider === 'openrouter' ? openrouter : version;
  return {
    provider: d.provider,
    requestedModel: typeof d.requestedModel === 'string' && requestedModel.test(d.requestedModel) ? d.requestedModel : null,
    resolvedModel: typeof d.resolvedModel === 'string' && resolvedModel.test(d.resolvedModel) ? d.resolvedModel : null,
    probabilities: {
      model: choiceProbabilities(p?.model, tiers),
      context: choiceProbabilities(p?.context, ['true', 'false']),
      effort: choiceProbabilities(p?.effort, reasoning),
    },
  };
}
