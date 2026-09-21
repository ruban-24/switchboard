import type { CacheUsage, Provider } from './types.ts';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeUsage(provider: Provider, value: unknown): CacheUsage {
  const usage = record(value);
  const details = record(usage.input_tokens_details);
  const input = counter(usage.input_tokens);
  let cached = counter(provider === 'anthropic' ? usage.cache_read_input_tokens : details.cached_tokens);
  let written = counter(provider === 'anthropic' ? usage.cache_creation_input_tokens : details.cache_write_tokens);
  const total = provider === 'anthropic'
    ? input === null || cached === null || written === null ? null : counter(input + cached + written)
    : input;
  if (total !== null) {
    if (cached !== null && cached > total) cached = null;
    if (written !== null && written > total) written = null;
    if (cached !== null && written !== null && cached + written > total) { cached = null; written = null; }
  }
  return { totalInputTokens: total, cachedInputTokens: cached, cacheWriteTokens: written, outputTokens: counter(usage.output_tokens) };
}
