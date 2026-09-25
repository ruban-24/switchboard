# Model capability snapshot

Checked against the provider documentation on 2026-09-24. These are API model IDs and documented effort values. Availability depends on your account, installed native CLI, and authentication path. Exclude models your plan cannot use. Nothing here establishes cache preservation.

| Tool | Default tier | Family | Provider model ID | Documented API effort values |
| --- | --- | --- | --- | --- |
| Claude | Routine | Haiku | `claude-haiku-4-5-20251001` | No effort parameter |
| Claude | Standard | Sonnet | `claude-sonnet-5` | low, medium, high, xhigh, max |
| Claude | Complex | Opus 5.5 | `claude-opus-5-5` | low, medium, high, xhigh, max |
| Claude | Demanding | Fable | `claude-fable-5-1` | low, medium, high, xhigh, max |
| Codex | Routine | GPT-6 Luna | `gpt-6-luna` | none, low, medium, high, xhigh, max |
| Codex | Standard and complex | GPT-6 Sol | `gpt-6-sol` | none, low, medium, high, xhigh, max |
| Codex | Demanding | GPT-6 Astra | `gpt-6-astra` | low, medium, high, xhigh, max |

Previous-generation models remain in the catalog so personal policies can select them. They are not routed by default:

| Tool | Family | Provider model ID | Documented API effort values |
| --- | --- | --- | --- |
| Claude | Opus 5 | `claude-opus-5` | low, medium, high, xhigh, max |
| Codex | GPT-5.6 Luna | `gpt-5.6-luna` | none, low, medium, high, xhigh, max |
| Codex | GPT-5.6 Terra | `gpt-5.6-terra` | none, low, medium, high, xhigh, max |
| Codex | GPT-5.6 Sol | `gpt-5.6-sol` | none, low, medium, high, xhigh, max |

GPT-6 has no Terra model, so GPT-6 Sol serves both middle Codex tiers through two profiles: `codex-sol-balanced` defaults to medium reasoning when effort is uncertain, and `codex-sol` defaults to high. The built-in `codex-terra` profile keeps GPT-5.6 Terra selectable while Codex offers it.

All four tiers are active in the shipped policy. Automatic effort selection uses `low`, `medium`, `high`, `xhigh`, and `max` for the effort-capable models; Haiku gets no effort parameter. The catalog validates allowed values. It does not establish account access or cache-preserving effort changes. Invalid/unavailable classification or insufficient context uses the configured uncertain profile, which defaults to Opus 5.5/Sol at high. Low model confidence instead imposes a balanced minimum while retaining stronger proposals; see [routing policy](routing.md).

The Claude IDs and Haiku's lack of an effort parameter are from [the model overview](https://platform.claude.com/docs/en/models/overview). Effort support is from [the effort reference](https://platform.claude.com/docs/en/build-with-claude/effort). Effort interacts with thinking configuration and output limits: an allowed effort value alone does not prove the whole native request is valid. In particular, Fable and Opus 5.5 always think: neither accepts disabled thinking. The Claude adapter sends adaptive thinking with every effort value, and sends no thinking or effort fields to Haiku.

OpenAI's documented effort values come from the individual [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), and [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) model pages, and the earlier [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) pages. A setting exposed by a particular Codex app build is not automatically a supported value on every API/authentication path. For example, Codex 0.156.1 lists `low` through `max` for these models (plus `ultra` for Sol and Astra) and does not list `none`; Switchboard only sends `low` through `max`. GPT-6 Luna and Sol require a Codex build that bundles them; `switchboard doctor --fix` checks your installed Codex.

The bundled compatibility list is intentionally empty. A verified adaptive-effort entry needs evidence for the exact model, tool version, authentication path, mode, update mechanism, and continuation/resume behavior. Until such support exists, both model and effort stay fixed for the conversation. See [conversation and cache behavior](routing.md#conversation-and-cache-behavior).
