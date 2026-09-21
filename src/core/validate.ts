export function object(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || (keys && !keys.includes(key))) {
      throw new Error(`${label}: unknown field ${key}`);
    }
  }
  return record;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be nonempty text without control characters`);
  }
  return value;
}

export function oneOf<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error(`${label} must be one of ${options.join(', ')}`);
  return value as T;
}

export function number(value: unknown, label: string, min: number, max: number, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`);
  return value;
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function unique<T>(values: T[], label: string): T[] {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate values`);
  return values;
}

export const tools = ['claude', 'codex'] as const;
export const reasoning = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const tiers = ['routine', 'standard', 'complex', 'demanding'] as const;
export const groups = [...tiers, 'uncertain'] as const;

export function effort(value: unknown, label: string): string | null {
  return value === null ? null : oneOf(value, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], label);
}
