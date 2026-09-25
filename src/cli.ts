import { explainDecision } from './core/explanation.ts';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergePolicy, routedFamilies, validateMappings } from './core/config.ts';
import { bundledCatalog, defaultPolicy, eligibleFamilies } from './defaults.ts';
import { Store, atomicJsonWrite } from './storage.ts';
import type { Policy, Tool } from './core/types.ts';
import * as v from './core/validate.ts';
import { classifierStatus, createConfiguredClassifier } from './classifier.ts';
import { startProxy } from './native/proxy.ts';
import { buildCodexCatalog, readCodexCatalog } from './native/codex-catalog.ts';
import { nativeBypassesRouting, prepareNativeLaunch, runPreparedNative, validateNativeAutomatic } from './native/launcher.ts';
import { UsageStore } from './native/usage-store.ts';
import { connectionEnvironment, credentialKeys, saveConnection, stateDirectory } from './settings.ts';
import type { Connection } from './settings.ts';
import { ask, choose, installProfileBlock, recommendedProfiles } from './setup.ts';
import { configMenu, doctorFixes } from './interactive.ts';
import type { InteractiveContext } from './interactive.ts';
import { describeChanges, effectivePolicy, getPath, parsePath, parseValue, readOverride, saveOverride, setPath, unsetPath } from './policy-edit.ts';
import { PromptCancelled, interactive, terminalPrompter } from './prompts.ts';

const help = `Switchboard — automatic model and effort routing

Usage:
  switchboard init [--yes]
  switchboard config            (interactive settings menu)
  switchboard config show | check
  switchboard config get <setting>
  switchboard config set <setting> <value>
  switchboard config unset <setting>
  switchboard doctor [--fix]
  switchboard claude [native arguments]
  switchboard codex [native arguments]
  switchboard explain <claude|codex> <conversation-id>
  switchboard --help

Explicit native model/effort selections and administrative commands bypass routing.
Personal settings: $SWITCHBOARD_HOME/policy.json, otherwise
$XDG_CONFIG_HOME/switchboard/policy.json or ~/.config/switchboard/policy.json.
`;

async function configuration(root: string): Promise<{ policy: Policy; exists: boolean }> {
  const { override, exists } = await readOverride(root);
  const policy = mergePolicy(defaultPolicy, override);
  validateMappings(policy, bundledCatalog);
  return { policy, exists };
}

async function executable(tool: Tool): Promise<string | null> {
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const file = resolve(entry, tool);
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return file;
    } catch { /* Continue searching PATH; do not run candidate binaries. */ }
  }
  return null;
}

function describeDefaults(): void {
  console.log('Four automatic tiers: routine → standard → complex → demanding.');
  console.log(`Claude: ${eligibleFamilies.claude.join(' → ')}`);
  console.log(`Codex:  ${eligibleFamilies.codex.join(' → ')}`);
  console.log('Personal overrides can exclude models; new conversations use the next eligible tier.');
  console.log('A conversation keeps its model and effort. Raw prompt history is off by default.');
  console.log('Effort choices: low, medium, high, xhigh, max. Haiku receives no effort parameter.');
  console.log('Automatic launch uses process-scoped native settings and leaves native configuration unchanged.');
}

function describeClassifier(env: NodeJS.ProcessEnv): boolean {
  const status = classifierStatus(env);
  console.log(`Jev classifier: ${status.label} (${status.modelId}).`);
  console.log(`Jev credential: ${status.credentialPresent ? 'present' : 'missing'} (not tested); ${status.credentialEnvironment}.`);
  return status.credentialPresent;
}

