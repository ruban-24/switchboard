import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicJsonWrite } from './storage.ts';

export interface Connection {
  version: 1;
  provider: 'typesafe' | 'vercel' | 'openrouter';
  apiKey: string;
  baseURL?: string;
  model?: string;
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.SWITCHBOARD_HOME) return resolve(env.SWITCHBOARD_HOME);
  return join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config'), 'switchboard');
}

function parseConnection(value: unknown): Connection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection');
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some(key => !['version', 'provider', 'apiKey', 'baseURL', 'model'].includes(key)) || c.version !== 1 || !['typesafe', 'vercel', 'openrouter'].includes(String(c.provider))) throw new Error('Invalid connection');
  for (const field of ['apiKey', 'baseURL', 'model'] as const) {
    if (c[field] === undefined && field !== 'apiKey') continue;
    if (typeof c[field] !== 'string' || !c[field].trim() || c[field].length > 8192 || /[\x00-\x1f\x7f]/.test(c[field])) throw new Error('Invalid connection');
  }
  return c as unknown as Connection;
}

export async function readConnection(root: string): Promise<Connection | null> {
  let raw: string;
  try { raw = await readFile(join(root, 'connection.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot read Switchboard connection.json');
  }
  try { if (raw.length > 32768) throw new Error(); return parseConnection(JSON.parse(raw)); }
  catch { throw new Error('Invalid Switchboard connection.json; fix the file before running init again'); }
}

export async function saveConnection(root: string, value: Connection): Promise<void> {
  try { parseConnection(value); }
  catch { throw new Error('Invalid Switchboard connection settings'); }
  await atomicJsonWrite(join(root, 'connection.json'), value);
}

export function credentialKeys(provider: string): string[] {
  return ['SWITCHBOARD_API_KEY', ...(provider === 'typesafe' ? ['JEV_API_KEY', 'TYPESAFE_API_KEY'] : provider === 'vercel' ? ['AI_GATEWAY_API_KEY'] : provider === 'openrouter' ? ['OPENROUTER_API_KEY'] : [])];
}

/** Shell values override saved settings; switching providers never inherits a different provider's key. */
export async function connectionEnvironment(root: string, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  env = { ...env };
  // Empty placeholders in .env files have the same meaning as an unset option
  // in the adapters. They must not hide credentials saved by interactive init.
  const optionalKeys = ['SWITCHBOARD_PROVIDER', 'SWITCHBOARD_MODEL', 'SWITCHBOARD_BASE_URL', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_BASE_URL',
    ...credentialKeys('typesafe'), ...credentialKeys('vercel'), ...credentialKeys('openrouter')];
  for (const key of optionalKeys) if (env[key] !== undefined && !env[key]!.trim()) delete env[key];
  const saved = await readConnection(root);
  const explicitProvider = env.SWITCHBOARD_PROVIDER === undefined ? undefined : env.SWITCHBOARD_PROVIDER.trim() || 'typesafe';
  if (!saved || (explicitProvider !== undefined && explicitProvider !== saved.provider)) return { ...env };
  const defaults: NodeJS.ProcessEnv = { SWITCHBOARD_PROVIDER: saved.provider };
  if (!credentialKeys(saved.provider).some(key => env[key] !== undefined)) defaults.SWITCHBOARD_API_KEY = saved.apiKey;
  if (saved.model && env.SWITCHBOARD_MODEL === undefined && !(saved.provider === 'typesafe' && env.TYPESAFE_DEFAULT_MODEL !== undefined)) defaults.SWITCHBOARD_MODEL = saved.model;
  if (saved.baseURL && env.SWITCHBOARD_BASE_URL === undefined && !(saved.provider === 'typesafe' && env.TYPESAFE_BASE_URL !== undefined)) defaults.SWITCHBOARD_BASE_URL = saved.baseURL;
  return { ...defaults, ...env };
}
