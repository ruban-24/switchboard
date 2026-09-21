# Working on Switchboard

Switchboard is a TypeScript CLI that routes Claude Code and Codex conversations.
Read [CONTRIBUTING.md](CONTRIBUTING.md) for the source map and development workflow.
Use [docs/routing.md](docs/routing.md) for architecture and policy behavior.

## Preserve these contracts

- The classifier provides semantic judgments; deterministic policy selects the route.
- A conversation keeps its model and effort through follow-ups, tool calls, and resume.
- Explicit native model choices bypass automatic routing.
- Preserve native authentication, permanent settings, sandboxing, and tool approvals.
- Never log credentials. Capture raw prompts only through the existing opt-in setting.

## Checks

Use Node.js 22.18+ on macOS or Linux. Install with `npm ci`.
Run `npm run build` before trying the CLI after a source change.
During development, run the relevant `node --test test/NAME.test.ts` and `npm run check`.
Before submitting code changes, run `npm test` and `npm run test:package`.
The package check may download public dependencies; ordinary tests need no AI keys.

Add regression coverage for meaningful behavior changes, especially routing,
privacy, saved state, and native adapters. Avoid tests for cosmetic edits or
private implementation details. Follow CONTRIBUTING.md for interactive adapter
checks; obtain explicit authorization before paid live tests.

## Scope and hygiene

Keep changes focused and update affected user documentation.
Never commit credentials, private transcripts, local agent directories, planning
files, or generated build/render output. `.env.example` is the shared template.
Describe what changed and what was verified in the PR; preserve third-party notices.
Do not publish packages, release tags, or tap updates without explicit authorization.
