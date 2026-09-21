import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexCatalog } from '../src/native/codex-catalog.ts';

const model = (slug: string, context = 272000) => ({ slug, display_name: slug, context_window: context, max_context_window: context,
  default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high', description: 'High' }],
  shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', tool_mode: 'code_mode_only', web_search_tool_type: 'text_and_image',
  model_messages: { instructions: 'native baseline' }, input_modalities: ['text', 'image'], experimental_supported_tools: [],
  supports_image_detail_original: true, supports_search_tool: true, support_verbosity: true, node_repl_auto_review_required: false,
  truncation_policy: { mode: 'tokens', limit: 10000 }, effective_context_window_percent: 95 });

test('Codex alias uses native metadata and conservative shared capabilities without changing concrete entries', () => {
  const luna = model('luna', 128000);
  const astra = { ...model('astra'), experimental_supported_tools: ['extra-tool'], node_repl_auto_review_required: true };
  const original = { models: [astra, luna] };
  const result = buildCodexCatalog(original, ['luna', 'astra']);
  const alias = result.models[0]!;
  assert.equal(alias.slug, 'switchboard');
  assert.equal(alias.display_name, 'Switchboard');
  assert.equal(alias.default_reasoning_level, 'auto');
  assert.deepEqual(alias.supported_reasoning_levels, [{ effort: 'auto', description: 'Router chooses the model and effort; see the routing message.' }]);
  assert.equal(alias.context_window, 128000);
  assert.deepEqual(alias.experimental_supported_tools, []);
  assert.equal(alias.node_repl_auto_review_required, true);
  assert.deepEqual(alias.model_messages, luna.model_messages);
  assert.equal(result.models.filter(model => model.slug === 'switchboard').length, 1);
  assert.deepEqual(result.models.slice(1), original.models);
  assert.deepEqual(buildCodexCatalog(result, ['luna', 'astra']), result);
  assert.equal(original.models.length, 2);
  (alias.model_messages as { instructions: string }).instructions = 'changed alias only';
  assert.equal(luna.model_messages.instructions, 'native baseline');
});

test('Codex metadata refuses unknown eligible models or incompatible tool protocols', () => {
  assert.throws(() => buildCodexCatalog({ models: [model('luna')] }, ['future-model']), /future-model/i);
  assert.throws(() => buildCodexCatalog({ models: [model('luna'), { ...model('astra'), tool_mode: 'future' }] }, ['luna', 'astra']), /tool_mode/);
});

test('Codex alias omits context limits that are not finite positive numbers', () => {
  for (const value of [Infinity, NaN, 0, -1, undefined]) {
    const native = { ...model('luna'), context_window: value, max_context_window: value, effective_context_window_percent: value };
    const alias = buildCodexCatalog({ models: [native] }, ['luna']).models[0]!;
    for (const field of ['context_window', 'max_context_window', 'effective_context_window_percent']) {
      assert.equal(Object.hasOwn(alias, field), false, `${field} must not advertise ${value}`);
    }
  }
});
