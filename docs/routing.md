# Routing and personal policy

Switchboard uses Jev to assess task meaning and reasoning demand, then applies
a deterministic personal policy. This reference describes the shipped behavior.

## Architecture and request flow

`switchboard claude` or `switchboard codex` starts a local proxy, then launches
the native coding CLI with temporary connection settings. The native CLI still
owns the chat, tools, approvals, and coding-provider authentication.

| Component | Responsibility | Runs where |
| --- | --- | --- |
| [Launcher](../src/native/launcher.ts) | Loads effective configuration, starts the proxy, and supplies temporary native settings and Claude hooks. | Your machine |
| [Protocol adapter](../src/native/protocol.ts) and [proxy](../src/native/proxy.ts) | Recognize conversations, user turns, tool continuations, and explicit model choices. Extract the task to classify. | Your machine |
| [Classifier adapter](../src/jev.ts) and [questions](../src/jev-questions.ts) | Send the extracted task and policy-derived questions; validate typed answers and confidence. | Local adapter calling your selected Jev endpoint |
| [Policy](../src/core/policy.ts) and [session router](../src/core/session.ts) | Select the model and its effort, apply overrides, and keep an existing conversation's route pinned. | Your machine |
| Native coding provider | Receives the native inference request with the selected model and compatible effort fields; generates the response. | Anthropic or OpenAI |
| [Store](../src/storage.ts) and status display | Save bounded decision metadata for resume and show the active route. | Your machine |

For a new automatic conversation:

1. The native CLI sends an inference request to the local proxy using the
   `switchboard` model alias.
2. The proxy identifies the user task. Jev receives `{ "task": "..." }` as its
   state, plus classification questions. The classifier does not receive the
   full native request or scan the repository.
3. Jev returns choices and confidence. Local policy selects a capability profile,
   applies exclusions, and consumes the effort answer for the resulting model.
4. Switchboard saves that pair and forwards the native inference request to its
   original provider with the model and compatible effort fields updated.
   Conversation content and tools continue through the native provider.
5. The provider's response streams back to the CLI. Codex also receives a local
   routing notice; Claude reads the saved route through its status-line helper.

A recognized later user turn can make one new classification request to assess
whether a stronger route should be recommended for a new conversation. It keeps
the active pair. Tool continuations, duplicate retries, and requests whose turn
boundary cannot be established reuse the saved route without another Jev call.
An explicit native model selection bypasses automatic routing.

