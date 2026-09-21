import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsage } from '../src/core/usage.ts';

test('missing counters stay unknown while explicit zero remains zero', () => {
  assert.deepEqual(normalizeUsage('openai', {}), { totalInputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null });
  assert.equal(normalizeUsage('openai', { input_tokens_details: { cached_tokens: 0 } }).cachedInputTokens, 0);
});

test('Anthropic input totals include uncached, read and written tokens exactly once', () => {
  assert.deepEqual(normalizeUsage('anthropic', { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, output_tokens: 5 }), {
    totalInputTokens: 150, cachedInputTokens: 100, cacheWriteTokens: 30, outputTokens: 5,
  });
  assert.equal(normalizeUsage('anthropic', { input_tokens: 20 }).totalInputTokens, null);
});

test('OpenAI input_tokens is already the total, not a value to add cached tokens to', () => {
  assert.deepEqual(normalizeUsage('openai', { input_tokens: 150, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 30 }, output_tokens: 5 }), {
    totalInputTokens: 150, cachedInputTokens: 100, cacheWriteTokens: 30, outputTokens: 5,
  });
});

test('malformed observations are unavailable rather than fabricated measurements', () => {
  for (const value of [-1, 1.5, '100', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeUsage('openai', { input_tokens: value }).totalInputTokens, null);
  }
  assert.equal(normalizeUsage('openai', { input_tokens: 20, input_tokens_details: { cached_tokens: 100 } }).cachedInputTokens, null);
});
