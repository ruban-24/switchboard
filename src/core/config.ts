import type { Catalog, Policy, Profile, RouteGroup, Tool } from './types.ts';
import * as v from './validate.ts';

export function parsePolicy(input: unknown): Policy {
  const p = v.object(input, 'policy', ['version', 'id', 'enabledTools', 'classifier', 'history', 'excludedModels', 'profiles', 'routing']);
  if (p.version !== 1) throw new Error('Unsupported policy version');
  const c = v.object(p.classifier, 'classifier', ['timeoutMs', 'maxContextChars', 'minConfidence', 'modelMinConfidence', 'effortMinConfidence']);
  const legacyConfidence = c.minConfidence === undefined ? undefined : v.number(c.minConfidence, 'minConfidence', 0, 1, false);
  const h = v.object(p.history, 'history', ['limit', 'capturePrompts']);
  const rawProfiles = v.object(p.profiles, 'profiles');
  const profiles: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(rawProfiles)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid profile name: ${name}`);
    const profile = v.object(value, `profile ${name}`, ['tool', 'model', 'efforts', 'defaultReasoning']);
    const efforts = v.object(profile.efforts, `${name}.efforts`, v.reasoning);
    profiles[name] = {
      tool: v.oneOf(profile.tool, v.tools, `${name}.tool`), model: v.text(profile.model, `${name}.model`),
      ...(profile.defaultReasoning === undefined ? {} : { defaultReasoning: v.oneOf(profile.defaultReasoning, v.reasoning, `${name}.defaultReasoning`) }),
      efforts: {
        low: v.effort(efforts.low, `${name}.efforts.low`),
        medium: v.effort(efforts.medium, `${name}.efforts.medium`),
        high: v.effort(efforts.high, `${name}.efforts.high`),
        xhigh: v.effort(efforts.xhigh, `${name}.efforts.xhigh`),
        max: v.effort(efforts.max, `${name}.efforts.max`),
      },
    };
  }
  const rawRouting = v.object(p.routing, 'routing', v.tools);
  const rawExcluded = v.object(p.excludedModels, 'excludedModels', v.tools);
  const excludedModels = {} as Policy['excludedModels'];
  const routing = {} as Policy['routing'];
  for (const tool of v.tools) {
    excludedModels[tool] = v.unique(v.array(rawExcluded[tool], `excludedModels.${tool}`).map(model => v.text(model, 'excluded model')), `excludedModels.${tool}`);
    const entries = v.object(rawRouting[tool], `routing.${tool}`, v.groups);
    routing[tool] = {} as Record<RouteGroup, string | null>;
    for (const group of v.groups) {
      const name = entries[group] === null ? null : v.text(entries[group], `${tool}.${group}`);
      if (name !== null) {
        if (!Object.hasOwn(profiles, name)) throw new Error(`Missing profile: ${name}`);
        if (profiles[name]!.tool !== tool) throw new Error(`Profile ${name} belongs to a different tool`);
      }
      routing[tool][group] = name;
    }
  }
  return {
    version: 1, id: v.text(p.id, 'id'),
    enabledTools: v.unique(v.array(p.enabledTools, 'enabledTools').map(t => v.oneOf(t, v.tools, 'tool')), 'enabledTools'),
    classifier: {
      timeoutMs: v.number(c.timeoutMs, 'timeoutMs', 1, 30000),
      maxContextChars: v.number(c.maxContextChars, 'maxContextChars', 256, 100000),
      modelMinConfidence: v.number(c.modelMinConfidence ?? legacyConfidence, 'modelMinConfidence', 0, 1, false),
      effortMinConfidence: v.number(c.effortMinConfidence ?? legacyConfidence, 'effortMinConfidence', 0, 1, false),
    },
    history: { limit: v.number(h.limit, 'history.limit', 0, 1000), capturePrompts: v.boolean(h.capturePrompts, 'capturePrompts') },
    profiles, routing, excludedModels,
  };
}

function merge(base: unknown, override: unknown, label: string): unknown {
  const changes = v.object(override, label);
  const result = structuredClone(v.object(base, label));
  for (const [key, value] of Object.entries(changes)) {
    const current = result[key];
    result[key] = current && typeof current === 'object' && !Array.isArray(current)
      ? merge(current, value, `${label}.${key}`) : structuredClone(value);
  }
  return result;
}

export function mergePolicy(defaults: Policy, override: unknown): Policy {
  const changes = structuredClone(v.object(override, 'policy'));
  if (changes.classifier !== undefined) {
    const c = v.object(changes.classifier, 'classifier');
    if (c.minConfidence !== undefined) {
      const legacy = v.number(c.minConfidence, 'minConfidence', 0, 1, false);
      c.modelMinConfidence ??= legacy;
      c.effortMinConfidence ??= legacy;
      delete c.minConfidence;
    }
  }
  return parsePolicy(merge(defaults, changes, 'policy'));
}

export function validateMappings(policy: Policy, catalog: Catalog, selectedTool?: Tool): { ready: boolean; missing: string[] } {
  for (const tool of v.tools) {
    for (const id of policy.excludedModels[tool]) {
      if (!catalog.models.some(model => model.id === id && model.tool === tool)) {
        throw new Error(`Excluded model ${id} is not in the ${tool} catalog`);
      }
    }
  }
  for (const [name, profile] of Object.entries(policy.profiles)) {
    const model = catalog.models.find(m => m.id === profile.model && m.tool === profile.tool);
    if (!model) throw new Error(`Profile ${name}: model ${profile.model} is not in the catalog`);
    for (const effort of Object.values(profile.efforts)) {
      if (!model.efforts.includes(effort)) throw new Error(`Profile ${name}: unsupported effort ${String(effort)} for ${model.id}`);
    }
  }
  const missing: string[] = [];
  for (const tool of selectedTool ? [selectedTool] : policy.enabledTools) {
    for (const group of v.groups) if (policy.routing[tool][group] === null) missing.push(`${tool}.${group}`);
    const names = Object.values(policy.routing[tool]).filter((name): name is string => name !== null);
    if (names.length > 0 && names.every(name => policy.excludedModels[tool].includes(policy.profiles[name]!.model))) {
      missing.push(`${tool}: no eligible models remain after exclusions`);
    }
  }
  return { ready: missing.length === 0, missing };
}

/** Distinct routed model families from lowest to highest tier, omitting excluded models. */
export function routedFamilies(policy: Policy, catalog: Catalog, tool: Tool): string[] {
  const models = v.tiers.map(tier => policy.profiles[policy.routing[tool][tier] ?? '']?.model)
    .filter((model): model is string => model !== undefined && !policy.excludedModels[tool].includes(model));
  return [...new Set(models)].map(id => catalog.models.find(model => model.id === id && model.tool === tool)?.family ?? id);
}
