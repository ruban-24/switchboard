import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergePolicy, validateMappings } from './core/config.ts';
import type { Catalog, Policy } from './core/types.ts';
import * as v from './core/validate.ts';
import { atomicJsonWrite } from './storage.ts';

export type Override = Record<string, unknown>;

export interface PersonalPolicy { override: Override; exists: boolean; file: string }

export async function readOverride(root: string): Promise<PersonalPolicy> {
  const file = join(root, 'policy.json');
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { override: {}, exists: false, file };
    throw new Error(`Cannot read personal policy: ${file}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`Personal policy is not valid JSON: ${file}`); }
  return { override: v.object(parsed, 'policy'), exists: true, file };
}

/** Merges and validates an override; every enabled agent must remain routable. */
export function effectivePolicy(defaults: Policy, catalog: Catalog, override: Override): Policy {
  const policy = mergePolicy(defaults, override);
  const readiness = validateMappings(policy, catalog);
  if (!readiness.ready) throw new Error(`Automatic routing would not be configured: ${readiness.missing.join(', ')}`);
  return policy;
}

/** Writes a validated override, keeping the previous file as policy.json.bak. */
export async function saveOverride(personal: PersonalPolicy, override: Override): Promise<string | null> {
  let backup: string | null = null;
  if (personal.exists) {
    backup = `${personal.file}.bak`;
    await copyFile(personal.file, backup);
  }
  await atomicJsonWrite(personal.file, override);
  return backup;
}

const segment = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function parsePath(path: string): string[] {
  const parts = path.split('.');
  if (!parts.length || parts.some(part => !segment.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error(`Invalid setting name: ${path}`);
  }
  return parts;
}

export function getPath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = (current as Override)[part];
  }
  return current;
}

export function setPath(override: Override, parts: string[], value: unknown): void {
  let current = override;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) current[part] = {};
    current = current[part] as Override;
  }
  current[parts.at(-1)!] = structuredClone(value);
}

/** Removes a setting and any objects it leaves empty, so the shipped default applies again. */
export function unsetPath(override: Override, parts: string[]): boolean {
  const [head, ...rest] = parts;
  if (!head || !Object.hasOwn(override, head)) return false;
  if (!rest.length) { delete override[head]; return true; }
  const child = override[head];
  if (!child || typeof child !== 'object' || Array.isArray(child)) return false;
  const removed = unsetPath(child as Override, rest);
  if (removed && !Object.keys(child).length) delete override[head];
  return removed;
}

/** Command-line values are JSON when they parse as JSON, and plain text otherwise. */
export function parseValue(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return raw; }
}

function leaves(value: unknown, prefix: string[], out: Map<string, string>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) leaves(child, [...prefix, key], out);
  } else out.set(prefix.join('.'), JSON.stringify(value));
}

/** Human-readable effective changes between two overrides, e.g. `routing.codex.standard: "a" → "b"`. */
export function describeChanges(defaults: Policy, before: Override, after: Override): string[] {
  const old = new Map<string, string>();
  const updated = new Map<string, string>();
  leaves(mergePolicy(defaults, before), [], old);
  leaves(mergePolicy(defaults, after), [], updated);
  const keys = [...new Set([...old.keys(), ...updated.keys()])].sort();
  return keys.filter(key => old.get(key) !== updated.get(key))
    .map(key => `${key}: ${old.get(key) ?? '(none)'} → ${updated.get(key) ?? '(none)'}`);
}
