# Privacy and data flow

Switchboard runs a local routing proxy. It has no Switchboard account, analytics
endpoint, or hosted service receiving prompts. Its source is licensed under
Apache-2.0 so you can inspect the routing and forwarding behavior yourself.

The current classifier is hosted. Running the proxy locally does not make
classification offline or keep all task text on your machine.

## What leaves your machine

| Recipient | Data and purpose |
| --- | --- |
| TypeSafe, using your direct API key | Extracted user task text and routing questions for Jev classification |
| OpenRouter, if selected | The classification payload, sent through its TypeSafe-compatible endpoint to Jev |
| Your custom classifier endpoint, if configured | The classification payload and key for the selected adapter |
| Vercel AI Gateway, if selected | The same classification payload, sent through the Gateway to Jev |
| Your native coding provider | Native inference requests, including the conversation and tool context the coding CLI sends |

Switchboard's classifier input contains task text, bounded to 16,000 characters
by default, and policy-derived questions about capability and effort. The
classifier adapter does not scan your repository or upload the full native
transcript. The local proxy does handle the native request as it forwards it.
Content embedded in the user task can include private code, filenames, or
secrets. Switchboard does not automatically redact that text before
classification.

Your selected provider's terms, logging, and retention rules apply to its
requests. Switchboard makes no claim of zero retention by TypeSafe, OpenRouter, Vercel,
Anthropic, or OpenAI. Disabling local prompt history does not disable hosted
classification. A fully local classifier is not included in v0.

## What is stored locally

Personal policy and routing state normally live under
`~/.config/switchboard`. An absolute `XDG_CONFIG_HOME` or an explicit
`SWITCHBOARD_HOME` changes the location; `switchboard doctor` reports it.

- `policy.json` holds your overrides, not credentials. Settings changes made by
  `switchboard config` or `doctor` keep the previous file as `policy.json.bak`.
- `doctor-state.json` records a confirmed answer to doctor's Claude plan
  question (the model ID you chose to keep) so it is not asked again.
- `connection.json` holds the provider, optional URL/model, and API key saved by
  interactive setup. Its permissions allow only your user to read or write it.
  The key is stored as plaintext, not encrypted; protect filesystem backups.
- `sessions/` holds the saved model/effort, conversation and turn identifiers,
  timestamps, policy reasons, classifications, and recommendations. History is
  bounded to 20 decisions per conversation by default.
- `usage/` holds the latest normalized cache/input/output counters attributable
  to an automatic conversation. It is not a complete usage ledger.
- `native-locks/` tracks ownership of active conversations to prevent two router
  processes from conflicting.

Raw prompt capture is off by default. To explicitly opt in locally:

```json
{
  "history": { "limit": 20, "capturePrompts": true }
}
```

Captured task text is bounded by the classifier context limit. It can contain
sensitive information. `explain` does not print captured prompts. Setting
`capturePrompts` back to `false` prevents new capture; old files are not all
rewritten at once. Do not assume this setting immediately deletes existing
copies or backups.

Setting `history.limit` to `0` prevents retaining a decision history on subsequent
writes, but the active selection and last decision are still saved for resume.
There is no automatic global age-based cleanup. Stop active sessions before
manually cleaning local state, and retain routes for conversations you intend
to resume: deleting them prevents automatic resume from recovering its selection.

Native Claude Code/Codex transcripts are separate. Codex's routing notice is
also saved in its native transcript. Native tools and your filesystem backups
can therefore retain data independently of Switchboard's history settings.

## Credentials and transport

Classifier credentials come from the saved connection or the launching
environment. Environment settings take precedence. The source-checkout script
loads `.env.local` if present; the installed binary does not search project
directories for environment files. Setup can add a marked shell-profile block
that selects the configuration directory; it contains no credential. Keep credentials out of
`policy.json`, screenshots, Git, and issue reports.

The proxy binds to loopback and uses a per-launch secret. Classifier keys are
removed from the child CLI's environment; native provider credentials are kept
for native authentication. Temporary native settings are private and removed on
normal process exit. Routing state files are written with owner-only permissions.
These measures do not protect against other software already running as the
same user or against a compromised machine.

## Cost and control

Switchboard itself is free software. Hosted classifier requests can incur API
charges, and coding-model usage remains subject to your provider's subscription
or API pricing. Switchboard does not charge a routing fee or proxy that billing
through its own account.

You can audit or modify the source, use your own keys, exclude models, cap effort,
and choose an explicit native model to bypass automatic classification. For
vulnerability reporting, see [SECURITY.md](../SECURITY.md).
