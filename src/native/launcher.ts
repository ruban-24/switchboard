import { lstat, readFile, realpath, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as osConstants, homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import type { Tool } from '../core/types.ts';
import { AUTO_MODEL, TOKEN_ENV, TOKEN_HEADER } from './protocol.ts';

export interface NativeProxyDetails { url: string; token: string }
export interface PrepareNativeLaunchOptions {
  tool: Tool;
  args: string[];
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  proxy?: NativeProxyDetails;
  codexCatalog?: unknown;
  stateDirectory?: string;
}
export interface PreparedNativeLaunch {
  mode: 'bypass' | 'automatic';
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}
export interface NativeRunnerDependencies {
  spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

const noop = async () => {};
const claudeAdmin = new Set(['auth', 'config', 'doctor', 'install', 'mcp', 'plugin', 'setup-token', 'status', 'update']);
const codexAdmin = new Set(['completion', 'features', 'help', 'login', 'logout', 'mcp']);
const helpFlags = new Set(['--help', '-h', '--version', '-V', '-v']);

interface ScannedArguments { command?: string; flags: Map<string, string | null>; configs: string[]; configSpans: Array<{ start: number; end: number }>; settingsSpans: Array<{ start: number; end: number }> }
const valueOptions: Record<Tool, ReadonlyMap<string, string>> = {
  claude: new Map(Object.entries({
    '--add-dir': '--add-dir', '--agent': '--agent', '--agents': '--agents', '--allowedTools': '--allowed-tools', '--allowed-tools': '--allowed-tools',
    '--append-system-prompt': '--append-system-prompt', '--autocompact': '--autocompact', '--betas': '--betas', '--cloud': '--cloud', '--debug': '--debug', '-d': '--debug',
    '--debug-file': '--debug-file', '--disallowedTools': '--disallowed-tools', '--disallowed-tools': '--disallowed-tools', '--effort': '--effort',
    '--environment': '--environment', '--fallback-model': '--fallback-model', '--file': '--file', '--from-pr': '--from-pr', '--input-format': '--input-format', '--json-schema': '--json-schema',
    '--max-budget-usd': '--max-budget-usd', '--max-turns': '--max-turns', '--mcp-config': '--mcp-config', '--model': '--model', '-m': '--model',
    '--name': '--name', '-n': '--name', '--output-format': '--output-format', '--permission-mode': '--permission-mode', '--plugin-dir': '--plugin-dir',
    '--plugin-url': '--plugin-url', '--prompt-suggestions': '--prompt-suggestions', '--remote-control': '--remote-control',
    '--remote-control-session-name-prefix': '--remote-control-session-name-prefix', '--resume': '--resume', '-r': '--resume', '--session-id': '--session-id',
    '--setting-sources': '--setting-sources', '--settings': '--settings', '--system-prompt': '--system-prompt', '--teleport': '--teleport', '--tools': '--tools',
    '--worktree': '--worktree', '-w': '--worktree',
  })),
  codex: new Map(Object.entries({
    '--config': '--config', '-c': '--config', '--model': '--model', '-m': '--model', '--profile': '--profile', '-p': '--profile',
    '--cd': '--cd', '-C': '--cd', '--ask-for-approval': '--ask-for-approval', '-a': '--ask-for-approval', '--sandbox': '--sandbox', '-s': '--sandbox',
    '--add-dir': '--add-dir', '--image': '--image', '-i': '--image', '--local-provider': '--local-provider',
    '--remote': '--remote', '--remote-auth-token-env': '--remote-auth-token-env', '--enable': '--enable', '--disable': '--disable',
    '--output-last-message': '--output-last-message', '-o': '--output-last-message', '--output-schema': '--output-schema',
    '--color': '--color', '--thread-source': '--thread-source',
  })),
};
const optionalOptions: Record<Tool, ReadonlySet<string>> = {
  claude: new Set(['--cloud', '--debug', '--from-pr', '--prompt-suggestions', '--remote-control', '--resume', '--teleport', '--worktree']),
  codex: new Set(),
};
const variadicOptions: Record<Tool, ReadonlySet<string>> = {
  claude: new Set(['--add-dir', '--allowed-tools', '--betas', '--disallowed-tools', '--file', '--mcp-config', '--tools']),
  codex: new Set(['--image']),
};

function scanArguments(tool: Tool, args: string[]): ScannedArguments {
  const result: ScannedArguments = { flags: new Map(), configs: [], configSpans: [], settingsSpans: [] };
  const options = valueOptions[tool];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') break;
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    if (equals > 0) {
      const name = token.slice(0, equals);
      const canonical = options.get(name) ?? name;
      const value = token.slice(equals + 1);
      result.flags.set(canonical, value);
      if (canonical === '--config') { result.configs.push(value); result.configSpans.push({ start: i, end: i + 1 }); }
      if (tool === 'claude' && canonical === '--settings') result.settingsSpans.push({ start: i, end: i + 1 });
      continue;
    }
    const canonical = options.get(token);
    if (canonical) {
      const start = i;
      let value = '';
      const arity = variadicOptions[tool].has(canonical) ? 'variadic' : optionalOptions[tool].has(canonical) ? 'optional' : 'required';
      if (arity === 'variadic') {
        const values: string[] = [];
        while (i + 1 < args.length && args[i + 1] !== '--' && !args[i + 1]!.startsWith('-')) values.push(args[++i]!);
        value = values[0] ?? '';
      } else if (args[i + 1] !== undefined && (arity === 'required' || !args[i + 1]!.startsWith('-'))) {
        value = args[i + 1] ?? '';
        i++;
      }
      result.flags.set(canonical, value);
      if (canonical === '--config') { result.configs.push(value); result.configSpans.push({ start, end: i + 1 }); }
      if (tool === 'claude' && canonical === '--settings') result.settingsSpans.push({ start, end: i + 1 });
      continue;
    }
    if (/^-[A-Za-z].+/.test(token)) {
      const short = token.slice(0, 2);
      const attached = options.get(short);
      if (attached) {
        const value = token.slice(2);
        result.flags.set(attached, value);
        if (attached === '--config') { result.configs.push(value); result.configSpans.push({ start: i, end: i + 1 }); }
        continue;
      }
    }
    if (token.startsWith('-')) { result.flags.set(token, null); continue; }
    result.command ??= token;
  }
  return result;
}

function isExplicitConfig(value: string): boolean {
  const key = value.split('=', 1)[0]?.trim();
  return key === 'model' || key === 'model_provider' || key === 'model_reasoning_effort'
    || key?.startsWith('model_providers.') === true;
}

function bypass(tool: Tool, args: string[]): boolean {
  const scanned = scanArguments(tool, args);
  if ([...scanned.flags.keys()].some(arg => helpFlags.has(arg))) return true;
  if (scanned.command && (tool === 'claude' ? claudeAdmin : codexAdmin).has(scanned.command)) return true;
  if (scanned.flags.has('--model') || scanned.flags.has('--effort')) return true;
  if (tool === 'codex') {
    if (scanned.flags.has('--profile')) return true;
    if (scanned.configs.some(isExplicitConfig)) return true;
  }
  return false;
}

export function nativeBypassesRouting(tool: Tool, args: string[]): boolean { return bypass(tool, args); }

async function readJsonObject(file: string, label: string, optional = true): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read or parse ${label}; provide a readable JSON object file; automatic routing did not start`);
  }
}

async function rejectCustomConnection(tool: Tool, home: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (tool === 'claude') {
    if (env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST || env.ANTHROPIC_BASE_URL || env.ANTHROPIC_CUSTOM_HEADERS
      || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) {
      throw new Error('Automatic routing does not support a managed or custom Claude connection; use the native CLI directly');
    }
    return;
  }
  if (env.OPENAI_BASE_URL) throw new Error('Automatic routing does not support a custom Codex provider; use the native CLI directly');
  const file = join(env.CODEX_HOME || join(home, '.codex'), 'config.toml');
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Cannot read Codex configuration; automatic routing did not start'); }
  let config: Record<string, unknown>;
  try { config = parseToml(raw) as Record<string, unknown>; }
  catch { throw new Error('Cannot parse Codex configuration; automatic routing did not start'); }
  if (typeof config.model_provider === 'string' && config.model_provider !== 'openai') {
    throw new Error('Automatic routing does not support a custom Codex provider; use the native CLI directly');
  }
  const providers = config.model_providers;
  const selected = typeof config.model_provider === 'string' ? config.model_provider : 'openai';
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const provider = (providers as Record<string, unknown>)[selected];
    if (provider && typeof provider === 'object' && !Array.isArray(provider)
      && typeof (provider as Record<string, unknown>).base_url === 'string') {
      throw new Error('Automatic routing does not support a custom Codex provider endpoint; use the native CLI directly');
    }
  }
}

function rejectClaudeSettingsMode(settings: Record<string, unknown>): void {
  if (settings.disableAllHooks === true) throw new Error('Automatic routing requires Claude hooks; use an explicit --model when hooks are disabled');
  if (settings.allowManagedHooksOnly === true) throw new Error('Automatic routing cannot install hooks when only managed Claude hooks are allowed; use the native CLI directly');
  const configured = settings.env;
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
    const keys = Object.keys(configured);
    if (keys.some(key => ['ANTHROPIC_MODEL', TOKEN_ENV, 'SWITCHBOARD_HOOK_URL'].includes(key))) {
      throw new Error('Claude settings cannot override Switchboard model or hook transport; remove ANTHROPIC_MODEL, SWITCHBOARD_TOKEN, and SWITCHBOARD_HOOK_URL from settings.env, or use an explicit --model');
    }
    if (keys.some(key => ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].includes(key))) {
      throw new Error('Automatic routing does not support a managed or custom Claude connection; use the native CLI directly');
    }
  }
}

function rejectUnsupportedMode(tool: Tool, args: string[]): void {
  const scanned = scanArguments(tool, args);
  if (tool === 'claude' && ['--bare', '--remote-control', '--bg', '--background', '--cloud', '--safe-mode'].some(flag => scanned.flags.has(flag))) {
    const hookless = scanned.flags.has('--bare') ? '--bare disables the required hooks'
      : scanned.flags.has('--safe-mode') ? '--safe-mode disables the required hooks' : null;
    throw new Error(`${hookless ?? 'Claude background, cloud, or remote-control mode is unsupported'}; use an explicit --model to run it natively`);
  }
  if (tool === 'codex' && scanned.command && ['cloud', 'app-server', 'mcp-server'].includes(scanned.command)) {
    throw new Error('Codex background or remote mode is unsupported by automatic routing; use an explicit --model to run it natively');
  }
}

function takeClaudeSettings(args: string[]): { args: string[]; value?: string } {
  const scanned = scanArguments('claude', args);
  const result: string[] = [];
  let cursor = 0;
  for (const span of scanned.settingsSpans) {
    result.push(...args.slice(cursor, span.start));
    cursor = span.end;
  }
  result.push(...args.slice(cursor));
  return { args: result, value: scanned.flags.get('--settings') ?? undefined };
}

async function explicitSettings(value: string | undefined, cwd: string): Promise<Record<string, unknown>> {
  if (value === undefined) return {};
  if (!value.trim()) throw new Error('Empty explicit Claude settings; provide a JSON object or readable file; automatic routing did not start');
  if (value.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch { throw new Error('Cannot parse explicit Claude settings; automatic routing did not start'); }
  }
  return readJsonObject(resolve(cwd, value), 'explicit Claude settings', false);
}

async function claudeRootLocalSettings(home: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (process.platform === 'win32' || !process.getuid) return null;
  const uid = process.getuid();
  try {
    const userHome = await realpath(home).catch(() => resolve(home));
    const ownedRoot = async (root: string) => {
      if (root === userHome) return false;
      for (const path of [root, join(root, '.git'), join(root, '.claude')]) {
        try {
          const [entry, target] = await Promise.all([lstat(path), stat(path)]);
          if (entry.uid !== uid || target.uid !== uid) return false;
        } catch (error) {
          if (path === join(root, '.claude') && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      return true;
    };
    // Find whether the starting folder belongs to a repository before invoking
    // Git. Outside repositories, Claude keeps both project files at cwd.
    let root = await realpath(cwd);
    while (true) {
      try { await lstat(join(root, '.git')); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(root);
      if (parent === root) return null;
      root = parent;
    }
    if (!await ownedRoot(root)) return null;
    // Git documents that its first NUL-delimited worktree record is the main
    // checkout. This also handles linked worktrees and separate Git directories.
    const gitEnv: NodeJS.ProcessEnv = { ...env, PATH: env.PATH ?? process.env.PATH, GIT_OPTIONAL_LOCKS: '0' };
    for (const key of ['OPENROUTER_API_KEY', 'SWITCHBOARD_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY']) delete gitEnv[key];
    const output = await new Promise<string>((resolveOutput, reject) => {
      execFile('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'list', '--porcelain', '-z'], {
        cwd, env: gitEnv, timeout: 1000, maxBuffer: 64 * 1024, encoding: 'utf8',
      }, (error, stdout) => error ? reject(error) : resolveOutput(stdout));
    });
    const record = output.split('\0\0', 1)[0]!.split('\0');
    const first = record[0];
    if (!first?.startsWith('worktree ') || record.includes('bare')) throw new Error();
    const main = first.slice('worktree '.length);
    if (!isAbsolute(main)) throw new Error();
    const mainRoot = await realpath(main);
    if (!await ownedRoot(mainRoot)) return null;
    return join(mainRoot, '.claude', 'settings.local.json');
  } catch {
    throw new Error('Cannot resolve Claude repository-local settings; automatic routing did not start; use an explicit --model to run natively');
  }
}

async function claudeSettings(args: string[], home: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ explicit: Record<string, unknown>; statusLine: Record<string, unknown> }> {
  const sourceOption = scanArguments('claude', args).flags.get('--setting-sources');
  const sources = new Set(sourceOption === undefined ? ['user', 'project', 'local'] : (sourceOption ?? '').split(',').filter(Boolean));
  const files: Array<[string, string]> = [
    ['user', join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json')],
    ['project', join(cwd, '.claude', 'settings.json')],
    ['local', join(cwd, '.claude', 'settings.local.json')],
  ];
  if (sources.has('local')) {
    const rootLocal = await claudeRootLocalSettings(home, cwd, env);
    if (rootLocal && rootLocal !== resolve(cwd, '.claude', 'settings.local.json')) files.push(['local', rootLocal]);
  }
  let statusLine: Record<string, unknown> = {};
  const inspect = (settings: Record<string, unknown>) => {
    rejectClaudeSettingsMode(settings);
    if (settings.statusLine !== undefined) {
      const value = settings.statusLine;
      statusLine = value && typeof value === 'object' && !Array.isArray(value)
        ? { ...statusLine, ...value } : {};
    }
  };
  for (const [source, file] of files) {
    if (sources.has(source)) inspect(await readJsonObject(file, `Claude ${source} settings`));
  }
  const explicit = await explicitSettings(takeClaudeSettings(args).value, cwd);
  inspect(explicit);
  return { explicit, statusLine };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function prepareClaude(args: string[], env: NodeJS.ProcessEnv, proxy: NativeProxyDetails, loaded: Awaited<ReturnType<typeof claudeSettings>>, stateDirectory: string): Promise<PreparedNativeLaunch> {
  const extracted = takeClaudeSettings(args);
  const settings = structuredClone(loaded.explicit);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks as Record<string, unknown> : {};
  const existing = hooks.UserPromptSubmit;
  if (existing !== undefined && !Array.isArray(existing)) throw new Error('Claude UserPromptSubmit hooks must be an array');
  const helper = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './claude-hook.ts' : './claude-hook.js', import.meta.url));
  // Exec form keeps install paths and prompt data out of shell interpretation.
  const commandHook = (event: string) => ({ type: 'command', command: process.execPath, args: [helper, event], timeout: 10 });
  const adapter = { hooks: [commandHook('UserPromptSubmit')] };
  hooks.UserPromptSubmit = [...(existing as unknown[] | undefined ?? []), adapter];
  const sessions = hooks.SessionStart;
  if (sessions !== undefined && !Array.isArray(sessions)) throw new Error('Claude SessionStart hooks must be an array');
  hooks.SessionStart = [...(sessions as unknown[] | undefined ?? []), {
    hooks: [commandHook('SessionStart')],
  }];
  settings.hooks = hooks;
  const temp = await mkdtemp(join(tmpdir(), 'switchboard-settings-'));
  const file = join(temp, 'settings.json');
  try {
    if (env.SWITCHBOARD_STATUSLINE !== 'off' && ['darwin', 'linux'].includes(process.platform)) {
      const statusHelper = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './claude-statusline.ts' : './claude-statusline.js', import.meta.url));
      const configFile = join(temp, 'statusline.json');
      const command = loaded.statusLine.type === 'command' && typeof loaded.statusLine.command === 'string' ? loaded.statusLine.command : undefined;
      await writeFile(configFile, JSON.stringify({ stateDirectory, command }), { mode: 0o600 });
      settings.statusLine = {
        ...loaded.statusLine, type: 'command', command: [process.execPath, statusHelper, configFile].map(shellQuote).join(' '),
      };
    }
    await writeFile(file, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
  }
  catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
  return {
    mode: 'automatic', args: ['--settings', file, ...extracted.args],
    env: { ...env, ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_MODEL: AUTO_MODEL, ANTHROPIC_CUSTOM_HEADERS: `${TOKEN_HEADER}: ${proxy.token}`, CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1', [TOKEN_ENV]: proxy.token, SWITCHBOARD_HOOK_URL: proxy.url, JEV_API_KEY: undefined, TYPESAFE_API_KEY: undefined },
    cleanup: () => rm(temp, { recursive: true, force: true }),
  };
}

async function prepareCodex(args: string[], env: NodeJS.ProcessEnv, proxy: NativeProxyDetails, catalog?: unknown): Promise<PreparedNativeLaunch> {
  const scanned = scanArguments('codex', args);
  const nativeArgs: string[] = [];
  let cursor = 0;
  for (const span of scanned.configSpans) {
    nativeArgs.push(...args.slice(cursor, span.start));
    cursor = span.end;
  }
  nativeArgs.push(...args.slice(cursor));
  // Codex's exec/resume override vectors can replace root -c flags. Keep all
  // overrides at the root so unrelated user settings cannot discard the proxy.
  const configs = [
    ...scanned.configs,
    `model_provider="switchboard"`,
    `model_providers.switchboard.name="Switchboard"`,
    `model_providers.switchboard.base_url="${proxy.url}"`,
    `model_providers.switchboard.wire_api="responses"`,
    `model_providers.switchboard.requires_openai_auth=true`,
    `model_providers.switchboard.supports_websockets=false`,
    `model_providers.switchboard.env_http_headers={"${TOKEN_HEADER}"="${TOKEN_ENV}"}`,
    `model_providers.switchboard.request_max_retries=0`,
  ];
  let cleanup = noop;
  if (catalog !== undefined) {
    const temp = await mkdtemp(join(tmpdir(), 'switchboard-codex-'));
    const file = join(temp, 'models.json');
    cleanup = () => rm(temp, { recursive: true, force: true });
    try { await writeFile(file, JSON.stringify(catalog), { mode: 0o600 }); }
    catch (error) { await cleanup(); throw error; }
    configs.push(`model_catalog_json=${JSON.stringify(file)}`, 'model_reasoning_effort="auto"');
  }
  return {
    mode: 'automatic', args: ['-m', AUTO_MODEL, ...configs.flatMap(value => ['-c', value]), ...nativeArgs],
    env: { ...env, [TOKEN_ENV]: proxy.token, JEV_API_KEY: undefined, TYPESAFE_API_KEY: undefined }, cleanup,
  };
}

export async function prepareNativeLaunch(options: PrepareNativeLaunchOptions): Promise<PreparedNativeLaunch> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const key of ['OPENROUTER_API_KEY', 'SWITCHBOARD_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY']) delete env[key];
  if (bypass(options.tool, options.args)) return { mode: 'bypass', args: [...options.args], env: { ...env, JEV_API_KEY: undefined, TYPESAFE_API_KEY: undefined }, cleanup: noop };
  rejectUnsupportedMode(options.tool, options.args);
  const home = options.home ?? env.HOME ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  await rejectCustomConnection(options.tool, home, env);
  const proxy = options.proxy ?? { url: 'http://127.0.0.1:1', token: '' };
  if (options.tool === 'claude') {
    const loaded = await claudeSettings(options.args, home, cwd, env);
    const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
    const stateDirectory = resolve(cwd, options.stateDirectory ?? env.SWITCHBOARD_HOME ?? join(configHome, 'switchboard'));
    return prepareClaude(options.args, env, proxy, loaded, stateDirectory);
  }
  return prepareCodex(options.args, env, proxy, options.codexCatalog);
}

export async function validateNativeAutomatic(tool: Tool, args: string[], home: string, env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<void> {
  rejectUnsupportedMode(tool, args);
  await rejectCustomConnection(tool, home, env);
  if (tool === 'claude') await claudeSettings(args, home, cwd, env);
}

function signalStatus(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  return 128 + (osConstants.signals[signal] ?? 1);
}

export async function runPreparedNative(executable: string, prepared: PreparedNativeLaunch, dependencies: NativeRunnerDependencies = {}): Promise<number> {
  const spawnChild = dependencies.spawn ?? spawn;
  let child: ChildProcess;
  try { child = spawnChild(executable, prepared.args, { env: prepared.env, stdio: 'inherit' }); }
  catch (error) { await prepared.cleanup(); throw new Error(`Cannot start native CLI: ${error instanceof Error ? error.message : 'spawn failed'}`); }
  const forward = (signal: NodeJS.Signals) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const hup = () => forward('SIGHUP');
  const term = () => forward('SIGTERM');
  const interrupt = () => { if (!process.stdin.isTTY) forward('SIGINT'); };
  process.once('SIGHUP', hup);
  process.once('SIGTERM', term);
  process.on('SIGINT', interrupt);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', error => reject(new Error(`Cannot start native CLI: ${error.message}`)));
      child.once('exit', (code, signal) => resolve(code ?? signalStatus(signal)));
    });
  } finally {
    process.removeListener('SIGHUP', hup);
    process.removeListener('SIGTERM', term);
    process.removeListener('SIGINT', interrupt);
    await prepared.cleanup();
  }
}
