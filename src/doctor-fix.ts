import { mergePolicy, validateMappings } from './core/config.ts';
import { assessInitialModel } from './core/policy.ts';
import type { Catalog, Classification, Policy, RouteGroup, Tool } from './core/types.ts';
import * as v from './core/validate.ts';
import { minimumClaudeCode, previousGeneration } from './defaults.ts';

type Override = Record<string, unknown>;

export interface FixOption {
  key: string;
  label: string;
  apply(override: Override): void;
}

export interface FixFinding {
  /** Stable across re-planning, so a question is asked at most once. */
  id: string;
  message: string;
  options: FixOption[];
  fallback: string;
}

function record(parent: Override, key: string): Override {
  const value = parent[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Override;
  const created: Override = {};
  parent[key] = created;
  return created;
}

function codexExclusions(override: Override, defaults: Policy): string[] {
  const listed = (override.excludedModels as Override | undefined)?.codex;
  return Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string') : [...defaults.excludedModels.codex];
}

function setCodexExclusions(override: Override, models: string[]): void {
  record(override, 'excludedModels').codex = models;
}

function ready(defaults: Policy, catalog: Catalog, override: Override, tool: Tool = 'codex'): boolean {
  try { return validateMappings(mergePolicy(defaults, override), catalog, tool).ready; }
  catch { return false; }
}

function familyOf(catalog: Catalog, tool: Tool, id: string): string {
  return catalog.models.find(model => model.id === id && model.tool === tool)?.family ?? id;
}

/** Routed groups and the profile names behind them that use a model. */
function routesUsing(policy: Policy, tool: Tool, model: string): { groups: RouteGroup[]; profiles: string[] } {
  const groups = v.groups.filter(group => {
    const name = policy.routing[tool][group];
    return name !== null && policy.profiles[name]?.model === model;
  });
  return { groups, profiles: [...new Set(groups.map(group => policy.routing[tool][group]!))] };
}

function setProfileModel(target: Override, profiles: string[], model: string): void {
  const overrides = record(target, 'profiles');
  for (const name of profiles) record(overrides, name).model = model;
}

function clearProfileModel(target: Override, profiles: string[]): void {
  const overrides = record(target, 'profiles');
  for (const name of profiles) {
    const profile = record(overrides, name);
    delete profile.model;
    if (!Object.keys(profile).length) delete overrides[name];
  }
  if (!Object.keys(overrides).length) delete target.profiles;
}

function restoreResolves(defaults: Policy, catalog: Catalog, override: Override, restore: (target: Override) => void,
  model: string, restored: RouteGroup[], available: Set<string>): boolean {
  const edited = structuredClone(override);
  restore(edited);
  if (!ready(defaults, catalog, edited)) return false;
  const policy = mergePolicy(defaults, edited);
  return routesUsing(policy, 'codex', model).groups.length === 0
    && restored.every(group => available.has(policy.profiles[policy.routing.codex[group] ?? '']?.model ?? ''));
}

/** Families that would serve the given groups once `model` is excluded. */
function substitutes(defaults: Policy, catalog: Catalog, tool: Tool, override: Override, groups: RouteGroup[]): string[] {
  const policy = mergePolicy(defaults, override);
  const confidences = { model: 1, effort: null, context: 1, taskType: null };
  return [...new Set(groups.map(group => {
    const classification: Classification | null = group === 'uncertain' ? null
      : { taskType: null, complexity: group, reasoning: null, sufficientContext: true, confidences };
    return familyOf(catalog, tool, assessInitialModel(policy, catalog, tool, classification).selection.model);
  }))];
}

/**
 * Personal profile overrides that swapped a routed model for its previous generation,
 * grouped by the shipped model they replaced.
 */
function previousGenerationSwaps(override: Override, defaults: Policy, tool: Tool): Map<string, string[]> {
  const swaps = new Map<string, string[]>();
  const overrides = (override.profiles ?? {}) as Record<string, Override>;
  for (const [name, profile] of Object.entries(overrides)) {
    const shipped = defaults.profiles[name];
    if (!shipped || shipped.tool !== tool || profile?.model !== previousGeneration[shipped.model]) continue;
    swaps.set(shipped.model, [...(swaps.get(shipped.model) ?? []), name]);
  }
  return swaps;
}

/** Model slugs listed by `codex debug models --bundled`, excluding the Switchboard alias. */
export function nativeCodexModels(value: unknown): string[] {
  const models = value && typeof value === 'object' ? (value as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) throw new Error('The native Codex model catalog is malformed');
  return models.map(model => (model as { slug?: unknown } | null)?.slug)
    .filter((slug): slug is string => typeof slug === 'string' && slug !== 'switchboard');
}

/**
 * Compares the effective Codex routing with the models the installed Codex offers and
 * proposes personal-policy edits. Planning never writes; the caller confirms each change.
 */
export function planCodexFixes(policy: Policy, override: Override, native: string[], defaults: Policy, catalog: Catalog): FixFinding[] {
  const findings: FixFinding[] = [];
  const available = new Set(native);
  const family = (id: string) => familyOf(catalog, 'codex', id);
  const routed = [...new Set(v.groups.map(group => policy.profiles[policy.routing.codex[group] ?? '']?.model)
    .filter((model): model is string => model !== undefined))];
  const overriddenRoutes = (record(structuredClone(override), 'routing').codex ?? {}) as Partial<Record<RouteGroup, unknown>>;
  const swaps = [...previousGenerationSwaps(override, defaults, 'codex')].filter(([model]) => available.has(model));
  // A swapped-in previous generation that Codex dropped is handled by the swap finding below.
  const swappedIn = new Set(swaps.map(([model]) => previousGeneration[model]!));

  for (const model of routed.filter(model => !policy.excludedModels.codex.includes(model) && !available.has(model) && !swappedIn.has(model))) {
    const { groups, profiles } = routesUsing(policy, 'codex', model);
    const options: FixOption[] = [];
    const restorable = groups.filter(group => overriddenRoutes[group] !== undefined
      && available.has(defaults.profiles[defaults.routing.codex[group] ?? '']?.model ?? ''));
    const restore = (target: Override) => {
      const routes = record(record(target, 'routing'), 'codex');
      for (const group of restorable) delete routes[group];
      if (!Object.keys(routes).length) delete record(target, 'routing').codex;
      if (!Object.keys(record(target, 'routing')).length) delete target.routing;
    };
    // Offer a restore only when it clears the missing model from every route: a profile
    // override can keep another group on it, and the restored routes must be runnable.
    if (restorable.length && restoreResolves(defaults, catalog, override, restore, model, restorable, available)) {
      options.push({ key: 'r', label: `Restore the shipped route for ${restorable.join(', ')}`, apply: restore });
    }
    const previous = previousGeneration[model];
    const swapped = structuredClone(override);
    if (previous) setProfileModel(swapped, profiles, previous);
    if (previous && available.has(previous) && ready(defaults, catalog, swapped)) {
      options.push({ key: 'p', label: `Use ${family(previous)} for ${groups.join(', ')} until you update Codex`, apply(target) {
        setProfileModel(target, profiles, previous);
      } });
    }
    options.push({ key: 'k', label: 'Keep the policy unchanged and update Codex with the installer you used', apply() {} });
    const excluded = structuredClone(override);
    setCodexExclusions(excluded, [...codexExclusions(excluded, defaults), model]);
    if (ready(defaults, catalog, excluded)) {
      const moved = substitutes(defaults, catalog, 'codex', excluded, groups);
      options.push({ key: 'e', label: `Exclude ${model}; ${groups.join(', ')} would use ${moved.join(', ')} instead`, apply(target) {
        const current = codexExclusions(target, defaults);
        if (!current.includes(model)) setCodexExclusions(target, [...current, model]);
      } });
    }
    findings.push({
      id: `codex-missing:${model}`,
      message: `Your installed Codex does not offer ${model}, which routes ${groups.join(', ')}. Automatic Codex launch fails until this is resolved.`,
      options, fallback: options[0]!.key,
    });
  }

  for (const [model, profiles] of swaps) {
    const previous = previousGeneration[model]!;
    const dropped = !available.has(previous);
    findings.push({
      id: `codex-swap:${model}`,
      message: `Your policy uses ${family(previous)} in place of ${family(model)}, and your installed Codex now offers ${family(model)}.`
        + (dropped ? ` It no longer offers ${family(previous)}, so automatic Codex launch fails until this is resolved.` : ''),
      options: [
        { key: 'u', label: `Use ${family(model)} again`, apply(target) { clearProfileModel(target, profiles); } },
        { key: 'k', label: `Keep ${family(previous)}`, apply() {} },
      ],
      fallback: dropped ? 'u' : 'k',
    });
  }

  for (const model of codexExclusions(override, defaults).filter(model => routed.includes(model) && available.has(model))) {
    findings.push({
      id: `codex-excluded:${model}`,
      message: `${model} is excluded in your policy, and your installed Codex now offers it.`,
      options: [
        { key: 'k', label: 'Keep it excluded', apply() {} },
        { key: 'i', label: `Include ${model} in automatic routing again`, apply(target) {
          setCodexExclusions(target, codexExclusions(target, defaults).filter(id => id !== model));
        } },
      ],
      fallback: 'k',
    });
  }
  return findings;
}

/** The semantic version in `claude --version` output such as "2.1.283 (Claude Code)". */
export function claudeCodeVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

function older(version: string, minimum: string): boolean {
  const [a, b] = [version, minimum].map(value => value.split('.').map(Number));
  for (let index = 0; index < 3; index++) if (a![index]! !== b![index]!) return a![index]! < b![index]!;
  return false;
}

/**
 * Compares routed Claude models with the installed Claude Code version. A release older
 * than a model's minimum rejects every request to it, so the safe default is the
 * previous-generation model until the user updates.
 */
export function planClaudeVersionFixes(policy: Policy, override: Override, version: string, defaults: Policy, catalog: Catalog): FixFinding[] {
  const findings: FixFinding[] = [];
  const family = (id: string) => familyOf(catalog, 'claude', id);
  const routed = [...new Set(v.groups.map(group => policy.profiles[policy.routing.claude[group] ?? '']?.model)
    .filter((model): model is string => model !== undefined && !policy.excludedModels.claude.includes(model)))];
  for (const model of routed.filter(model => minimumClaudeCode[model] && older(version, minimumClaudeCode[model]!))) {
    const { groups, profiles } = routesUsing(policy, 'claude', model);
    const options: FixOption[] = [];
    const previous = previousGeneration[model];
    const swapped = structuredClone(override);
    if (previous) setProfileModel(swapped, profiles, previous);
    if (previous && ready(defaults, catalog, swapped, 'claude')) {
      options.push({ key: 'p', label: `Use ${family(previous)} for ${groups.join(', ')} until you update Claude Code`, apply(target) {
        setProfileModel(target, profiles, previous);
      } });
    }
    options.push({ key: 'k', label: 'Keep the policy unchanged and update Claude Code (claude update)', apply() {} });
    findings.push({
      id: `claude-version:${model}`,
      message: `Your Claude Code ${version} cannot use ${family(model)} (${model}), which routes ${groups.join(', ')}; it needs ${minimumClaudeCode[model]} or newer. Those conversations fail until this is resolved.`,
      options, fallback: options[0]!.key,
    });
  }
  for (const [model, profiles] of previousGenerationSwaps(override, defaults, 'claude')) {
    if (minimumClaudeCode[model] && older(version, minimumClaudeCode[model]!)) continue;
    findings.push({
      id: `claude-swap:${model}`,
      message: `Your policy uses ${family(previousGeneration[model]!)} in place of ${family(model)}, and your Claude Code ${version} supports ${family(model)}.`,
      options: [
        { key: 'u', label: `Use ${family(model)} again`, apply(target) { clearProfileModel(target, profiles); } },
        { key: 'k', label: `Keep ${family(previousGeneration[model]!)}`, apply() {} },
      ],
      fallback: 'k',
    });
  }
  return findings;
}

/**
 * Claude Code has no local model list, so plan access cannot be detected offline. Ask about
 * the shipped highest-tier model and offer the strong profile when the plan cannot use it.
 */
export function planClaudeFixes(policy: Policy, override: Override, defaults: Policy, catalog: Catalog): FixFinding[] {
  const topProfile = defaults.routing.claude.demanding;
  const strongProfile = defaults.routing.claude.complex;
  if (!topProfile || !strongProfile) return [];
  const top = defaults.profiles[topProfile]!.model;
  const strong = defaults.profiles[strongProfile]!.model;
  const family = (id: string) => familyOf(catalog, 'claude', id);
  // The strong profile may run a previous-generation model until Claude Code is updated.
  const effectiveStrong = policy.profiles[strongProfile]?.model ?? strong;
  const routedTop = policy.profiles[policy.routing.claude.demanding ?? '']?.model;
  const replaced = (record(structuredClone(override), 'routing').claude as Override | undefined)?.demanding === strongProfile;
  if (routedTop === top && !policy.excludedModels.claude.includes(top)) {
    return [{
      id: 'claude-top',
      message: `${family(top)} (${top}) serves your highest Claude tier. Some Claude subscriptions require usage credits for it; a request then fails with "Usage credits are required for this model."`,
      options: [
        { key: 'k', label: `Keep ${family(top)}; my plan can use it`, apply() {} },
        { key: 'o', label: `Use ${family(effectiveStrong)} for the highest tier instead`, apply(target) {
          record(record(target, 'routing'), 'claude').demanding = strongProfile;
        } },
      ],
      fallback: 'k',
    }];
  }
  if (replaced && (effectiveStrong === strong || effectiveStrong === previousGeneration[strong])) {
    return [{
      id: 'claude-top',
      message: `Your highest Claude tier uses ${family(effectiveStrong)} instead of ${family(top)}.`,
      options: [
        { key: 'k', label: `Keep ${family(effectiveStrong)}`, apply() {} },
        { key: 'r', label: `Use ${family(top)} again; my plan can use it now`, apply(target) {
          const routes = record(record(target, 'routing'), 'claude');
          delete routes.demanding;
          if (!Object.keys(routes).length) delete record(target, 'routing').claude;
          if (!Object.keys(record(target, 'routing')).length) delete target.routing;
        } },
      ],
      fallback: 'k',
    }];
  }
  return [];
}

export type FixPlanner = (policy: Policy, override: Override) => FixFinding[];

/**
 * Asks each planner's findings in turn and re-plans after every answer, so later
 * questions describe the policy as already changed. Returns the edited override.
 */
export async function resolveFindings(planners: FixPlanner[], override: Override, defaults: Policy,
  ask: (finding: FixFinding) => Promise<string>): Promise<{ updated: Override; asked: number }> {
  const updated = structuredClone(override);
  let asked = 0;
  for (const planner of planners) {
    // Only questions from the first plan are asked; a change can resolve one or reword
    // its options, but never raises a follow-up (such as switching straight back).
    const pending = planner(mergePolicy(defaults, updated), updated).map(finding => finding.id);
    for (const id of pending) {
      const finding = planner(mergePolicy(defaults, updated), updated).find(candidate => candidate.id === id);
      if (!finding) continue;
      asked++;
      const answer = await ask(finding);
      finding.options.find(option => option.key === answer)!.apply(updated);
    }
  }
  return { updated, asked };
}
