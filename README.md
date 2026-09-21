<img src="assets/switchboard-icon.png" alt="Switchboard icon" width="112" height="112">

# Switchboard

**An open-source, model-agnostic decision router for Claude Code and Codex.**

Describe the task. Let Switchboard choose the model and reasoning effort.

If you default to the strongest model at maximum effort because you are unsure
what a task needs, Switchboard makes that choice for you. It uses a System One
model to assess the task's reasoning demands and applies your policy inside the
coding CLI you already use. The selected model and effort stay fixed for the
conversation to avoid disrupting its prompt cache.

![Switchboard automatically selects GPT-5.6 Terra with low effort for a linked-list task in Codex](assets/switchboard-codex-demo.gif)

*A real Codex session: submit a task and see Switchboard's model and effort choice.*

- **Task-aware decisions.** Powered by Jev, a System One model built for fast,
  structured judgments. The routing policy is independent of the classifier;
  adapters for Laya, Kev, and Cua-s1 are planned.
- **Stable conversations.** Model and effort stay fixed through tool calls,
  follow-ups, and resume. A new conversation gets a fresh routing decision.
- **Your policy.** Use the defaults, exclude unavailable models, or customize
  model tiers, effort caps, confidence thresholds, and fallback behavior.
- **Open source and free to use.** Apache-2.0. All Switchboard routing code is
  available to inspect, change, and run yourself. No Switchboard account or
  subscription; classifier and coding-provider usage are billed separately.
- **Local control.** The proxy and route history run on your machine. No
  Switchboard telemetry or hosted routing service. Hosted Jev receives task
  text through your own API key; see [privacy and data flow](docs/privacy.md).

## Get started

The first release targets **macOS and Linux**. You need Node.js **22.18+**, npm,
an installed and logged-in **Claude Code or Codex**, and a Jev API key from
**TypeSafe, Vercel AI Gateway, or OpenRouter**.

