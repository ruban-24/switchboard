# Changelog

## Unreleased

### Routing

- Claude Code's strong tier now uses Opus 5.5 (`claude-opus-5-5`).
- Codex now routes to GPT-6 Luna, GPT-6 Sol, and GPT-6 Astra. GPT-6 has no Terra
  model, so Sol serves both the balanced and strong tiers: the new
  `codex-sol-balanced` profile defaults to medium reasoning when effort is
  uncertain, and `codex-sol` keeps high. The shipped policy id is now
  `default-v0.4`.
- GPT-5.6 Luna, Terra, Sol, and Opus 5 stay in the catalog. Personal policies
  that reference them remain valid, and `codex-terra` keeps Terra selectable while
  Codex offers it. Existing conversations keep their saved model and effort.
- Jev effort questions no longer name the model. They describe its capability
  role, because the classifier cannot know models released after its training.
  Code still binds each answer to its model.

### Setup and visibility

- `switchboard doctor --fix` compares your policy with the models your installed
  Codex offers and proposes changes, such as restoring a shipped route or
  excluding a missing model. It asks before saving and backs up `policy.json`.
- `doctor` shows the effective automatic lineup for each enabled agent, and a
  Codex launch that fails because a routed model is missing points to
  `doctor --fix`.
- GPT-6 Luna and Sol require a Codex build that bundles them (0.156.1 or later).

## 0.1.0

Switchboard's first release routes Claude Code and Codex conversations to a
model and reasoning effort using Jev and a policy you control. It runs locally
on macOS and Linux and is licensed under Apache-2.0.

### Routing

- One Jev request assesses the task's capability needs, available context, and
  effort for each eligible model. Local policy selects the final model and effort.
- Four default tiers cover Haiku, Sonnet, Opus, and Fable for Claude Code, and
  GPT-5.6 Luna, Terra, Sol, and GPT-6 Astra for Codex. Exclude models your account
  cannot use, map tiers differently, cap effort, or adjust confidence thresholds.
- Model and effort stay fixed through follow-ups, tool calls, and resume to
  avoid Switchboard-driven cache disruption. A follow-up can recommend a stronger
  route for a new conversation.
- New conversations use the configured fallback when the classifier is
  unavailable or cannot assess the task. Explanations identify fallback and
  confidence adjustments.

### Setup and visibility

- Install through npm, npx, or the `ruban-24/tap` Homebrew tap.
- `switchboard init` detects installed agents, offers Jev connection presets,
  accepts a key through hidden input, and optionally configures your shell.
- Jev connections support TypeSafe directly, Vercel AI Gateway, OpenRouter, and
  custom endpoints that implement a supported Jev contract. OpenRouter support
  follows its documented contract and has synthetic coverage; it has not been
  live-tested for this release.
- Claude adds a route status line beneath your existing one. Codex shows a
  routing notice in the conversation. `switchboard explain` reads saved decisions.

### Privacy and scope

Switchboard has no hosted routing service or telemetry. Classifier keys are
stored locally with owner-only permissions, and raw-prompt logging is off by
default. Extracted task text is sent to your chosen Jev provider; coding
inference and native transcripts remain with Claude Code or Codex. Provider
usage is billed separately.

The release supports local interactive CLI sessions on macOS and Linux. Native
Windows, desktop-app routing, remote/background sessions, additional coding
agents, and other System One classifiers are outside 0.1.0. An explicit native
model choice bypasses automatic routing. Prompt caching and answer quality
remain dependent on the native provider and the task.

See [installation](docs/distribution.md), [personal policy](docs/customization.md),
and [native CLI compatibility](docs/native-cli.md) for setup and limitations.
