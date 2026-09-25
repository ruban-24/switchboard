import { mergePolicy, validateMappings } from './core/config.ts';
import type { Catalog, Policy, RouteGroup } from './core/types.ts';
import * as v from './core/validate.ts';

type Override = Record<string, unknown>;

export interface FixOption {
  key: string;
  label: string;
  /** Set when choosing this option confirms plan access to a model, so doctor need not ask again. */
  keeps?: string;
  apply(override: Override): void;
}

export interface FixFinding {
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

function ready(defaults: Policy, catalog: Catalog, override: Override): boolean {
  try { return validateMappings(mergePolicy(defaults, override), catalog, 'codex').ready; }
  catch { return false; }
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
  const groupsFor = (model: string) => v.groups.filter(group => {
    const name = policy.routing.codex[group];
    return name !== null && policy.profiles[name]?.model === model;
  });
  const routed = [...new Set(v.groups.map(group => policy.profiles[policy.routing.codex[group] ?? '']?.model)
    .filter((model): model is string => model !== undefined))];
  const overriddenRoutes = (record(structuredClone(override), 'routing').codex ?? {}) as Partial<Record<RouteGroup, unknown>>;

  for (const model of routed.filter(model => !policy.excludedModels.codex.includes(model) && !available.has(model))) {
    const groups = groupsFor(model);
    const options: FixOption[] = [];
    const restorable = groups.filter(group => overriddenRoutes[group] !== undefined
      && available.has(defaults.profiles[defaults.routing.codex[group] ?? '']?.model ?? ''));
    if (restorable.length) {
      options.push({ key: 'r', label: `Restore the shipped route for ${restorable.join(', ')}`, apply(target) {
        const routes = record(record(target, 'routing'), 'codex');
        for (const group of restorable) delete routes[group];
        if (!Object.keys(routes).length) delete record(target, 'routing').codex;
        if (!Object.keys(record(target, 'routing')).length) delete target.routing;
      } });
    }
    const excluded = structuredClone(override);
    setCodexExclusions(excluded, [...codexExclusions(excluded, defaults), model]);
    if (ready(defaults, catalog, excluded)) {
      options.push({ key: 'e', label: `Exclude ${model}; new conversations use the next eligible tier`, apply(target) {
        const current = codexExclusions(target, defaults);
        if (!current.includes(model)) setCodexExclusions(target, [...current, model]);
      } });
    }
    options.push({ key: 'k', label: 'Keep the policy unchanged and update Codex with the installer you used', apply() {} });
    findings.push({
      message: `Your installed Codex does not offer ${model}, which routes ${groups.join(', ')}. Automatic Codex launch fails until this is resolved.`,
      options, fallback: options[0]!.key,
    });
  }

  for (const model of codexExclusions(override, defaults).filter(model => routed.includes(model) && available.has(model))) {
    findings.push({
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

/**
 * Claude Code has no local model list, so plan access cannot be detected offline. Ask about
 * the shipped highest-tier model and offer the strong profile when the plan cannot use it.
 */
export function planClaudeFixes(policy: Policy, override: Override, defaults: Policy, catalog: Catalog, keptTopModel?: string): FixFinding[] {
  const topProfile = defaults.routing.claude.demanding;
  const strongProfile = defaults.routing.claude.complex;
  if (!topProfile || !strongProfile) return [];
  const top = defaults.profiles[topProfile]!.model;
  const strong = defaults.profiles[strongProfile]!.model;
  const family = (id: string) => catalog.models.find(model => model.id === id && model.tool === 'claude')?.family ?? id;
  const routedTop = policy.profiles[policy.routing.claude.demanding ?? '']?.model;
  const replaced = (record(structuredClone(override), 'routing').claude as Override | undefined)?.demanding === strongProfile;
  if (routedTop === top && !policy.excludedModels.claude.includes(top)) {
    if (keptTopModel === top) return [];
    return [{
      message: `${family(top)} (${top}) serves your highest Claude tier. Some Claude subscriptions require usage credits for it; a request then fails with "Usage credits are required for this model."`,
      options: [
        { key: 'k', label: `Keep ${family(top)}; my plan can use it`, keeps: top, apply() {} },
        { key: 'o', label: `Use ${family(strong)} for the highest tier instead`, apply(target) {
          record(record(target, 'routing'), 'claude').demanding = strongProfile;
        } },
      ],
      fallback: 'k',
    }];
  }
  if (replaced && policy.profiles[strongProfile]?.model === strong) {
    return [{
      message: `Your highest Claude tier uses ${family(strong)} instead of ${family(top)}.`,
      options: [
        { key: 'k', label: `Keep ${family(strong)}`, apply() {} },
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
