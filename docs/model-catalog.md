# Model capability snapshot

Checked against the provider documentation on 2026-09-18. These are API model IDs and documented effort values. Availability depends on your account, installed native CLI, and authentication path. Exclude models your plan cannot use. Nothing here establishes cache preservation.

| Tool | Tier | Family | Provider model ID | Documented API effort values |
| --- | --- | --- | --- | --- |
| Claude | Routine | Haiku | `claude-haiku-4-5-20251001` | No effort parameter |
| Claude | Standard | Sonnet | `claude-sonnet-5` | low, medium, high, xhigh, max |
| Claude | Complex | Opus | `claude-opus-5` | low, medium, high, xhigh, max |
| Claude | Demanding | Fable | `claude-fable-5-1` | low, medium, high, xhigh, max |
| Codex | Routine | GPT-5.6 Luna | `gpt-5.6-luna` | none, low, medium, high, xhigh, max |
| Codex | Standard | GPT-5.6 Terra | `gpt-5.6-terra` | none, low, medium, high, xhigh, max |
| Codex | Complex | GPT-5.6 Sol | `gpt-5.6-sol` | none, low, medium, high, xhigh, max |
| Codex | Demanding | GPT-6 Astra | `gpt-6-astra` | low, medium, high, xhigh, max |

All four tiers are active in the shipped policy. Automatic effort selection uses `low`, `medium`, `high`, `xhigh`, and `max` for the seven effort-capable models; Haiku gets no effort parameter. The catalog validates allowed values. It does not establish account access or cache-preserving effort changes. Invalid/unavailable classification or insufficient context uses the configured uncertain profile, which defaults to Opus/Sol at high. Low model confidence instead imposes a balanced minimum while retaining stronger proposals; see [routing policy](routing.md).

The Claude IDs and Haiku's lack of an effort parameter are from [the model overview](https://platform.claude.com/docs/en/models/overview). Effort support is from [the effort reference](https://platform.claude.com/docs/en/build-with-claude/effort). Effort interacts with thinking configuration and output limits: an allowed effort value alone does not prove the whole native request is valid. In particular, the adapter must handle Fable's always-on thinking and Opus constraints at xhigh/max.

OpenAI's documented effort values come from the individual [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), and [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) model pages. A setting exposed by a particular Codex app build is not automatically a supported value on every API/authentication path.

The bundled compatibility list is intentionally empty. A verified adaptive-effort entry needs evidence for the exact model, tool version, authentication path, mode, update mechanism, and continuation/resume behavior. Until such support exists, both model and effort stay fixed for the conversation. See [conversation and cache behavior](routing.md#conversation-and-cache-behavior).
