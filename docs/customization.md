# Customize Switchboard

Switchboard separates the classifier's judgment from your rules. Jev assesses
the task; your policy decides which model and effort to use. You can change the
policy without changing the classifier or reinstalling Switchboard.

## Change your settings

You never need to open a configuration file. Pick whichever is convenient:

- **Menu:** run `switchboard config`. It shows your current models for each tier,
  skipped models, effort limits, agents, prompt history, and classifier
  connection. Changes are collected, shown as a summary, and saved only after you
  confirm.
- **One command:** `switchboard config set <setting> <value>`, for example
  `switchboard config set routing.codex.standard codex-terra`. Use
  `switchboard config get <setting>` to read the effective value and
  `switchboard config unset <setting>` to return to the shipped default. Values
  that parse as JSON (numbers, `true`, lists such as `'["gpt-6-astra"]'`) are
  used as JSON; anything else is text.
- **Doctor:** run `switchboard doctor` in a terminal. After its report it offers
  to check the models your installed Codex offers and to fix what it finds.

Every change is validated before it is written: unknown settings, unknown
models, unsupported effort values, and changes that leave an agent without a
routable model are rejected, and the file is left as it was. The previous
policy is kept as `policy.json.bak`.

Then exit the running coding CLI, relaunch with `switchboard claude` or
`switchboard codex`, and start a new conversation. Policy is loaded at launch;
a running process does not reload edits. Resuming an existing conversation
keeps its saved model and effort.

From a source checkout, use `npm run switchboard --` in place of `switchboard`.
Keys belong in the private connection settings created by `init`, not in policy.

The settings live in `policy.json` in the directory `switchboard doctor`
reports (default `~/.config/switchboard`). You can still edit it directly: it
holds only your changes. Objects merge with defaults; arrays replace the default
list. Run `switchboard config check` after a manual edit.

## Choose the change you want

Your personal file overrides the shipped defaults for your user account. It is
not a project policy, and you do not need to fork or rebuild Switchboard to edit
it. Combine the examples below in one JSON object, keeping one `routing`,
`profiles`, or `classifier` object when changing several fields in that section.

| What you want | Change | Effect on new automatic conversations |
| --- | --- | --- |
| Accept more cheaper-model proposals | Lower `classifier.modelMinConfidence` | Fewer low-confidence `routine` judgments are raised to the `standard` profile. It does not downgrade a `complex` judgment. |
| Use stronger models for everyday tasks | Map `routing.claude.standard` to `claude-opus`, or `routing.codex.standard` to `codex-astra` | A task classified as `standard` selects Opus or Astra; effort is assessed for that model. Codex already uses Sol for `standard`; mapping it to `codex-sol` only raises the uncertain-effort default to high. |
| Keep GPT-5.6 Terra for everyday Codex tasks | Map `routing.codex.standard` to `codex-terra` | Standard tasks use Terra while your Codex still offers it. |
| Avoid the smallest model altogether | Map `routine` to a stronger profile, or exclude Haiku/Luna | Routine tasks use the replacement profile or next eligible tier. |
| Avoid a model your plan cannot access | Choose **Models to skip** in `switchboard config`, or run `switchboard doctor` | Automatic selection skips it; excluding every routed model is an error. |
| Accept more lower-effort proposals | Lower `classifier.effortMinConfidence` | Fewer proposals are raised to the selected profile's default reasoning. Model selection is unchanged. |
| Use less effort on a particular model | Map its `xhigh` and `max` effort labels to `high` | Those judgments send `high` to the provider, even when Jev is confident. |
| Require more effort on a particular model | Map its `low` and `medium` labels to `high` | Low/medium judgments send `high`; other mappings stay unchanged. Haiku cannot accept effort. |
| Be more cautious when effort is uncertain | Raise `profiles.NAME.defaultReasoning` | Missing effort uses that default; low-confidence effort uses the higher of the proposal and default, then applies your effort mappings. |
| Change the classifier-error fallback | Set `routing.TOOL.uncertain` | Failed classification, insufficient context, or truncated input uses this profile and its `high` mapping. |
| Spend less time waiting for classification | Lower `classifier.timeoutMs` | A slow classifier reaches fallback sooner. This may use a stronger fallback more often. |
| Allow more task text in classification | Raise `classifier.maxContextChars` | Sends more task text to the classifier and can avoid truncation-triggered fallback; it may increase classifier usage. |
| Keep less local history | Lower `history.limit`; leave `capturePrompts` false | Changes retention, not the selected model or effort. The active route remains saved for resume. |