Install and sign in to your agent first: [Claude Code quickstart](https://code.claude.com/docs/en/quickstart)
or [Codex CLI setup](https://developers.openai.com/codex/cli). Switchboard uses
that existing login and does not install the agent for you.

Install Switchboard with npm:

```sh
npm install -g @ruban24/switchboard
switchboard init
switchboard doctor
switchboard claude
# Or: switchboard codex
```

Or install with Homebrew, which also installs Node:

```sh
brew install ruban-24/tap/switchboard
switchboard init
switchboard codex
```

To try it without a global installation:

```sh
npx --package=@ruban24/switchboard switchboard init
npx --package=@ruban24/switchboard switchboard claude
```

`init` detects installed coding agents and asks which to enable. Choose your
Jev provider, enter the key in a hidden prompt, and optionally add a configuration
path to your shell profile. The key is saved in a file readable only by your user.
You can launch immediately, with no alias or shell restart. Existing personal
policy is preserved when you run setup again.

Setup makes no AI calls. `doctor` checks your policy, enabled agents, and whether
a key is present; a routed task tests the connection. Your coding CLI keeps its
existing login. See [classifier connections](docs/classifiers.md) for endpoints
and [privacy](docs/privacy.md) for what leaves your machine.

Choose one package manager for your global installation. The
[installation guide](docs/distribution.md) covers shell profiles, environment
overrides, updates, and removal.

### Run from source

Clone the repository, build, and use the same setup:

```sh
git clone https://github.com/ruban-24/switchboard.git
cd switchboard
npm ci
npm run build
npm run switchboard -- init
npm run switchboard -- doctor
npm run switchboard -- claude
# Or: npm run switchboard -- codex
```

From a checkout, `npm run switchboard` also loads `.env.local` if present;
those values override saved connection settings. Installed commands do not
load project environment files.

## How reasoning-based routing works

Switchboard makes two related decisions: **which model has enough capability**
for the task, and **how much reasoning effort that model needs**. A stronger
model at low effort and a smaller model at maximum effort are different choices;
Switchboard does not treat them as interchangeable points on one scale.

![Animated routing flow: a System One model (Jev) assesses an LRU cache coding task, customizable local policy chooses the model and effort, then Switchboard pins the pair for the conversation](assets/switchboard-routing.gif)

*Illustrative example: a System One model (Jev) supplies judgments and confidence; your policy makes
the final choice.* [Static diagram](assets/routing-overview.svg) ·
[MP4 version](assets/switchboard-routing.mp4)

**What Jev assesses.** The local proxy extracts the user task and sends one
request to Jev. It considers how familiar the work is, what remains uncertain,
which constraints interact, and how much analysis is needed. These are criteria
for its judgments, not separate numeric scores; prompt length alone does not
determine the route.

| Judgment | What Jev returns | How Switchboard uses it |
| --- | --- | --- |
| Capability needed | Fast, balanced, strong, or highest | Maps to a model through your policy. |
| Enough context to classify? | Yes or no | Uses the configured fallback when difficulty cannot be estimated. |
| Effort for each eligible model | Low, medium, high, xhigh, or max | Reads the answer for the model policy actually selects. Haiku needs no effort answer. |
| Task type | Explain, edit, implement, debug, review, architecture, or other | Records it for diagnostics; it does not set the model tier. |

Each judgment includes a confidence value from **0 to 1**. Capability and
selected-model effort have separate policy thresholds; both default to **0.70**.
Task-type and context confidence are diagnostic. Confidence describes how
decisive the classification is, not the probability that the coding model will
complete the task correctly. [TypeSafe explains confidence here](https://docs.typesafe.ai/confidence).

**How policy selects the pair.** Shipped defaults merge with your personal
overrides. Policy maps the capability tier to a model, applies a balanced
minimum when model confidence is low, and respects your exclusions. A stronger
proposed tier stays stronger. It then reads **that model's** effort answer,
applies effort confidence rules and profile defaults, and passes it through
your effort mappings or caps. If Jev is unavailable or cannot classify the
task, a new conversation uses the configured fallback.

Your policy also determines which models get effort questions in the first
place. Those conditional questions are bundled into the same Jev request;
there is no second call after model selection. The local policy makes the final
choice.

**Run and remember.** The native provider executes the task. Switchboard saves
the selected model and effort locally and reuses them for that conversation.
Tool continuations do not trigger another classification. Later user turns can
suggest a stronger route for a new conversation, without changing the active one.

[Jev](https://docs.typesafe.ai/concepts/system-one) returns structured answers
and probabilities. It does not solve the coding task or write a reasoning essay
first. Switchboard's routing explanations describe the policy decision; the
coding model still does the work. A confident classification is not a guarantee
that the selected model will produce a correct answer.

For implementation details, see the [architecture and routing rules](docs/routing.md),
[request/response examples](docs/classifiers.md#request-and-response-examples),
and [personal policy guide](docs/customization.md).

The default capability tiers are:

| Tier | Intended work | Claude Code | Codex |
| --- | --- | --- | --- |
| Fast | Mechanical edits and simple, bounded requests | Haiku | GPT-5.6 Luna |
| Balanced | Everyday implementation, familiar algorithms and scoped changes | Sonnet | GPT-5.6 Terra |
| Strong | Difficult debugging or consequential correctness decisions | Opus | GPT-5.6 Sol |
| Highest | Exceptional reasoning or extensive work beyond the strong tier | Fable | GPT-6 Astra |

For example, an LRU cache implementation ordinarily fits the balanced tier;
reviewing concurrent money transfers may need the strong tier. These describe
the policy's intent, not fixed prompt-to-model rules. Effort is assessed
separately for the selected model. Haiku gets no effort parameter; the other
configured models support mappings for `low`, `medium`, `high`, `xhigh`, and
`max`. See [routing and policy](docs/routing.md) for the exact rules.

## Keep the cache useful

Coding agents repeatedly send shared context: instructions, tool definitions,
conversation history, and code. Provider prompt caching can reuse that work.
Moving a conversation to another model can lose that reuse, so a cheaper model
midway through a task can still produce a more expensive overall run.

**Switchboard keeps both model and effort fixed for the whole conversation.**
This includes follow-up prompts, tool calls, and resume. Start a new conversation
for an independent task or to take a stronger-model recommendation. An explicit
native model choice still overrides automatic routing.

This avoids cache disruption caused by Switchboard changing the active model or
effort. It cannot guarantee a cache hit: provider expiration, context changes,
compaction, and native CLI behavior still matter. See the
[Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
and [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)
caching documentation for provider behavior.

## See what it chose

Claude displays the selected model and effort in a Switchboard status line below
your existing status line. Codex displays a routing notice in the conversation.
An illustrative initial selection and follow-up look like this:

```text
[Router] gpt-5.6-terra / medium — Jev capability and effort selection.
[Router] gpt-5.6-terra / medium — pinned for this conversation.
```

For either CLI, inspect a saved conversation with:

```sh
switchboard explain claude CONVERSATION_ID
switchboard explain codex CONVERSATION_ID
```

Use the native session UUID as `CONVERSATION_ID`. The
[session guide](docs/native-cli.md#find-a-conversation-and-resume-it) shows how to
find it and resume through Switchboard. From a source checkout, use
`npm run switchboard -- explain` in place of `switchboard explain`.

`explain` shows the active model and effort, the policy reason, confidence
adjustments, and any recommendation for a new conversation. Claude's model label
shows `switchboard`, and Codex's header shows `switchboard auto`. These identify
automatic routing; the Claude status line and Codex notice show the selected model.
[Native CLI details](docs/native-cli.md) explain this behavior.

Route metadata is stored locally without raw prompts by default. You can inspect
the decision without enabling task-text logging. Review the coding result as
you normally would; a routing decision alone does not establish answer quality.

## Set your limits

Personal settings live at `~/.config/switchboard/policy.json` by default.
Run `doctor` to find the actual path.

Exclude models your plan cannot use, or tiers you prefer not to spend on:

```json
{
  "excludedModels": {
    "claude": ["claude-fable-5-1"],
    "codex": ["gpt-6-astra"]
  }
}
```

Only include settings you want to change. Objects merge with the defaults;
arrays replace them. Validate with `switchboard config check` and inspect the
result with `switchboard config show`. Edit the personal `policy.json` file, not
the package's source or installed defaults; see the
[customization guide](docs/customization.md).

For setup errors or a route that keeps falling back, see
[troubleshooting](docs/native-cli.md#troubleshooting). The
[installation guide](docs/distribution.md#upgrade-or-uninstall) covers updates,
uninstallation, and saved settings.

Relaunch Switchboard and start a new conversation to apply changes. Existing
conversations retain their saved pair. The [policy reference](docs/routing.md)
covers profiles, effort caps, timeouts, confidence thresholds, fallback models,
and local history settings.

## Privacy and supported use

Switchboard is fully open-source software, with no Switchboard backend receiving
your prompts. You control the code, keys, policy, and local route history.
**The current hosted classifier does receive extracted task text**, which can
include code or secrets you put in a prompt. Coding inference goes to your
native provider. Local raw-prompt logging is off by default; native transcripts
and provider retention are separate. Read [the data flow](docs/privacy.md)
before using it with sensitive work.

Claude Code and Codex local interactive sessions are supported adapters. Both
have passed interactive validation on macOS and a Debian Linux VM with native
sandboxing. See [native CLI compatibility](docs/native-cli.md) for tested versions.
Native Windows, desktop-app routing,
remote/background sessions, and custom coding-model gateways are outside v0.

Support for **other System One classifier models** and **more coding agents,
including OpenCode and Pi**, is planned. Jev is the supported classifier today,
through TypeSafe, Vercel AI Gateway, or OpenRouter. Laya, Kev, and Cua-s1 are
planned additions; each will need an adapter for its judgments and confidence
format. A new endpoint alone does not make a different model compatible.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, native adapter guidance,
and reporting routing problems. Run `npm test` and `npm run test:package` before
submitting a code change. Report vulnerabilities as described in
[SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE). Copyright 2026 Ruban. See [NOTICE](NOTICE) and
[third-party licenses](THIRD_PARTY_NOTICES.md).