See [request and response examples](classifiers.md#request-and-response-examples)
for the classifier payload and native model fields, and
[privacy and data flow](privacy.md) for authentication and local storage.

## Four automatic tiers

| Capability tier (policy key) | Claude Code | Codex |
| --- | --- | --- |
| Fast (`routine`) | Haiku | GPT-6 Luna |
| Balanced (`standard`) | Sonnet | GPT-6 Sol (`codex-sol-balanced`, medium default) |
| Strong (`complex`) | Opus 5.5 | GPT-6 Sol (`codex-sol`, high default) |
| Highest (`demanding`) | Fable | GPT-6 Astra |

All four tiers are configured in the shipped default policy. Concrete IDs and supported API effort values are in the [model catalog](model-catalog.md). Sonnet, Opus, Fable, Luna, Sol, and Astra can each use `low`, `medium`, `high`, `xhigh`, or `max`. Haiku receives no effort parameter. The native launchers apply these choices at inference time.

The `default-v0.3` classifier makes **one Jev request per classified user turn**. It asks for task type, capability tier, sufficient context, and a separate conditional effort judgment for each distinct eligible model that supports effort. The default Claude request has six questions; Codex also has six, because Sol serves two tiers and is asked about once. Excluded and unused models have no effort questions. Deterministic policy resolves the model first, including confidence rules and exclusions, then reads only that model's effort answer. Haiku has no invented effort answer or confidence. Jev supplies structured judgments; code resolves the policy and execution.

Model and effort are related judgments, not a single score that ranks every pair. The policy does not assume Sonnet/max equals Opus/low. It first chooses a sufficient capability tier, then asks how much deliberation that model needs. Conditional questions describe the model's owner-defined capability role, not its name: the classifier cannot know models released after its training. Code binds each answer to its model ID. The roles do not establish measured performance guarantees.

The [capability question](../src/capability-question.ts) asks Jev to choose the least capable tier sufficient for the work. Mechanical changes and familiar factual answers belong in fast. Bounded development, including an LRU cache with tests, belongs in balanced. Resolving uncertain causes or interacting invariants can require strong. Highest is reserved for work whose novelty, uncertainty, or coordination exceeds ordinary difficult coding. Length, urgency, file count, and security vocabulary alone do not set the tier. These criteria are not measured guarantees of model success. The `routine/standard/complex/demanding` keys remain stable for personal configuration.

## What the answers and scores mean

The current request uses `Choice` questions. Capability and effort are labels;
Switchboard does not calculate one numeric difficulty score or rank every
model/effort pair on a common scale. Novelty, uncertainty, interacting constraints,
and depth of analysis appear in the question criteria rather than as separately
weighted policy scores.

| Jev answer | Normalized value | Policy use |
| --- | --- | --- |
| `complexity.choice` | `routine`, `standard`, `complex`, or `demanding` | Selects the tier in `routing.TOOL`. |
| `complexity.confidence` | `confidences.model`, from `0` to `1` | Below `modelMinConfidence`, raises `routine` to `standard`; keeps stronger proposed tiers. |
| `effort_N.choice` for the selected model | `reasoning`: `low`, `medium`, `high`, `xhigh`, or `max` | Passes through that profile's `efforts` mapping. |
| That answer's `confidence` | `confidences.effort`, from `0` to `1` | Below `effortMinConfidence`, takes at least the profile's default reasoning before applying its effort mapping. |
| `sufficientContext.choice` | Boolean `sufficientContext` | `false` uses the `uncertain` profile and its `high` effort mapping. |
| `sufficientContext.confidence` | `confidences.context` | Diagnostic only; there is no context-confidence threshold. |
| `taskType.choice` and its confidence | `taskType` and `confidences.taskType` | Diagnostic only; neither changes the route. |
| Answer probability distributions | Optional diagnostics | Available for inspection; no additional routing weights or thresholds use them. |

TypeSafe derives confidence from the answer distribution. It is distinct from
the chosen option's probability and is not a measured chance that the coding
model will succeed. See [TypeSafe's confidence reference](https://docs.typesafe.ai/confidence).
The threshold comparison is strictly `confidence < threshold`: an answer at
exactly `0.70` meets a `0.70` threshold.

## How policy selects the pair

Model and effort confidence are retained separately. The provisional `modelMinConfidence` and `effortMinConfidence` defaults are both 0.70. Low model confidence imposes a balanced minimum while retaining a stronger proposed tier. Low effort confidence keeps the model and takes the higher of the proposed reasoning and that profile's `defaultReasoning`: low for Luna, medium for Sonnet and balanced-tier Sol, high for Opus and strong-tier Sol, and xhigh for Fable/Astra. Haiku sends no effort. A confident effort choice still uses its normal mapping, including low or max.

A missing or invalid selected-model effort answer/confidence uses that model's profile default. An answer bound to a different model cannot be reused. Invalid capability/context answers or a structurally malformed provider response use the classifier-unavailable fallback. The selected reasoning label passes through the personal profile's effort mapping, so users can still cap expensive effort levels.

Task type and its confidence are optional diagnostics: a missing or invalid answer is recorded as unavailable and does not veto an otherwise valid route. Context-answer confidence is also diagnostic. A negative sufficient-context answer, truncated task, or unavailable classifier uses the configured uncertain profile at high for a new conversation. Existing conversations retain their saved route. Legacy `minConfidence` overrides apply to both new thresholds unless a separate threshold is explicitly set. Old saved route files remain readable and retain their selected model and effort.

`switchboard explain` reports the separate confidence values, decision adjustments, turn-detection source, exclusions, and policy revision. New classifications also retain the Jev provider, requested/resolved version, and capability/context/selected-model effort distributions. Missing or malformed distributions are unavailable, never filled in; unknown Gateway model versions remain unknown. These probabilities describe Jev's choices, not the chance a coding model will succeed. Raw provider bodies and unselected effort distributions are not retained. Codex commentary distinguishes an effort default from a model fallback.

For examples and all editable fields, see the [customization guide](customization.md).

## Personal customization

1. Run `switchboard init` once. Existing personal overrides are preserved.
2. Run `switchboard config` for the settings menu, or
   `switchboard config set <setting> <value>` for a single change. Both validate
   before saving; see the [customization guide](customization.md).
3. Run `switchboard config show` to inspect the effective defaults plus your
   changes. Settings are stored in `~/.config/switchboard/policy.json` by
   default; `switchboard doctor` reports the path.
4. Exit the running CLI, relaunch with `switchboard claude` or `switchboard codex`,
   and start a new conversation. Configuration is loaded at launch. Existing
   conversations keep their saved model and effort even after relaunch/resume.

From an unpublished source checkout, replace `switchboard` in these commands
with `npm run switchboard --`.

| Setting | What you can change | Shipped default |
| --- | --- | --- |
| `enabledTools` | Enable Claude, Codex, or both. | Both |
| `excludedModels` | Remove models you cannot access or do not want to use. | None excluded |
| `routing` | Map each capability tier and the uncertain fallback to a named profile. | Four model tiers; Opus/Sol fallback |
| `profiles` | Set each profile's catalog model, effort mappings/caps, and default reasoning. | See the four tiers above |
| `classifier.modelMinConfidence` | Set the confidence threshold for applying the balanced model minimum. | `0.70` |
| `classifier.effortMinConfidence` | Set the threshold for retaining at least the selected profile's default reasoning. | `0.70` |
| `classifier.timeoutMs` | Limit how long routing waits for classification. | `3000` |
| `classifier.maxContextChars` | Bound the task text supplied to classification. | `16000` |
| `history.limit` | Retain this many decisions per conversation. | `20` |
| `history.capturePrompts` | Opt in to local raw-task retention. | `false` |

Model IDs and effort values must exist in the bundled catalog. Personal policy
does not add support for a new provider API or an unknown coding model.

Only changed settings need to be present in `policy.json`. For example:

```json
{
  "enabledTools": ["claude", "codex"],
  "excludedModels": {
    "claude": ["claude-fable-5-1"],
    "codex": ["gpt-6-astra"]
  },
  "classifier": { "timeoutMs": 3000 },
  "history": { "limit": 20, "capturePrompts": false }
}
```

Objects merge with shipped defaults; arrays replace the corresponding default list. Unknown keys, models belonging to the wrong tool, and unsupported model/effort combinations are rejected. Users can also customize named profiles, capability-to-profile bindings, model-specific effort mappings and default reasoning, the uncertain-task fallback, classifier limits, and history retention.

For example, this personal override caps Astra at high effort while retaining all five reasoning-demand labels:

```json
{
  "profiles": {
    "codex-astra": {
      "efforts": { "xhigh": "high", "max": "high" }
    }
  }
}
```

A new custom profile must supply mappings for all five labels. Partial overrides of a shipped profile inherit its other mappings. Unsupported effort values fail configuration validation; the router does not silently substitute them.

Exclusions apply to automatic selection. If a selected model is excluded, the policy prefers the next higher eligible tier. If none remains above it, the policy uses the highest eligible lower tier. Excluding all routed models fails explicitly. Excluding Fable/Astra therefore makes Opus/Sol the top automatic choices.

An existing conversation retains its model and effort after exclusions change.
Relaunch Switchboard and start a new conversation to use the updated policy.
An explicit native model choice takes precedence over automatic policy.

## Conversation and cache behavior

Turn detection prefers native identifiers and Claude prompt hooks. If the Claude prompt hook is missing, content routing is permitted only after a SessionStart startup/clear event confirms a fresh session and the request has no prior assistant/tool history. Title and quota helpers cannot establish a main route. If a supported request has a stable conversation identity and an existing route, missing turn metadata or a mismatched prompt hook continues that route without classifying again. Unknown endpoints, conflicting identity, and resumed history with no recoverable route still fail with recovery guidance. Disabling all hooks remains unsupported for automatic Claude launch because it removes fresh-session evidence too.

The core chooses a pair at the first user task and persists it by stable conversation ID. Follow-ups, tool-result continuations, and resume retain that pair. A harder follow-up can recommend a stronger model for a new conversation; it does not switch automatically. Uncertainty during a follow-up also retains the active pair.

Switchboard v0 pins effort as well as model. API documentation is insufficient evidence for adapting effort through a particular CLI/subscription path. The compatibility matcher requires an exact verified record, and the current catalog contains none. Enabling adaptation also requires a tested adapter that durably preserves and replays effort updates.

Provider usage parsing distinguishes missing counters from zero and accounts for Anthropic/OpenAI input totals separately. Cache hits are observations, not proof that an effort update preserved the whole prefix. No live cache probes run automatically.

Saved route files are private, written atomically, and contain allowlisted metadata. Raw task capture is off by default; opting in stores bounded task text locally. History is bounded per conversation, but there is not yet a global age-based cleanup command. Cross-process ownership rejects simultaneous ownership of one conversation.

The CLI launcher uses process-scoped settings. Direct desktop routing, remote/background sessions, custom execution gateways, managed provider modes, and cross-interface resume are outside v0. Ordinary desktop sessions keep their native configuration. TypeSafe, OpenRouter, and Vercel connections are supported for Jev classification.


## Inspecting decisions

Claude shows the selected pair below the existing status line. Codex shows the actual selected pair in its `[Router]` notice. For either tool,
`switchboard explain TOOL CONVERSATION_ID` reports the last saved decision and
latest available cache counters. `Saved automatic model` and `Effort` describe
the active route. `Effort assessed for` describes the model considered during
classification; on a pinned follow-up it can differ from the active model.
A recommendation applies only to a new conversation.

The saved conversation file also contains a bounded history of route metadata.
There is no history-listing command, aggregate usage dashboard, or savings
estimator in v0. Cache counters describe provider observations, not tokens
avoided by selecting a cheaper model. See [privacy and data flow](privacy.md)
for storage, optional prompt capture, and retention behavior.
