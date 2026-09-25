import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Catalog, Policy, Reasoning, Tool } from './core/types.ts';
import * as v from './core/validate.ts';
import { routedFamilies } from './core/config.ts';
import { nativeCodexModels, planClaudeFixes, planCodexFixes } from './doctor-fix.ts';
import type { FixFinding } from './doctor-fix.ts';
import { describeChanges, effectivePolicy, readOverride, saveOverride, setPath, unsetPath } from './policy-edit.ts';
import type { Override, PersonalPolicy } from './policy-edit.ts';
import type { Choice, Prompter } from './prompts.ts';
import { atomicJsonWrite } from './storage.ts';

export interface InteractiveContext {
  root: string;
  defaults: Policy;
  catalog: Catalog;
  prompter: Prompter;
  log(message: string): void;
}

interface DoctorState { version: 1; keptClaudeTopModel?: string }

async function readState(root: string): Promise<DoctorState> {
  try {
    const value = JSON.parse(await readFile(join(root, 'doctor-state.json'), 'utf8')) as Partial<DoctorState>;
    return { version: 1, ...(typeof value.keptClaudeTopModel === 'string' ? { keptClaudeTopModel: value.keptClaudeTopModel } : {}) };
  } catch { return { version: 1 }; }
}

/** Shows the effective changes, confirms, validates, backs up, and writes. Returns whether it saved. */
export async function confirmAndSave(context: InteractiveContext, personal: PersonalPolicy, updated: Override): Promise<boolean> {
  const changes = describeChanges(context.defaults, personal.override, updated);
  if (!changes.length) { context.log('No policy changes selected.'); return false; }
  effectivePolicy(context.defaults, context.catalog, updated);
  context.prompter.note(changes.join('\n'), 'Changes to your policy');
  if (!await context.prompter.confirm('Save these changes?')) { context.log('No changes written.'); return false; }
  const backup = await saveOverride(personal, updated);
  context.log(`Saved ${personal.file}.`);
  if (backup) context.log(`Previous policy backed up to ${backup}.`);
  context.log('Relaunch Switchboard and start a new conversation to use it; existing conversations keep their saved model.');
  return true;
}

export interface DoctorFixOptions {
  /** Explicit `doctor --fix`: check Codex without asking and ask the Claude plan question again. */
  explicit: boolean;
  codexExecutable: string | null;
  readCodexModels(executable: string): Promise<unknown>;
}

/** Runs the checks that need a local CLI or the user's knowledge, then offers fixes. */
export async function doctorFixes(context: InteractiveContext, options: DoctorFixOptions): Promise<boolean> {
  const personal = await readOverride(context.root);
  const policy = effectivePolicy(context.defaults, context.catalog, personal.override);
  const state = await readState(context.root);
  const findings: FixFinding[] = [];
  if (policy.enabledTools.includes('claude')) {
    findings.push(...planClaudeFixes(policy, personal.override, context.defaults, context.catalog, options.explicit ? undefined : state.keptClaudeTopModel));
  }
  if (policy.enabledTools.includes('codex') && options.codexExecutable) {
    const check = options.explicit || await context.prompter.confirm('Check the models your installed Codex offers? This runs `codex debug models --bundled` locally; no network request.');
    if (check) {
      const codex = planCodexFixes(policy, personal.override, nativeCodexModels(await options.readCodexModels(options.codexExecutable)), context.defaults, context.catalog);
      if (!codex.length) context.log('Codex offers every model your policy routes to.');
      findings.push(...codex);
    }
  }
  if (!findings.length) { context.log('Nothing to fix.'); return false; }
  const updated = structuredClone(personal.override);
  let kept: string | undefined;
  for (const finding of findings) {
    const key = await context.prompter.select(finding.message, finding.options.map(option => ({ value: option.key, label: option.label })), finding.fallback);
    const option = finding.options.find(candidate => candidate.key === key)!;
    option.apply(updated);
    kept = option.keeps ?? kept;
  }
  if (kept) await atomicJsonWrite(join(context.root, 'doctor-state.json'), { ...state, keptClaudeTopModel: kept });
  return confirmAndSave(context, personal, updated);
}

type MenuAction = 'tiers' | 'skip' | 'effort' | 'agents' | 'history' | 'connection' | 'reset' | 'save' | 'quit';

const toolLabel: Record<Tool, string> = { claude: 'Claude Code', codex: 'Codex' };

function family(context: InteractiveContext, tool: Tool, model: string): string {
  return context.catalog.models.find(entry => entry.id === model && entry.tool === tool)?.family ?? model;
}

async function chooseTool(context: InteractiveContext, policy: Policy): Promise<Tool> {
  const tools = policy.enabledTools.length ? policy.enabledTools : [...v.tools];
  if (tools.length === 1) return tools[0]!;
  return context.prompter.select('Which agent?', tools.map(tool => ({ value: tool, label: toolLabel[tool] })));
}

/** Highest effort label a profile sends, or null when its mappings are not a simple cap. */
function effortCap(policy: Policy, profile: string): Reasoning | null | 'custom' {
  const efforts = policy.profiles[profile]!.efforts;
  const sent = v.reasoning.map(level => efforts[level]);
  if (sent.every((effort, index) => effort === v.reasoning[index])) return null;
  for (const cap of v.reasoning) {
    const capIndex = v.reasoning.indexOf(cap);
    if (sent.every((effort, index) => effort === v.reasoning[Math.min(index, capIndex)])) return cap;
  }
  return 'custom';
}

