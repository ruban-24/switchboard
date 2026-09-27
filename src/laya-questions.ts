import type { Classification, ClassificationContext } from './core/types.ts';
import { assessInitialModel } from './core/policy.ts';
import { tiers, reasoning } from './core/validate.ts';

// Laya's English checkpoint reads 512 tokens, shared by these questions and the
// task, so the wording is deliberately short. Laya follows boolean-word labels
// instead of their descriptions, so the context question uses neutral keys.
// Its answers normalize into the same Classification as Jev's.
const taskTypes = {
  explain: 'explain or answer without changing code',
  edit: 'small, specified change to existing code',
  implement: 'build new behavior',
  debug: 'diagnose or fix incorrect behavior',
  review: 'assess existing work and report findings',
  architecture: 'design system structure or direction',
  other: 'none of these',
} as const;

export const layaQuestions = {
  taskType: { type: 'choice', instructions: 'What kind of software task is this?', criteria: taskTypes },
  complexity: { type: 'choice', instructions: 'How hard is this software task?', criteria: {
    routine: 'trivial mechanical edit',
    standard: 'ordinary coding with familiar patterns',
    complex: 'hard debugging or tricky correctness',
    demanding: 'novel research-level design',
  } },
  sufficientContext: { type: 'choice', instructions: 'Is the task specific enough to judge its difficulty?', criteria: {
    A: 'yes, the work is clearly described',
    B: 'no, the work is unspecified or missing details',
  } },
  // One model-agnostic question: Laya does not distinguish per-model framings.
  effort: { type: 'choice', instructions: 'How much reasoning does this task need?', criteria: {
    low: 'almost none',
    medium: 'a few steps',
    high: 'careful multi-step analysis',
    xhigh: 'deep analysis of uncertain evidence',
    max: 'exceptional deliberation',
  } },
} as const;

export function buildLayaQuestions(context: ClassificationContext): typeof layaQuestions {
  if (!context) throw new Error('Classification requires a tool, effective policy, and catalog');
  // Validate the whole active mapping before sending the task anywhere.
  assessInitialModel(context.policy, context.catalog, context.tool, null);
  return layaQuestions;
}

// answer_confidence is the probability Laya calibrates; its `confidence` field is
// normalized entropy on a different scale and must not meet the same threshold.
function answer(value: unknown, choices: readonly string[]): { choice: string; confidence: number } | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  return a.type === 'choice' && typeof a.choice === 'string' && choices.includes(a.choice)
    && typeof a.answer_confidence === 'number' && Number.isFinite(a.answer_confidence) && a.answer_confidence >= 0 && a.answer_confidence <= 1
    ? { choice: a.choice, confidence: a.answer_confidence } : null;
}

export function parseLayaAnswers(value: unknown, context: ClassificationContext): Classification {
  const answers = value && typeof value === 'object' ? (value as { answers?: Record<string, unknown> }).answers : undefined;
  const taskType = answer(answers?.taskType, Object.keys(taskTypes));
  const complexity = answer(answers?.complexity, tiers);
  const sufficientContext = answer(answers?.sufficientContext, ['A', 'B']);
  if (!complexity || !sufficientContext) throw new Error('Laya returned an invalid classification');
  const result: Classification = {
    taskType: (taskType?.choice ?? null) as Classification['taskType'], complexity: complexity.choice as Classification['complexity'],
    sufficientContext: sufficientContext.choice === 'A', reasoning: null,
    confidences: { model: complexity.confidence, effort: null, context: sufficientContext.confidence, taskType: taskType?.confidence ?? null },
  };
  const { selection } = assessInitialModel(context.policy, context.catalog, context.tool, result);
  result.effortModel = selection.model;
  // Like Jev, a model with no effort setting receives no effort answer.
  const model = context.catalog.models.find(model => model.id === selection.model && model.tool === context.tool);
  const effort = model?.efforts.some(effort => effort !== null) ? answer(answers?.effort, reasoning) : null;
  if (effort) {
    result.reasoning = effort.choice as NonNullable<Classification['reasoning']>;
    result.confidences.effort = effort.confidence;
  }
  return result;
}