Exclusions and effort mappings apply after the corresponding classification
judgment. For example, lowering confidence thresholds cannot select an excluded
model or bypass an effort cap. Native manual choices bypass automatic policy.

## Common changes

**Exclude models you cannot access.** This removes Fable and Astra from automatic
selection. If the highest tier is needed, Opus or Sol becomes the best remaining
choice. When a lower tier is excluded, Switchboard first tries a higher eligible
tier.

```json
{
  "excludedModels": {
    "claude": ["claude-fable-5-1"],
    "codex": ["gpt-6-astra"]
  }
}
```

**Enable one agent.** `doctor` only requires enabled agents to be installed.

```json
{
  "enabledTools": ["codex"]
}
```

**Cap effort for a model.** Jev can still assess demand as `xhigh` or `max`, but
this mapping sends `high` to Sonnet. The other effort mappings keep their defaults.

```json
{
  "profiles": {
    "claude-sonnet": {
      "efforts": { "xhigh": "high", "max": "high" }
    }
  }
}
```

**Use Sonnet for the simplest Claude tasks too.** Routing maps capability tiers
to profile names, not directly to model IDs.

```json
{
  "routing": {
    "claude": { "routine": "claude-sonnet" }
  }
}
```

**Adjust confidence thresholds.** These values are examples, not calibrated
recommendations:

```json
{
  "classifier": {
    "modelMinConfidence": 0.80,
    "effortMinConfidence": 0.75
  }
}
```

Below the model threshold, Switchboard applies a balanced minimum and keeps any
stronger tier Jev proposed. It does not automatically jump to the highest model.
Below the effort threshold, it uses at least the chosen profile's default
reasoning, retaining a higher proposed effort. Confidence describes the
classification; it is not a measured probability that the coding task will pass.

Lowering a threshold accepts more of Jev's proposals without applying the
uncertainty rule. With the shipped mappings, this can mean cheaper models or
lower effort. Raising it applies the corresponding rule more often. Neither
threshold is a general instruction to choose Opus or Astra more often.

These examples assume a valid classification, sufficient context, and no model
exclusions. The first two rows change `modelMinConfidence`; the last two change
`effortMinConfidence`. Other settings stay at their shipped defaults.

| Jev judgment | Threshold `0.70` | Threshold `0.50` |
| --- | --- | --- |
| `routine` with model confidence `0.60` | Sonnet / Sol model minimum | Haiku / Luna model accepted |
| `complex` with model confidence `0.60` | Opus / Sol retained | Opus / Sol retained |
| Sonnet effort `low` with effort confidence `0.60` | Sonnet `medium` | Sonnet `low` |
| Sonnet effort `max` with effort confidence `0.60` | Sonnet `max` | Sonnet `max` |

For example, to accept more of the classifier's proposals:

```json
{
  "classifier": {
    "modelMinConfidence": 0.50,
    "effortMinConfidence": 0.50
  }
}
```

These numbers illustrate behavior; they are not calibrated recommendations.
Lower thresholds do not disable fallback on a failed request, invalid required
answer, insufficient context, or truncated input. Effort caps still apply.

**Use stronger models more often.** Change the capability-to-profile mapping.
This uses Opus for Claude `standard` tasks as well as `complex` tasks, and keeps
Codex on Sol with the strong tier's high uncertain-effort default:

```json
{
  "routing": {
    "claude": { "standard": "claude-opus" },
    "codex": { "standard": "codex-sol" }
  }
}
```

**Keep GPT-5.6 Terra for balanced Codex tasks.** GPT-6 has no Terra model, so
the shipped policy uses Sol for the balanced tier. Terra stays in the catalog
while Codex offers it:

```json
{
  "routing": {
    "codex": { "standard": "codex-terra" }
  }
}
```

If a later Codex release drops Terra, automatic Codex launch reports the missing
model. Run `switchboard doctor` to restore the shipped route without
editing JSON. The same change as a command:
`switchboard config set routing.codex.standard codex-terra`.

Jev still assesses effort for the model policy selects. This mapping does not
force high effort. To raise even a confident low-effort choice, change the
profile's `efforts` mapping, for example `"low": "high"`. Raising only
`defaultReasoning` affects uncertain or missing effort answers.

For example, to require at least high effort whenever Sonnet is selected:

```json
{
  "profiles": {
    "claude-sonnet": {
      "efforts": { "low": "high", "medium": "high" }
    }
  }
}
```

