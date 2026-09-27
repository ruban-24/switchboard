import {
  createJevClassifier, createVercelJevClassifier, typesafeModel,
  TYPESAFE_BASE_URL, VERCEL_BASE_URL, VERCEL_JEV_MODEL,
} from './jev.ts';
import { createLayaClassifier, LAYA_BASE_URL, LAYA_MODEL } from './laya.ts';

function loopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
}

function baseURL(value: string): string {
  const message = 'Classifier base URL must use HTTPS (HTTP is allowed for loopback) and contain no credentials, query, or fragment';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url)))
    || url.username || url.password || /[?#\u0000-\u0020\u007f]/.test(value)) throw new Error(message);
  return url.href.replace(/\/+$/, '');
}

function modelId(value: string): string {
  if (!/^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,199}$/.test(value)) {
    throw new Error('Classifier model ID must contain only letters, numbers, and . _ / : ~ -');
  }
  return value;
}

function settings(env: NodeJS.ProcessEnv) {
  const provider = env.SWITCHBOARD_PROVIDER?.trim() || 'typesafe';
  const commonKey = env.SWITCHBOARD_API_KEY?.trim();
  const customURL = env.SWITCHBOARD_BASE_URL?.trim();
  const customModel = env.SWITCHBOARD_MODEL?.trim();
  if (provider === 'typesafe') return {
    provider, label: 'TypeSafe', adapter: 'typesafe-system-one', modelId: modelId(typesafeModel(env)),
    baseURL: baseURL(customURL || env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_BASE_URL),
    credentialEnvironment: 'JEV_API_KEY or TYPESAFE_API_KEY or SWITCHBOARD_API_KEY',
    apiKey: commonKey || env.JEV_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim(),
  } as const;
  if (provider === 'openrouter') return {
    provider, label: 'OpenRouter', adapter: 'typesafe-system-one', modelId: modelId(customModel || 'jev-latest'),
    baseURL: baseURL(customURL || 'https://openrouter.ai/api'),
    credentialEnvironment: 'OPENROUTER_API_KEY or SWITCHBOARD_API_KEY', apiKey: commonKey || env.OPENROUTER_API_KEY?.trim(),
  } as const;
  if (provider === 'vercel') return {
    provider, label: 'Vercel AI Gateway', adapter: 'vercel-evaluation', modelId: modelId(customModel || VERCEL_JEV_MODEL),
    baseURL: baseURL(customURL || VERCEL_BASE_URL),
    credentialEnvironment: 'AI_GATEWAY_API_KEY or SWITCHBOARD_API_KEY', apiKey: commonKey || env.AI_GATEWAY_API_KEY?.trim(),
  } as const;
  if (provider === 'laya') {
    const url = baseURL(customURL || LAYA_BASE_URL);
    return {
      provider, label: 'Laya (self-hosted)', adapter: 'laya-system-one', modelId: modelId(customModel || LAYA_MODEL), baseURL: url,
      // laya-serve is keyless by default; only a server on this machine may omit a key.
      credentialEnvironment: 'LAYA_API_KEY or SWITCHBOARD_API_KEY', credentialRequired: !loopback(new URL(url)),
      apiKey: commonKey || env.LAYA_API_KEY?.trim(),
    } as const;
  }
  throw new Error('SWITCHBOARD_PROVIDER must be typesafe, vercel, openrouter, or laya');
}

/** Safe for doctor output; never returns credential values. */
export function classifierStatus(env: NodeJS.ProcessEnv = process.env) {
  const { apiKey, ...status } = settings(env);
  return { credentialRequired: true, ...status, credentialPresent: !!apiKey };
}

export function createConfiguredClassifier(env: NodeJS.ProcessEnv = process.env) {
  const config = settings(env);
  if (config.provider === 'laya') {
    if (config.credentialRequired && !config.apiKey) throw new Error(`Set ${config.credentialEnvironment}; a Laya server on another host requires an API key`);
    return createLayaClassifier(config.apiKey, config.modelId, config.baseURL);
  }
  if (!config.apiKey) throw new Error(`Set ${config.credentialEnvironment} before using Jev classification`);
  return config.provider === 'vercel'
    ? createVercelJevClassifier(config.apiKey, config.modelId, config.baseURL)
    : createJevClassifier(config.apiKey, undefined, config.modelId, { baseURL: config.baseURL, provider: config.provider });
}
