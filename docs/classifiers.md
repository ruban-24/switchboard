# Classifier connections

Switchboard currently supports Jev. Choose **TypeSafe**, **Vercel AI Gateway**,
**OpenRouter**, or a **TypeSafe-compatible endpoint** during `switchboard init`.
Enter the API key at the hidden prompt. Setup saves it in a private
`connection.json` beside your policy, so subsequent launches need no exports.

Your Claude Code or Codex login still handles coding-model access. These
connections are for classification only; they do not move coding inference to
a gateway or change your coding subscription.

## Supported contracts

| Setup choice | API base URL | Contract | Default model |
| --- | --- | --- | --- |
| TypeSafe | `https://api.typesafe.ai` | TypeSafe System One | `jev-latest` |
| OpenRouter | `https://openrouter.ai/api` | TypeSafe System One | `jev-latest` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v4/ai` | Vercel evaluation | `typesafe-ai/jev` |
| Custom endpoint | Your URL | TypeSafe System One | `jev-latest`, editable during setup |

The TypeSafe adapter appends `/v1/systemone` to the base URL. It sends the task
in `state`, routing `questions`, and a model ID; it reads typed answers and
confidence from the response. OpenRouter documents this same API in its
[TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk).
Its example pinned ID is `jev-1.13`; provider model names are not necessarily
interchangeable. Switchboard does not use the SDK's model-list endpoint, which
OpenRouter documents as incompatible.

The Vercel adapter uses the evaluation-model transport. It reads confidence
from `providerMetadata.typesafe.confidence`; it does not substitute the chosen
answer's probability for confidence. Use an **AI Gateway API key**, not a Vercel
CLI access token. See [Gateway evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation).

A custom URL must implement the selected contract, including confidence and
error behavior. An OpenAI-compatible chat-completions endpoint is not enough.
URLs require HTTPS, with HTTP allowed for loopback development servers. URLs
containing credentials, query parameters, or fragments are rejected.

Laya, Kev, and Cua-s1 support is planned. Each needs an adapter that normalizes
its outputs into Switchboard's classification format. Changing the model ID in
setup does not provide that adapter.

## Request and response examples

Classification and coding inference are separate requests. The classifier gets
the extracted user task and questions; the native coding provider receives the
conversation and tool context its CLI would normally send.

For direct TypeSafe, the adapter sends `POST /v1/systemone` with
`Authorization: Bearer <classifier key>` and a JSON body. The following is an
abbreviated request: question wording is shortened and only the capability
question is shown. The [question builder](../src/jev-questions.ts) contains the
complete production wording.

```json
{
  "model": "jev-latest",
  "state": { "task": "Implement an LRU cache with get and put operations." },
  "questions": {
    "complexity": {
      "type": "choice",
      "instructions": "Choose the least expensive sufficient capability tier.",
      "criteria": {
        "routine": "Mechanical edits and obvious local fixes.",
        "standard": "Bounded everyday engineering and familiar algorithms.",
        "complex": "Hard reasoning and interacting correctness constraints.",
        "demanding": "Exceptional reasoning or extensive autonomous work."
      }
    }
  }
}
```

With the shipped policy, the complete question map contains:

| Question key | Claude request | Codex request |
| --- | --- | --- |
| `taskType` | Kind of engineering task | Kind of engineering task |
| `complexity` | Required capability tier | Required capability tier |
| `sufficientContext` | Enough information to estimate difficulty? | Enough information to estimate difficulty? |
| `effort_0` | Effort assuming Sonnet | Effort assuming Luna |
| `effort_1` | Effort assuming Opus | Effort assuming Terra |
| `effort_2` | Effort assuming Fable | Effort assuming Sol |
| `effort_3` | Not sent | Effort assuming Astra |

These indexes are generated for the effective policy. Excluding or remapping a
model can change them; code binds each question to its model ID. Haiku gets no
effort question. Questions for all eligible models travel in the same request.

A direct TypeSafe response includes `model`, an `answers` map, and `usage`.
Here is a response excerpt for the Claude question set; other answers,
probability distributions, and usage are omitted. The values are illustrative,
not a measured result for the example task:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "complexity": { "type": "choice", "choice": "standard", "confidence": 0.88 },
    "sufficientContext": { "type": "choice", "choice": "true", "confidence": 0.95 },
    "effort_0": { "type": "choice", "choice": "medium", "confidence": 0.83 }
  }
}
```

