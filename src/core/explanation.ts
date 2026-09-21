import type { Adjustment, Decision } from './types.ts';

const reasons: Record<Decision['reason'], string> = {
  initial: 'Jev capability and effort selection', uncertain: 'uncertain classification; conservative fallback',
  'classifier-unavailable': 'classifier unavailable; conservative fallback', pinned: 'pinned for this conversation',
  manual: 'explicit selection', 'tool-continuation': 'continuing the saved route',
};
const adjustments: Record<Adjustment, string> = {
  'model-confidence-floor': 'model confidence below threshold; balanced minimum with stronger proposals preserved',
  'effort-default': 'effort confidence below threshold; using profile default or higher proposed effort',
  'effort-unavailable': 'model-specific effort unavailable; using selected model profile default',
  'insufficient-context': 'task difficulty cannot be estimated; using configured fallback',
  'turn-detection-fallback': 'turn detection uncertain; continuing saved route without classification',
};

export function explainDecision(decision: Decision): string {
  const details = decision.adjustments?.map(value => adjustments[value]) ?? [];
  const reason = details.length ? details.join('; ') : reasons[decision.reason];
  return reason + (decision.selection.excludedModel ? `; ${decision.selection.excludedModel} excluded by policy` : '');
}