The shipped `high`, `xhigh`, and `max` mappings stay unchanged. To change only
uncertain or missing Sonnet effort answers, use this instead:

```json
{
  "profiles": {
    "claude-sonnet": { "defaultReasoning": "high" }
  }
}
```

With this second override, a confident `low` answer still selects low effort.
An uncertain `low` answer or missing effort answer uses high. Other personal
effort mappings, such as a medium cap, still apply after that rule.

**Choose a fallback profile.** `uncertain` handles classifier failures,
insufficient context, and truncated task input. For example, to use Astra on
uncertain Codex tasks:

```json
{
  "routing": {
    "codex": { "uncertain": "codex-astra" }
  }
}
```

The fallback uses the selected profile's `high` mapping. Set that mapping if you
also want a different fallback effort. Raising a profile's `defaultReasoning`
changes low-confidence or missing-effort handling; it does not change this
classifier-unavailable fallback rule.

## Let doctor fix it

In a terminal, `switchboard doctor` prints its offline report and then offers
two checks. With your consent it compares your policy with the models your
installed Codex offers. It runs `codex debug models --bundled`, a local command,
and makes no AI request. For each routed model Codex lacks, it offers to restore the
shipped route (when you had changed it), exclude the model, or keep the policy
and update Codex yourself. It also offers to lift an exclusion for a model Codex
now offers. It shows the resulting changes, asks before saving, and backs up the
previous file to `policy.json.bak`. In scripts and CI, `doctor` prints only its
offline report and never runs either CLI. `switchboard doctor --fix` runs the
checks without asking first and repeats questions you answered before.

Claude Code has no local model list, so doctor cannot check Claude model access
automatically. Instead it asks whether your plan can use Fable, the highest
Claude tier, and remembers the answer if you keep it. Some Claude subscriptions require usage credits for Fable;
its requests then fail with "Usage credits are required for this model." If
your plan cannot use it, doctor routes the highest tier to Opus 5.5
(`"routing": { "claude": { "demanding": "claude-opus" } }`). A later run offers
to switch back to Fable. Start a new conversation after the change: an existing
conversation keeps its saved model.

## Check a change and undo it

`switchboard config check` validates the policy; `switchboard config show` prints
the merged configuration. Neither calls Jev or predicts its answer to a task.
After relaunching, try a fresh conversation and inspect the Claude status line,
Codex routing notice, or `switchboard explain TOOL CONVERSATION_ID`.

Check the active selection, confidence values, adjustments, and any excluded
model. A `pinned` decision means the conversation is retaining its earlier
route. A recommendation describes another conversation's suggested route; it
has not changed the active model. If a setting seems ineffective, first check
that you relaunched, started a new conversation, and did not select a native
model manually. A live trial uses classifier credits and coding-provider quota.

To undo one change, remove that field from your personal JSON object so it
inherits the shipped default. For a partial effort override, remove the
individual mapping. To restore all policy defaults, replace the file's contents
with `{}`; the API key stays in the separate `connection.json`. Validate again
and relaunch. Saved conversations still retain their original pair.

## Policy reference

| Field | Allowed values | Default and effect |
| --- | --- | --- |
| `enabledTools` | A list containing `claude`, `codex`, or both | Both; limits automatic launch and doctor requirements. |
| `excludedModels.claude` / `.codex` | Lists of model IDs from the [catalog](model-catalog.md) | Empty; removes those models from new automatic choices. At least one routed model must remain. |
| `routing.TOOL.TIER` | A profile belonging to that tool | Tiers are `routine`, `standard`, `complex`, `demanding`, and `uncertain`. |
| `profiles.NAME.tool` | `claude` or `codex` | Must agree with the profile's catalog model. |
| `profiles.NAME.model` | A model ID from the catalog | Sets the coding model for this profile. |
| `profiles.NAME.efforts` | Mappings for `low`, `medium`, `high`, `xhigh`, `max` | Each value must be supported by the profile's model; Haiku requires `null`. |
| `profiles.NAME.defaultReasoning` | `low`, `medium`, `high`, `xhigh`, `max` | Used when that model's effort answer is absent or uncertain. |
| `classifier.modelMinConfidence` | Number from `0` to `1` | `0.70`; below it, apply the balanced minimum. |
| `classifier.effortMinConfidence` | Number from `0` to `1` | `0.70`; below it, retain at least the profile's default reasoning. |
| `classifier.timeoutMs` | Integer from `1` to `30000` | `3000`; deadline for a classification request. |
| `classifier.maxContextChars` | Integer from `256` to `100000` | `16000`; limit on task text. Truncation uses the uncertain fallback. |
| `history.limit` | Integer from `0` to `1000` | `20` decisions per conversation. `0` still saves the active route for resume. |
| `history.capturePrompts` | `true` or `false` | `false`; opt in to saving task text locally. |
| `id` | Nonempty text | `default-v0.3`; an optional label recorded with decisions. |
| `version` | `1` | Policy schema version; leave unchanged. |

