import type { Adjustment, Catalog, Classification, Policy, Reasoning, Selection, Tool } from './types.ts';
import { validateMappings } from './config.ts';
import * as v from './validate.ts';
import { parseDiagnostics } from './classification-diagnostics.ts';

export function parseClassification(input: unknown): Classification {
  const c = v.object(input, 'classification', ['taskType', 'complexity', 'reasoning', 'sufficientContext', 'confidence', 'confidences', 'effortModel', 'diagnostics']);
  const legacy = c.confidence === undefined ? undefined : v.number(c.confidence, 'confidence', 0, 1, false);
  const scores = c.confidences === undefined ? {} : v.object(c.confidences, 'confidences', ['model', 'effort', 'context', 'taskType']);
  const confidence = (key: string) => v.number(c.confidences === undefined ? legacy : scores[key], `confidences.${key}`, 0, 1, false);
  const effortModel = c.effortModel === undefined ? undefined : v.text(c.effortModel, 'effortModel');
  const noEffortAnswer = effortModel !== undefined && c.reasoning === null && scores.effort === null;
  const noTaskType = c.taskType === null && scores.taskType === null;
  const diagnostics = parseDiagnostics(c.diagnostics);
  return {
    taskType: noTaskType ? null : v.oneOf(c.taskType, ['explain', 'edit', 'implement', 'debug', 'review', 'architecture', 'other'] as const, 'taskType'),
    // Existing personal policy keys remain stable; these now mean capability tiers.
    complexity: v.oneOf(c.complexity, v.tiers, 'complexity'),
    reasoning: noEffortAnswer ? null : v.oneOf(c.reasoning, v.reasoning, 'reasoning'),
    sufficientContext: v.boolean(c.sufficientContext, 'sufficientContext'),
    confidences: { model: confidence('model'), effort: noEffortAnswer ? null : confidence('effort'), context: confidence('context'), taskType: noTaskType ? null : confidence('taskType') },
    ...(effortModel === undefined ? {} : { effortModel }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

export function isModelUncertain(policy: Policy, classification: Classification | null): boolean {
  return !classification || !classification.sufficientContext || classification.confidences.model < policy.classifier.modelMinConfidence;
}

export function isUncertain(policy: Policy, classification: Classification | null): boolean {
  return isModelUncertain(policy, classification) || classification!.confidences.effort === null
    || classification!.confidences.effort < policy.classifier.effortMinConfidence;
}

export function assessInitialModel(policy: Policy, catalog: Catalog, tool: Tool, classification: Classification | null): { selection: Omit<Selection, 'effort'>; adjustments: Adjustment[] } {
  if (!policy.enabledTools.includes(tool)) throw new Error(`${tool} is not enabled`);
  const readiness = validateMappings(policy, catalog, tool);
  if (!readiness.ready) throw new Error(`Routing is not configured: ${readiness.missing.join(', ')}`);
  const adjustments: Adjustment[] = [];
  const unclassifiable = !classification || !classification.sufficientContext;
  let group = unclassifiable ? 'uncertain' as const : classification!.complexity;
  if (classification && !classification.sufficientContext) adjustments.push('insufficient-context');
  if (!unclassifiable && isModelUncertain(policy, classification)) {
    if (group === 'routine') group = 'standard';
    adjustments.push('model-confidence-floor');
  }
  const requested = policy.routing[tool][group]!;
  const ordered = v.tiers.map(tier => policy.routing[tool][tier]!);
  const rank = group === 'uncertain' ? ordered.lastIndexOf(requested) : v.tiers.indexOf(group);
  const alternatives = rank < 0 ? ordered.toReversed() : [...ordered.slice(rank + 1), ...ordered.slice(0, rank).reverse()];
  const name = [requested, ...alternatives].find(candidate => !policy.excludedModels[tool].includes(policy.profiles[candidate]!.model));
  if (!name) throw new Error(`No eligible models remain for ${tool}`);
  return { selection: { profile: name, model: policy.profiles[name]!.model,
    ...(name !== requested ? { excludedModel: policy.profiles[requested]!.model } : {}) }, adjustments };
}

export function assessInitialRoute(policy: Policy, catalog: Catalog, tool: Tool, classification: Classification | null): { selection: Selection; adjustments: Adjustment[] } {
  const { selection, adjustments } = assessInitialModel(policy, catalog, tool, classification);
  const profile = policy.profiles[selection.profile!]!;
  const ordered = v.tiers.map(tier => policy.routing[tool][tier]!);
  const selectedRank = ordered.lastIndexOf(selection.profile!);
  const defaultReasoning = profile.defaultReasoning ?? (['low', 'medium', 'high', 'xhigh'] as const)[selectedRank] ?? 'high';
  const unclassifiable = !classification || !classification.sufficientContext;
  let reasoning: Reasoning = unclassifiable ? 'high' : classification!.reasoning ?? defaultReasoning;
  const unavailable = classification?.reasoning === null || classification?.confidences.effort === null
    || (classification?.effortModel !== undefined && classification.effortModel !== profile.model);
  if (!unclassifiable && unavailable) {
    reasoning = defaultReasoning;
    if (profile.efforts[reasoning] !== null) adjustments.push('effort-unavailable');
  } else if (!unclassifiable && classification!.confidences.effort! < policy.classifier.effortMinConfidence) {
    reasoning = v.reasoning[Math.max(v.reasoning.indexOf(reasoning), v.reasoning.indexOf(defaultReasoning))]!;
    // A no-effort model has no effort decision to explain.
    if (profile.efforts[reasoning] !== null) adjustments.push('effort-default');
  }
  return {
    selection: {
      ...selection, effort: profile.efforts[reasoning],
    }, adjustments,
  };
}

export function selectInitialRoute(policy: Policy, catalog: Catalog, tool: Tool, classification: Classification | null): Selection {
  return assessInitialRoute(policy, catalog, tool, classification).selection;
}