/** The `switchboard config` settings menu. Changes accumulate and are saved together at the end. */
export async function configMenu(context: InteractiveContext, runConnectionSetup: () => Promise<void>): Promise<boolean> {
  const personal = await readOverride(context.root);
  let working = structuredClone(personal.override);
  for (;;) {
    const policy = effectivePolicy(context.defaults, context.catalog, working);
    const pending = describeChanges(context.defaults, personal.override, working).length;
    const lineup = policy.enabledTools.map(tool => `${toolLabel[tool]}: ${routedFamilies(policy, context.catalog, tool).join(' → ')}`).join('; ');
    const skipped = v.tools.flatMap(tool => policy.excludedModels[tool].map(model => family(context, tool, model)));
    const action = await context.prompter.select<MenuAction>('Switchboard settings', [
      { value: 'tiers', label: 'Models for each tier', hint: lineup },
      { value: 'skip', label: 'Models to skip', hint: skipped.length ? skipped.join(', ') : 'none' },
      { value: 'effort', label: 'Effort limits' },
      { value: 'agents', label: 'Agents', hint: policy.enabledTools.map(tool => toolLabel[tool]).join(', ') },
      { value: 'history', label: 'Prompt history', hint: policy.history.capturePrompts ? 'saved locally' : 'off' },
      { value: 'connection', label: 'Classifier connection', hint: 'runs the connection step of switchboard init' },
      { value: 'reset', label: 'Reset everything to the shipped defaults' },
      { value: 'save', label: pending ? `Review and save ${pending} change${pending === 1 ? '' : 's'}` : 'Done' },
      { value: 'quit', label: 'Quit without saving' },
    ], pending ? 'save' : 'tiers');

    if (action === 'quit') { context.log('No changes written.'); return false; }
    if (action === 'save') return pending ? confirmAndSave(context, personal, working) : false;
    if (action === 'connection') {
      if (pending) context.log('Save or discard your pending policy changes first.');
      else { await runConnectionSetup(); return false; }
      continue;
    }
    const draft = structuredClone(working);
    if (action === 'reset') {
      if (await context.prompter.confirm('Discard all personal policy settings and use the shipped defaults?', false)) working = {};
      continue;
    }
    if (action === 'agents') {
      const tools = await context.prompter.multiselect('Which agents should Switchboard route?',
        v.tools.map(tool => ({ value: tool, label: toolLabel[tool] })), policy.enabledTools, true);
      setPath(draft, ['enabledTools'], v.tools.filter(tool => tools.includes(tool)));
    }
    if (action === 'history') {
      setPath(draft, ['history', 'capturePrompts'], await context.prompter.confirm('Save task text locally with each routing decision? It stays on this machine.', policy.history.capturePrompts));
    }
    if (action === 'tiers') {
      const tool = await chooseTool(context, policy);
      const tier = await context.prompter.select(`${toolLabel[tool]} tier to change`, v.groups.map(group => {
        const profile = policy.routing[tool][group]!;
        return { value: group, label: group === 'uncertain' ? 'uncertain (fallback)' : group, hint: `${family(context, tool, policy.profiles[profile]!.model)} (${profile})` };
      }));
      const shipped = context.defaults.routing[tool][tier]!;
      const profiles = Object.entries(policy.profiles).filter(([, profile]) => profile.tool === tool);
      const choice = await context.prompter.select<string>(`Model for the ${tier} tier`, [
        ...profiles.map(([name, profile]): Choice<string> => ({ value: name, label: family(context, tool, profile.model),
          hint: `${name}${profile.defaultReasoning ? `, ${profile.defaultReasoning} default effort` : ''}${name === shipped ? ', shipped default' : ''}` })),
      ], policy.routing[tool][tier]!);
      if (choice === shipped) unsetPath(draft, ['routing', tool, tier]);
      else setPath(draft, ['routing', tool, tier], choice);
    }
    if (action === 'skip') {
      const tool = await chooseTool(context, policy);
      const models = context.catalog.models.filter(model => model.tool === tool);
      const skip = await context.prompter.multiselect(`${toolLabel[tool]} models to skip in automatic routing (new conversations use the next eligible tier)`,
        models.map(model => ({ value: model.id, label: model.family, hint: model.id })), policy.excludedModels[tool]);
      if (!skip.length && !context.defaults.excludedModels[tool].length) unsetPath(draft, ['excludedModels', tool]);
      else setPath(draft, ['excludedModels', tool], skip);
    }
    if (action === 'effort') {
      const tool = await chooseTool(context, policy);
      const capable = Object.entries(policy.profiles).filter(([, profile]) => profile.tool === tool && Object.values(profile.efforts).some(effort => effort !== null));
      const profile = await context.prompter.select('Limit effort for which profile?', capable.map(([name, entry]) => {
        const cap = effortCap(policy, name);
        return { value: name, label: `${family(context, tool, entry.model)} (${name})`, hint: cap === null ? 'no limit' : cap === 'custom' ? 'custom mapping' : `up to ${cap}` };
      }));
      const current = effortCap(policy, profile);
      const cap = await context.prompter.select<Reasoning | 'none'>('Highest effort to send', [
        { value: 'none', label: 'No limit' },
        ...v.reasoning.slice(0, -1).map(level => ({ value: level, label: `Up to ${level}` })),
      ], current === null || current === 'custom' ? 'none' : current);
      unsetPath(draft, ['profiles', profile, 'efforts']);
      if (cap !== 'none') {
        const capIndex = v.reasoning.indexOf(cap);
        setPath(draft, ['profiles', profile, 'efforts'], Object.fromEntries(v.reasoning.map((level, index) => [level, v.reasoning[Math.min(index, capIndex)]])));
      }
    }
    try {
      effectivePolicy(context.defaults, context.catalog, draft);
      working = draft;
    } catch (error) {
      context.log(`Not applied: ${error instanceof Error ? error.message : 'invalid setting'}`);
    }
  }
}
