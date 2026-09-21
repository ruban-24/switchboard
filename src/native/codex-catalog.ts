import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const AGREEMENT_FIELDS = ['shell_type', 'apply_patch_tool_type', 'tool_mode', 'web_search_tool_type'] as const;
const MINIMUM_FIELDS = ['context_window', 'max_context_window', 'effective_context_window_percent'] as const;
const INTERSECTION_FIELDS = ['input_modalities', 'experimental_supported_tools'] as const;
const ALL_TRUE_FIELDS = ['supports_image_detail_original', 'supports_search_tool', 'support_verbosity', 'use_responses_lite'] as const;
const ANY_TRUE_FIELDS = ['node_repl_auto_review_required', 'node_repl_disabled'] as const;
const ALIAS_SLUG = 'switchboard';
type Model = Record<string, unknown> & { slug: string };

function catalogError(message: string): Error {
  return new Error(`Cannot build Switchboard model catalog: ${message}`);
}

function asModel(value: unknown, context: string): Model {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).slug !== 'string') {
    throw catalogError(`${context} is malformed; expected an object with a string slug`);
  }
  return value as Model;
}

function intersect(values: unknown[]): unknown[] {
  const arrays = values.map(value => Array.isArray(value) ? value : []);
  const first = arrays[0] ?? [];
  return first.filter((candidate, index) =>
    first.findIndex(value => isDeepStrictEqual(value, candidate)) === index &&
    arrays.slice(1).every(array => array.some(value => isDeepStrictEqual(value, candidate))),
  );
}

export function buildCodexCatalog(value: unknown, eligible: string[]): { models: Record<string, unknown>[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).models)) {
    throw catalogError('native catalog is malformed; expected a models array');
  }
  const models = (value as { models: unknown[] }).models.map((model, index) => asModel(model, `model at index ${index}`));
  const eligibleSlugs = [...new Set(eligible)];
  if (eligibleSlugs.length === 0) throw catalogError('at least one eligible model is required');
  const selected = eligibleSlugs.map(slug => {
    const found = models.find(model => model.slug === slug && model.slug !== ALIAS_SLUG);
    if (!found) {
      throw catalogError(`eligible model ${JSON.stringify(slug)} is missing from the native catalog; update the eligible-model configuration or exclude this model`);
    }
    return found;
  });
  const baseline = selected[0];
  if (!baseline) throw catalogError('at least one eligible model is required');

  for (const field of AGREEMENT_FIELDS) {
    const baselineValue = baseline[field];
    if (selected.some(model => !isDeepStrictEqual(model[field], baselineValue))) throw catalogError(`eligible models disagree on ${field}`);
  }

  const alias: Record<string, unknown> = structuredClone(baseline);
  for (const field of MINIMUM_FIELDS) {
    const values = selected.map(model => model[field]);
    if (values.every(candidate => typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0)) {
      alias[field] = Math.min(...(values as number[]));
    } else delete alias[field];
  }
  for (const field of INTERSECTION_FIELDS) alias[field] = intersect(selected.map(model => model[field]));
  for (const field of ALL_TRUE_FIELDS) alias[field] = selected.every(model => model[field] === true);
  for (const field of ANY_TRUE_FIELDS) alias[field] = selected.some(model => model[field] === true);
  Object.assign(alias, {
    slug: 'switchboard', display_name: 'Switchboard',
    description: 'Routes the first request to a suitable model and effort, then keeps that choice for the conversation.',
    visibility: 'list', supported_in_api: true, priority: 0, upgrade: null, availability_nux: null,
    default_reasoning_level: 'auto',
    supported_reasoning_levels: [{ effort: 'auto', description: 'Router chooses the model and effort; see the routing message.' }],
    additional_speed_tiers: [], service_tiers: [], multi_agent_reasoning_effort: null,
  });
  return { models: [alias, ...models.filter(model => model.slug !== ALIAS_SLUG)] };
}

const SECRET_ENV_KEYS = new Set(['JEV_API_KEY', 'TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENROUTER_API_KEY', 'SWITCHBOARD_API_KEY']);

export async function readCodexCatalog(executable: string): Promise<unknown> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV_KEYS.has(key)));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(executable, ['debug', 'models', '--bundled'], {
        encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024, env,
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return JSON.parse(output);
  } catch {
    throw new Error('Unable to read the native Codex model catalog. Update Codex to a version that supports `debug models --bundled`, then try again.');
  }
}