With the shipped policy this selects Sonnet at medium effort: the capability
answer maps to Sonnet, both relevant confidence values meet `0.70`, and Sonnet's
`medium` mapping remains `medium`. The `true`/`false` context choice becomes a
boolean internally. Jev returns no reasoning essay; Switchboard explains the
rules it applied. The [TypeSafe API reference](https://docs.typesafe.ai/api)
documents the full response contract.

OpenRouter uses the same System One contract at
`https://openrouter.ai/api/v1/systemone`. Vercel uses
`POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model`, with the model in the
`ai-model-id` header and the same `state` and `questions` in its JSON body.
The Vercel adapter reads each answer's confidence from
`providerMetadata.typesafe.confidence[questionKey]` and normalizes it into the
same internal classification. All adapters make one attempt; the default
router deadline is 3 seconds.

For coding inference, Switchboard replaces the `switchboard` alias with the
selected provider model. A Claude request uses `model` and
`output_config.effort`, with `thinking: { "type": "adaptive" }` for effort-capable
models. Haiku has thinking, effort, and incompatible thinking-pruning settings
removed. A Codex request uses `model` and `reasoning.effort`. Existing
conversation content, tools, and native authentication go to the original coding
provider. The classifier key is separate from native authentication.

Classifier errors or invalid required answers select the configured fallback
for a new conversation; missing effort for the chosen model uses its profile
default. A saved conversation stays pinned. Native provider errors pass back to
the CLI; Switchboard does not retry the task on another coding model.

## Environment overrides

Saved settings work without shell variables. For a secret manager, CI, or a
local development environment, use:

| Variable | Purpose |
| --- | --- |
| `SWITCHBOARD_PROVIDER` | `typesafe`, `openrouter`, or `vercel`. Defaults to the saved provider, then `typesafe`. |
| `SWITCHBOARD_API_KEY` | Key for the selected connection; takes precedence over provider-specific names. |
| `SWITCHBOARD_BASE_URL` | Override the selected adapter's base URL. |
| `SWITCHBOARD_MODEL` | Override the classifier model ID. |
| `TYPESAFE_API_KEY` / `JEV_API_KEY` | Direct TypeSafe key; `JEV_API_KEY` takes precedence if both are set. |
| `TYPESAFE_DEFAULT_MODEL` / `TYPESAFE_BASE_URL` | TypeSafe-only alternatives to the generic model and URL overrides. |
| `OPENROUTER_API_KEY` | OpenRouter key. |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key. |

Nonempty environment values take precedence over the saved connection. Blank
placeholders in environment files are ignored. Selecting another
provider through the environment does not reuse the saved provider's key,
model, or URL. Having several provider keys does not enable automatic failover.
Classifier keys are removed from the native coding CLI's environment.

The installed CLI does not discover `.env` files in your projects. Source
commands `npm run switchboard -- ...` and `npm run check:jev` explicitly load
the checkout's `.env.local` when present. Keep this file private and out of Git.

## Check a connection

`switchboard doctor` checks configuration and key presence without a network
request. A new routed task exercises the configured connection. If it fails or
times out, the new conversation uses your configured conservative fallback;
existing conversations retain their saved route. Inspect the status line,
Codex notice, or `switchboard explain` to distinguish a fallback from a Jev choice.

From a source checkout, this optional command makes **one paid Jev request**
with a fixed, non-private spelling task and a 10-second deadline:

```sh
npm run build
npm run check:jev
# Or the Codex candidate set:
npm run check:jev -- codex
```

It does not read repository content, launch a coding model, or measure routing
quality. Ordinary automated tests use synthetic responses, including an
OpenRouter request/response contract check; they make no paid model calls.