async function init(root: string, args: string[]): Promise<number> {
  if (args.length > 1 || (args[0] && args[0] !== '--yes')) throw new Error('Usage: switchboard init [--yes]');
  const env = await connectionEnvironment(root);
  const initialClassifier = classifierStatus(env); // Validate before writing configuration.
  const current = await configuration(root);
  const file = join(root, 'policy.json');
  if (!args.includes('--yes') && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Noninteractive init requires --yes to accept the shipped defaults.');
  }
  describeDefaults();
  let enabledTools: Tool[] | undefined;
  let connection: Connection | undefined;
  let profiles: string[] = [];
  if (!args.includes('--yes')) {
    const found = await Promise.all(v.tools.map(executable));
    v.tools.forEach((tool, index) => console.log(`${tool}: ${found[index] ? 'found on PATH' : 'not found on PATH'}`));
    if (current.exists) console.log(`Personal policy preserved: ${file}. Edit enabledTools there to change agents.`);
    else {
      const fallback = found[0] && !found[1] ? '1' : found[1] && !found[0] ? '2' : '3';
      const answer = await choose('Enable 1) Claude 2) Codex 3) Both', ['1', '2', '3'], fallback);
      enabledTools = answer === '1' ? ['claude'] : answer === '2' ? ['codex'] : [...v.tools];
    }
    console.log('\nJev connection:\n  1) TypeSafe\n  2) Vercel AI Gateway\n  3) OpenRouter\n  4) Custom TypeSafe-compatible endpoint');
    const providerChoice = await choose('Provider', ['1', '2', '3', '4'], initialClassifier.provider === 'vercel' ? '2' : initialClassifier.provider === 'openrouter' ? '3' : env.SWITCHBOARD_BASE_URL || env.TYPESAFE_BASE_URL ? '4' : '1');
    const provider = providerChoice === '2' ? 'vercel' : providerChoice === '3' ? 'openrouter' : 'typesafe';
    const selectedEnv: NodeJS.ProcessEnv = { SWITCHBOARD_PROVIDER: provider };
    const sameProvider = provider === initialClassifier.provider;
    if (sameProvider) for (const key of credentialKeys(provider)) selectedEnv[key] = env[key];
    if (providerChoice === '4') {
      console.log('This endpoint must implement the TypeSafe System One request and confidence response contract.');
      const defaultURL = sameProvider ? env.SWITCHBOARD_BASE_URL || env.TYPESAFE_BASE_URL : undefined;
      selectedEnv.SWITCHBOARD_BASE_URL = await ask(`Base URL${defaultURL ? ` [${defaultURL}]` : ''}: `) || defaultURL;
      if (!selectedEnv.SWITCHBOARD_BASE_URL) throw new Error('A custom endpoint requires a base URL');
    }
    const defaultModel = sameProvider ? env.SWITCHBOARD_MODEL || (provider === 'typesafe' ? env.TYPESAFE_DEFAULT_MODEL : undefined) : undefined;
    if (defaultModel) selectedEnv.SWITCHBOARD_MODEL = defaultModel;
    const status = classifierStatus(selectedEnv);
    selectedEnv.SWITCHBOARD_MODEL = await ask(`Jev model [${status.modelId}]: `) || status.modelId;
    classifierStatus(selectedEnv);
    const existingKey = credentialKeys(provider).map(key => selectedEnv[key]?.trim()).find(Boolean);
    let apiKey = '';
    while (!apiKey) {
      apiKey = await ask(`API key (hidden${existingKey ? '; Enter keeps the current key' : ''}): `, true) || existingKey || '';
      if (!apiKey) console.log('An API key is required. Press Ctrl+C to cancel.');
    }
    connection = { version: 1, provider, apiKey, model: selectedEnv.SWITCHBOARD_MODEL,
      ...(selectedEnv.SWITCHBOARD_BASE_URL ? { baseURL: selectedEnv.SWITCHBOARD_BASE_URL } : {}) };
    const suggested = await recommendedProfiles();
    console.log('Setup will save your key privately in connection.json. The CLI reads it automatically; no shell restart is needed.');
    if (suggested.length) {
      console.log(`\nOptional shell-profile block (configuration path only):\n${suggested.map(path => `  ${path}`).join('\n')}`);
      const answer = await choose('Add block? y) Yes n) Skip c) Choose another profile', ['y', 'n', 'c'], 'y');
      if (answer === 'y') profiles = suggested;
      if (answer === 'c') {
        const candidate = await ask('Shell profile path (absolute, or ~/…): ');
        const profile = candidate.startsWith('~/') ? join(homedir(), candidate.slice(2)) : candidate;
        if (!isAbsolute(profile)) throw new Error('Use an absolute shell profile path');
        profiles = [profile];
      }
    } else console.log('Shell profile integration is available for zsh, bash, and sh. Saved credentials still work in any shell.');
  }
  if (current.exists) console.log(`Already initialized; personal overrides preserved: ${file}`);
  else {
    const override = enabledTools ? { enabledTools } : {};
    mergePolicy(defaultPolicy, override);
    try { await atomicJsonWrite(file, override, { replace: false }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await configuration(root);
      console.log('Another setup created a policy; its overrides were preserved.');
    }
    console.log(`Personal overrides: ${file}`);
  }
  if (connection) {
    await saveConnection(root, connection);
    console.log(`Saved connection: ${join(root, 'connection.json')} (owner read/write only).`);
  }
  for (const profile of profiles) {
    await installProfileBlock(profile, root);
    console.log(`Updated shell profile: ${profile}`);
  }
  const activeEnv = await connectionEnvironment(root);
  describeClassifier(activeEnv);
  if (connection) {
    const active = classifierStatus(activeEnv);
    const saved = classifierStatus({ SWITCHBOARD_PROVIDER: connection.provider, SWITCHBOARD_MODEL: connection.model, SWITCHBOARD_BASE_URL: connection.baseURL, SWITCHBOARD_API_KEY: connection.apiKey });
    const activeKey = credentialKeys(active.provider).map(key => activeEnv[key]?.trim()).find(Boolean);
    if (active.provider !== saved.provider || active.modelId !== saved.modelId || active.baseURL !== saved.baseURL || activeKey !== connection.apiKey) {
      console.log('Your current environment overrides the saved connection. Remove conflicting classifier variables to use the new setup; see docs/classifiers.md.');
    }
  }
  if (args.includes('--yes')) console.log('Noninteractive setup preserves credentials and shell profiles. Run switchboard init interactively to configure a key.');
  console.log('Init made no network requests. Provider login remains with the native CLI.');
  console.log('Next: switchboard doctor, then switchboard claude or switchboard codex.');
  return 0;
}

function interactiveContext(root: string): InteractiveContext {
  return { root, defaults: defaultPolicy, catalog: bundledCatalog, prompter: terminalPrompter, log: message => console.log(message) };
}

async function doctor(root: string, fix: boolean): Promise<number> {
  if (fix && !interactive()) throw new Error('switchboard doctor --fix is interactive; run it in a terminal.');
  const { policy, exists } = await configuration(root);
  const readiness = validateMappings(policy, bundledCatalog);
  console.log(`Personal policy: ${exists ? join(root, 'policy.json') : 'not initialized; using shipped defaults'}`);
  const paths = await Promise.all(v.tools.map(executable));
  v.tools.forEach((tool, index) => console.log(`${tool}: ${paths[index] ? `found (${paths[index]})` : 'not found on PATH'}${policy.enabledTools.includes(tool) ? '' : ' [disabled]'}`));
  const credentialPresent = describeClassifier(await connectionEnvironment(root));
  console.log(readiness.ready ? 'Route mappings: valid.' : `Route mappings: not configured (${readiness.missing.join(', ')}).`);
  for (const tool of policy.enabledTools) console.log(`Automatic ${tool} lineup: ${routedFamilies(policy, bundledCatalog, tool).join(' → ')}`);
  console.log('Effort: fixed for each conversation. Native model aliases may still produce metadata warnings.');
  console.log('Native adapters: available for local foreground sessions; custom execution gateways/providers and remote/background modes are unsupported.');
  console.log('The checks above made no network requests and did not run either CLI.');
  const status = paths.every((path, index) => !policy.enabledTools.includes(v.tools[index]!) || !!path) && readiness.ready && credentialPresent ? 0 : 2;
  if (!interactive()) {
    console.log('Run switchboard doctor in a terminal to check your installed models and fix problems interactively.');
    return status;
  }
  try {
    await doctorFixes(interactiveContext(root), { explicit: fix, codexExecutable: paths[v.tools.indexOf('codex')] ?? null, readCodexModels: readCodexCatalog });
  } catch (error) {
    if (!(error instanceof PromptCancelled)) throw error;
    console.log(error.message);
  }
  return status;
}

async function config(root: string, args: string[]): Promise<number> {
  const [action, key, value, ...extra] = args;
  if (!action) {
    if (!interactive()) throw new Error('switchboard config opens an interactive menu; run it in a terminal, or use config get/set/unset.');
    try { await configMenu(interactiveContext(root), async () => { await init(root, []); }); }
    catch (error) {
      if (!(error instanceof PromptCancelled)) throw error;
      console.log(error.message);
    }
    return 0;
  }
  if ((action === 'show' || action === 'check') && !key) {
    const { policy } = await configuration(root);
    if (action === 'show') { console.log(JSON.stringify(policy, null, 2)); return 0; }
    const readiness = validateMappings(policy, bundledCatalog);
    console.log('Policy is valid.');
    if (!readiness.ready) { console.log(`Automatic routing is not configured: ${readiness.missing.join(', ')}`); return 2; }
    console.log('Model/effort mappings are valid. Native integration readiness is reported by switchboard doctor.');
    return 0;
  }
  if (action === 'get' && key && value === undefined) {
    const { policy } = await configuration(root);
    const current = getPath(policy, parsePath(key));
    if (current === undefined) throw new Error(`Unknown setting: ${key}`);
    console.log(typeof current === 'string' ? current : JSON.stringify(current, null, 2));
    return 0;
  }
  if ((action === 'set' && key && value !== undefined && !extra.length) || (action === 'unset' && key && value === undefined)) {
    const personal = await readOverride(root);
    effectivePolicy(defaultPolicy, bundledCatalog, personal.override);
    const updated = structuredClone(personal.override);
    const path = parsePath(key);
    if (action === 'set') setPath(updated, path, parseValue(value!));
    else if (!unsetPath(updated, path)) { console.log(`${key} is not set in your personal policy; the shipped default already applies.`); return 0; }
    effectivePolicy(defaultPolicy, bundledCatalog, updated);
    const changes = describeChanges(defaultPolicy, personal.override, updated);
    if (!changes.length && JSON.stringify(updated) === JSON.stringify(personal.override)) { console.log('No change.'); return 0; }
    const backup = await saveOverride(personal, updated);
    for (const change of changes) console.log(change);
    if (!changes.length) console.log(`${key} now matches the shipped default.`);
    if (backup) console.log(`Previous policy backed up to ${backup}.`);
    console.log('Relaunch Switchboard and start a new conversation to use it.');
    return 0;
  }
  throw new Error('Usage: switchboard config [show | check | get <setting> | set <setting> <value> | unset <setting>]');
}

async function explain(root: string, args: string[]): Promise<number> {
  if (args.length !== 2) throw new Error('Usage: switchboard explain <claude|codex> <conversation-id>');
  const tool = v.oneOf(args[0], v.tools, 'tool');
  const { policy } = await configuration(root);
  const state = await new Store(root, { historyLimit: policy.history.limit }).load(tool, args[1]!);
  if (!state) throw new Error(`No saved route for ${tool}/${args[1]}`);
  const d = state.lastDecision;
  console.log(`Conversation: ${d.tool}/${d.conversationId}`);
  console.log(`Saved automatic model: ${d.selection.model}`);
  console.log(`Effort: ${d.selection.effort ?? 'not sent'}`);
  console.log(`Profile: ${d.selection.profile ?? 'explicit native selection'}`);
  console.log(`Reason: ${d.reason}; policy: ${d.policyId}`);
  if (d.selection.excludedModel) console.log(`Initial selection excluded ${d.selection.excludedModel} under the personal policy; used an eligible tier instead.`);
  console.log(`Explanation: ${explainDecision(d)}`);
  if (d.turnDetection) console.log(`Turn detection: ${d.turnDetection}`);
  if (d.classification) {
    const c = d.classification;
    console.log(`Task: ${c.taskType ?? 'unavailable'}; capability tier: ${c.complexity}; reasoning demand: ${c.reasoning ?? 'not assessed'}; confidence: model ${c.confidences.model}, effort ${c.confidences.effort ?? 'not assessed'}, context ${c.confidences.context}, task type ${c.confidences.taskType ?? 'unavailable'}`);
    if (c.effortModel) console.log(`Effort assessed for: ${c.effortModel}`);
    if (c.diagnostics) {
      const d = c.diagnostics;
      console.log(`Jev: ${d.provider}; requested ${d.requestedModel ?? 'unknown'}; resolved ${d.resolvedModel ?? 'unknown'}`);
      const distribution = (p: Record<string, number> | null) => p
        ? Object.entries(p).map(([choice, probability]) => `${choice} ${Number((probability * 100).toFixed(2))}%`).join(', ')
        : 'unavailable';
      console.log(`Capability probabilities: ${distribution(d.probabilities.model)}`);
      console.log(`Context probabilities: ${distribution(d.probabilities.context)}`);
      console.log(`Selected effort probabilities: ${distribution(d.probabilities.effort)}`);
      console.log('Probabilities describe Jev choices, not the chance that the coding model will succeed.');
    }
  }
  else console.log('Classification: unavailable or bypassed.');
  if (d.recommendation) console.log(`Suggested for a new conversation: ${d.recommendation.model} (${d.recommendation.effort ?? 'no effort parameter'})`);
  console.log(`Last decision: ${d.at}`);
  const usage = await new UsageStore(root).load(tool, args[1]!);
  if (usage) console.log(`Last automatic cache observation: input ${usage.totalInputTokens ?? 'unavailable'}, cached ${usage.cachedInputTokens ?? 'unavailable'}, cache write ${usage.cacheWriteTokens ?? 'unavailable'}, output ${usage.outputTokens ?? 'unavailable'}.`);
  else console.log('Last automatic cache observation: unavailable.');
  console.log('Explicit native selections bypass the saved automatic route and are not attributed here.');
  return 0;
}

async function launch(root: string, tool: Tool, args: string[]): Promise<number> {
  const path = await executable(tool);
  if (!path) throw new Error(`${tool} is not installed or executable on PATH`);
  if (nativeBypassesRouting(tool, args)) return runPreparedNative(path, await prepareNativeLaunch({ tool, args }));
  const { policy } = await configuration(root);
  if (!policy.enabledTools.includes(tool)) throw new Error(`${tool} automatic routing is disabled in the personal policy`);
  const readiness = validateMappings(policy, bundledCatalog, tool);
  if (!readiness.ready) throw new Error(`Automatic ${tool} routing is not configured: ${readiness.missing.join(', ')}`);
  await validateNativeAutomatic(tool, args, homedir(), process.env);
  const classify = createConfiguredClassifier(await connectionEnvironment(root));
  const eligible = (['routine', 'standard', 'complex', 'demanding', 'uncertain'] as const).map(tier => policy.profiles[policy.routing[tool][tier]!]!.model)
    .filter(model => !policy.excludedModels[tool].includes(model));
  let codexCatalog: ReturnType<typeof buildCodexCatalog> | undefined;
  if (tool === 'codex') {
    try { codexCatalog = buildCodexCatalog(await readCodexCatalog(path), eligible); }
    catch (error) {
      const reason = error instanceof Error ? error.message.replace(/\.$/, '') : 'Cannot read the native Codex model catalog';
      throw new Error(`${reason}. Run switchboard doctor to review your policy, or update Codex.`);
    }
  }
  const proxy = await startProxy({ tool, root, policy, catalog: bundledCatalog, classify });
  try { return await runPreparedNative(path, await prepareNativeLaunch({ tool, args, proxy, codexCatalog, stateDirectory: root })); }
  finally { await proxy.close(); }
}

export async function main(args: string[]): Promise<number> {
  try {
    if (!args.length || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!))) { console.log(help); return 0; }
    const [command, ...rest] = args;
    const root = stateDirectory();
    if (command === 'claude' || command === 'codex') return await launch(root, command, rest);
    if (command === 'init') return await init(root, rest);
    if (command === 'doctor' && (!rest.length || (rest.length === 1 && rest[0] === '--fix'))) return await doctor(root, rest[0] === '--fix');
    if (command === 'explain') return await explain(root, rest);
    if (command === 'config') return await config(root, rest);
    throw new Error('Unknown command or arguments. Run switchboard --help.');
  } catch (error) {
    // Never print an Error stack/cause: parser and transport causes can contain payloads.
    console.error(`switchboard: ${error instanceof Error ? error.message : 'Operation failed'}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
