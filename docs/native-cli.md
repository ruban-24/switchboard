# Native CLI integration

Interactive integration was verified with Claude Code 2.1.278 and Codex 0.155.1
on macOS and Debian 12 ARM64 with native sandboxing. CLI updates can change
hook, request, or model-catalog behavior; these are tested versions, not a
guarantee of compatibility with every version.

Automatic launch binds a secret-protected proxy to loopback for that process.
Claude receives a private temporary settings file containing `UserPromptSubmit`
and `SessionStart` command hooks. Switchboard reads any explicit `--settings`
object or file and merges its existing hooks into the generated settings.
On normal exit, it deletes only its own temporary directory. Your original
settings files are preserved.

The bundled helper runs through the same Node executable as Switchboard, reads
event JSON from stdin, and sends it only to the authenticated local proxy. It
adds no model context and grants no network permissions. Claude runs command
hooks outside its Bash sandbox; normal coding tools retain their existing
sandbox and permission settings. Missing, unreadable, malformed, or empty
explicit settings stop automatic launch; absent optional user/project settings
are allowed.

Codex receives process-scoped provider configuration and a private temporary
model catalog. The catalog is removed on normal exit. Neither launcher writes
permanent native settings. Native argument boundaries, inherited terminal
streams, and exit status are preserved.

Claude session events distinguish a fresh conversation from resume or compaction. Prompt events are matched against request text after removing system reminders; tool results and auxiliary requests do not start a new route. A confirmed fresh session can use request content if its prompt event is missing. Once a route is saved, subsequent requests reuse that model and effort even when a prompt event cannot be matched. Resuming without a saved route fails with recovery guidance. A helper delivery failure blocks prompt submission with a local error instead of silently treating an unidentified request as a new task. Disabled or managed-only hooks remain unsupported; Switchboard does not override those restrictions.

Automatic Claude launch rejects `settings.env` overrides of `ANTHROPIC_MODEL`,
`SWITCHBOARD_TOKEN`, or `SWITCHBOARD_HOOK_URL` in user, project, and explicit
settings. These values belong to the current router process; overriding them
could bypass routing or misdirect hook delivery. Remove those entries to use
automatic routing, or select an explicit `--model` to run natively. Switchboard
does not edit the conflicting settings file.

Codex automatic routing requires `codex debug models --bundled` and custom effort labels. The launcher reads that installed catalog without a network refresh, adds an automatic entry with shared capability limits, and retains the concrete model entries. Missing eligible model metadata or incompatible tool protocols stop launch with an explanation. The router uses the first eligible tier's native instruction template; this is a shared coding baseline, not each routed model's individually optimized native configuration.

Claude's model label shows `switchboard`. The Codex header/footer shows `switchboard auto`, and its model picker shows `switchboard`. These identify router control, not the selected provider model. A `[Router]` commentary line in Codex shows the actual model, effort, and reason for each user turn, including conservative fallbacks and pinned routes. This local notice is saved in Codex's transcript. The chosen model and effort remain pinned across tool calls and resume.

A conversation ownership collision returns a recovery message and leaves its lock intact. Stop the previous router process; remove a stale lock only after verifying that its owner is no longer running. Locks are never removed automatically on collision.

Explicit `--model`/`-m`, explicit effort, help/version, login and other administrative commands bypass routing and do not require Jev. Claude `--bare`, `--safe-mode`, background/cloud/remote-control modes, Bedrock/Vertex/Foundry selectors, disabled hooks, Codex remote/background modes, named profiles, and custom endpoints/providers are unsupported in automatic mode; select an explicit native model to bypass when appropriate. Claude may still log an unknown-model diagnostic for the automatic alias; inference uses the concrete routed model.

## Claude status line

Automatic launch adds a temporary status command. It runs the effective existing
status command with the same stdin JSON and working directory, preserves its
output, and appends a Switchboard line beneath it. The wrapper respects user,
project, local, and explicit settings precedence and `--setting-sources`.
Local settings in Git repositories follow Claude 2.1.211+ behavior: starting-directory
local settings load before repository-root local settings; linked worktrees use
the main checkout root. This lookup requires Git on PATH. Your permanent Claude
settings are unchanged.

The line shows the saved model, effort, and route state. Before the first task it
shows that routing is waiting. Fallbacks are identified; a native manual model
choice is shown as manual rather than attributed to the saved automatic route.
No classifier call is made to draw the line. Updates follow Claude's status-line
refreshes.