The built-in profile names are `claude-haiku`, `claude-sonnet`, `claude-opus`,
`claude-fable`, `codex-luna`, `codex-sol-balanced`, `codex-sol`, `codex-astra`,
and `codex-terra`. `codex-sol-balanced` and `codex-sol` both use GPT-6 Sol;
the balanced profile defaults to medium reasoning when effort is uncertain.
`codex-terra` uses GPT-5.6 Terra and is not routed by default.
A new named profile needs a tool, catalog model, and all five effort mappings.
Partial edits to a built-in profile inherit its remaining fields.

For example, this adds a Sonnet profile capped at medium and uses it for the
balanced tier:

```json
{
  "profiles": {
    "my-sonnet": {
      "tool": "claude",
      "model": "claude-sonnet-5",
      "defaultReasoning": "medium",
      "efforts": {
        "low": "low",
        "medium": "medium",
        "high": "medium",
        "xhigh": "medium",
        "max": "medium"
      }
    }
  },
  "routing": { "claude": { "standard": "my-sonnet" } }
}
```

An explicit native model or effort selection bypasses automatic policy, including
exclusions. Use native controls when you want to choose a model yourself.

## Connection and display settings

Run `switchboard init` again to change the connection or API key. Your policy is
preserved. [Classifier connections](classifiers.md) lists provider presets,
custom URLs, model IDs, and environment overrides.

Set `SWITCHBOARD_STATUSLINE=off` before launching Claude to keep only its normal
status line. The Switchboard wrapper is temporary; it does not edit Claude's
saved settings. The [native CLI guide](native-cli.md) describes how existing
status commands are combined.

## Add or change Jev questions

**Question definitions are currently a source extension, not a `policy.json`
setting.** Policy can change the two confidence thresholds above. It cannot add
an arbitrary question or a rule for a new answer; unknown fields are rejected.

The main extension points are:

| File | Responsibility |
| --- | --- |
| [`src/capability-question.ts`](../src/capability-question.ts) | Defines the four capability tiers. Changes affect both model classification and the model roles supplied to effort questions. |
| [`src/jev-questions.ts`](../src/jev-questions.ts) | `buildJevQuestions` defines questions; `parseJevAnswers` validates typed answers and confidence. |
| [`src/core/types.ts`](../src/core/types.ts) | Defines the normalized classification and policy fields. |
| [`src/core/config.ts`](../src/core/config.ts) | Validates and merges personal policy, including new thresholds. |
| [`src/core/policy.ts`](../src/core/policy.ts) | Applies deterministic selection rules and validates classifications. |
| [`src/storage.ts`](../src/storage.ts) | Validates saved decisions; new data must survive save and reload. |
| [`src/defaults.ts`](../src/defaults.ts) | Supplies default threshold values and profile mappings. |

Suppose you want a new judgment about whether a task changes a security boundary:

1. Add a typed `Choice` question with defined answers and clear criteria to
   `buildJevQuestions`. Keep it in the same request as the existing questions.
2. Parse its answer and confidence in `parseJevAnswers`. Define what missing,
   malformed, or uncertain output means; do not turn it into a confident answer.
3. Add the normalized field and its validation. If users should control a
   threshold, add that field to the policy type, parser, and shipped defaults.
4. Add a rule in `core/policy.ts` that uses the answer and threshold. For example,
   require at least a chosen tier when a confident answer indicates a security
   boundary change. Check exclusions and the existing confidence rules too.
5. Test both Jev transports, policy behavior above and below the threshold,
   malformed responses, and save/resume. Update explanations if the rule changes
   the selected route. Use [the contributor checks](../CONTRIBUTING.md).

Adding a question alone does not change routing. The parser and policy must
consume it. Changing model selection must also keep the effort answer tied to
the model actually selected. Raw provider responses and free-form reasoning
should not be added to saved route history.

For another classifier model, implement the `Classifier` interface and its API
adapter. Keep policy and execution in code. Supporting an API request schema is
only part of the contract: answer types, confidence meaning, cancellation, and
failure behavior also need tests.