The existing command has a one-second timeout and a 64 KiB output limit. If it
fails or exceeds a limit, the wrapper keeps output received so far and still
prints the Switchboard line.
Commands that take longer may need to be optimized or run without the wrapper.
Set `SWITCHBOARD_STATUSLINE=off` before launching to opt out. Native explicit-model
launches bypass the wrapper entirely.

The public executable and automatic model alias are both `switchboard`. Personal
state defaults to `~/.config/switchboard`. The release does not install aliases
for development prototypes or migrate their conversations.

## Find a conversation and resume it

`switchboard explain TOOL CONVERSATION_ID` takes the native session UUID. It does
not take a conversation title or the hashed filename in Switchboard's store.
To find a saved ID, run `switchboard doctor` and open the `sessions/` directory
beside the reported `policy.json`. Each JSON file contains `tool`,
`conversationId`, and `lastDecision.at`; use those fields to identify the session.
The files can contain task text if you enabled prompt capture, so keep them local.

After leaving the active CLI, inspect or resume a specific conversation:

```sh
switchboard explain claude CONVERSATION_ID
switchboard claude --resume CONVERSATION_ID

switchboard explain codex CONVERSATION_ID
switchboard codex resume CONVERSATION_ID
```

To choose from the native session picker, run `switchboard claude --resume` or
`switchboard codex resume`. Open the same project directory first. Resume a
conversation originally started through Switchboard, using the same configuration
directory: both the native transcript and Switchboard's saved route are needed.
An ordinary native session has no automatic route to recover. Start a new
Switchboard conversation or continue that session with an explicit native model.

From the source checkout, replace `switchboard` with `npm run switchboard --`.
For example, `npm run switchboard -- codex resume CONVERSATION_ID`.

## Troubleshooting

If Claude reports "Usage credits are required for this model" on a new
conversation, your plan cannot use the routed model (usually Fable) without
usage credits. Run `switchboard doctor --fix` to route the highest Claude tier
to Opus 5.5, then start a new conversation.

Start with `switchboard doctor` and `switchboard config check`. Neither makes an
AI request. `doctor` checks that a key is present, not whether it works or has
credits. Use `explain` to distinguish a classifier fallback from a native provider
error; Switchboard does not retry failed coding inference on another model.

| Symptom | What to check and how to recover |
| --- | --- |
| `claude` or `codex` is not found | Install and sign in to the agent using the [Claude](https://code.claude.com/docs/en/quickstart) or [Codex](https://developers.openai.com/codex/cli) guide. Check `command -v claude` or `command -v codex` in the same terminal. Enable only installed agents in personal policy. |
| Missing classifier key at launch | Run `switchboard init` to save a connection. Remove conflicting environment overrides if setup reports them. Installed commands do not load a project's `.env.local`. |
| `classifier-unavailable` or repeated conservative fallback | Check the selected classifier provider, model ID, key, quota, and endpoint contract. A timeout or invalid required answer also causes fallback. From a source checkout, `npm run check:jev` makes one paid diagnostic request; see [connection checks](classifiers.md#check-a-connection). |
| A classifier diagnostic reports HTTP 401/403 or 429 | For 401/403, verify the key and provider access. For 429, check that provider's rate limits and credit balance; adding credit does not fix every rate limit. These classifier credentials are separate from your Claude/Codex login. |
| The coding provider rejects the selected model | Confirm that your native account can use it. Add unavailable model IDs to `excludedModels`, validate, relaunch, and start a new conversation. Exclusions do not change a saved route. |
| Codex cannot find eligible model metadata | Update Codex and check the [tested version](#native-cli-integration). If necessary, exclude the unavailable model through policy. Automatic launch requires metadata for every eligible model. |
| Claude reports missing hooks or a hook delivery failure | Launch through `switchboard claude` with hooks enabled. Remove incompatible automatic-mode flags such as `--bare`; check the settings conflicts described above. If your organization requires disabled or managed-only hooks, use a native explicit-model session. |
| Resume reports no saved route | Check `SWITCHBOARD_HOME` and the native session UUID. Resume through the configuration directory that created the route. If its route is gone, restore it from your own backup or start a new conversation; a native transcript alone cannot reconstruct it. |
| A conversation is already owned by another router | Exit the other session first. Remove a stale lock only after verifying its owner has stopped. Do not delete active locks to force a second process into the same conversation. |
| A policy edit or repaired classifier connection has no effect | Relaunch and start a new conversation. Model and effort, including a fallback selected earlier, remain pinned during follow-ups and resume. Check environment overrides and any explicit native model choice too. |

If the issue remains, report the OS, Node and native CLI versions, a synthetic
task, and redacted `switchboard explain` output. Do not attach `connection.json`,
API keys, or private transcripts. See [contributor guidance](../CONTRIBUTING.md).
