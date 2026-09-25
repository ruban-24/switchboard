# Contributing to Switchboard

Switchboard routes Claude Code and Codex tasks through a configurable policy.
Small fixes, reproducible routing reports, documentation, and adapter tests are
welcome. Discuss larger changes in an issue before implementing them.

## Pull requests and review

Fork the repository and open a PR against `main`. Include the problem, your
change, and the checks you ran. [AGENTS.md](AGENTS.md) is the short guide for
coding agents working on a contribution.

Ruban (`@ruban-24`) owns every path in `.github/CODEOWNERS`, including workflows
and the ownership file itself. Contributor PRs need his approval and passing CI.
The workflow checks macOS/Linux on Node 22.18 and 24, plus the animation build.
CI uses synthetic providers and does not need classifier keys. GitHub may ask
the maintainer to allow a first-time contributor's workflow run.

The [repository rule configurations](.github/rulesets) must be activated in
GitHub Settings to enforce these requirements; committing the files alone does
not enable protection. The maintainer setup is in the
[distribution guide](docs/distribution.md#github-review-and-ci-rules).

## Development

Use macOS or Linux with Node.js 22.18 or newer, Git, and Bash:

```sh
npm ci
npm run build
```

The source is TypeScript. The local CLI runs compiled files from `dist/`, so run
`npm run build` again after editing source before trying a CLI command.

During development, run the relevant test file and the typechecker:

```sh
node --test test/policy.test.ts
npm run check
```

Before submitting a code change, run the full suite and package check:

```sh
npm test
npm run test:package
```

The ordinary suite uses synthetic providers and fake credentials. It does not
need `.env.local` or make paid AI requests. The package smoke check may download
public npm dependencies. It verifies the compiled archive independently of the
source checkout.

For live work, follow the README's key setup and use synthetic tasks in an
isolated scratch directory. Launch with `npm run switchboard -- claude` or
`npm run switchboard -- codex`. Live trials consume
classifier credits and native model quota; only test models your account can
access. Never include credentials or raw private transcripts in a contribution.

## Where to make changes

| Area | Files |
| --- | --- |
| CLI commands and setup | `src/cli.ts`, `src/setup.ts`, `src/settings.ts` |
| Interactive settings and doctor fixes | `src/interactive.ts`, `src/policy-edit.ts`, `src/prompts.ts`, `src/doctor-fix.ts` |
| Classifier connections and Jev questions | `src/classifier.ts`, `src/jev.ts`, `src/jev-questions.ts`, `src/capability-question.ts` |
| Model and effort selection | `src/core/policy.ts`, `src/core/config.ts`, `src/defaults.ts` |
| Conversation pinning and saved state | `src/core/session.ts`, `src/storage.ts` |
| Native CLI launch, requests, hooks, and status | `src/native/` |
| Packaging and CI | `scripts/`, `.github/workflows/verify.yml` |

Read [how routing works](docs/routing.md) before changing selection behavior.
The [customization guide](docs/customization.md) describes the policy users can
change; [classifier connections](docs/classifiers.md) explains supported API
contracts. Most source modules have a corresponding test file under `test/`.

## Choosing tests

Add a regression test for a fixed bug or a changed behavior that could affect
routing, privacy, saved state, or a native CLI session. Prefer a test through the
relevant public boundary, with an expected result independent of the code being
tested. Reuse an existing case or table when it already exercises that path.

Documentation, wording, and cosmetic changes usually need a review of the
result, not a new automated test. Avoid assertions about private helper details
or copying the same model matrix into several files. The 36-combination test in
`test/model-aware-routing.test.ts` covers classifier answers through policy and
native request rewriting. Separate cases should cover distinct failure modes.

Keep tests deterministic and distinguish synthetic coverage from live provider
evidence. A mocked classifier verifies how Switchboard handles its answer; it
does not prove that Jev will choose that answer for a real task. Tests stay in the
source repository and are excluded from the installed npm package.

## Native adapter checks

When changing a native adapter, use the interactive CLI on a supported host.
Start a fresh conversation for each routing case; follow-ups reuse the saved
model and effort. Exercise a mechanical edit, a bounded coding task with tests,
and a harder review. Inspect `switchboard explain` for the selected route.

Within a conversation, check tool approvals and denials, cancellation followed
by a new prompt, exit and resume, and explicit native model bypass. Compare
native settings before and after, and check that temporary configuration and
active locks are cleaned up. Run Linux tool execution with its native sandbox
working; a container that blocks namespaces cannot verify that behavior.

Keep raw terminal recordings, local trial reports, ad hoc UAT workspaces and
planning documents out of the repository. Share a concise, redacted account of
what you checked in the pull request instead. Project documentation should help
users or contributors operate the current software.

## Routing animation

The README animation is authored in TypeScript with Motion Canvas. Its separate
workspace keeps animation dependencies out of the CLI package:

```sh
npm --prefix media/routing-animation ci
npm --prefix media/routing-animation run serve
```

The workspace pins patched Vite 6 and overrides Motion Canvas 3's older Vite
peer range. Its dependency-optimizer settings keep the editor and scenes on one
shared runtime. It also overrides the transitive XML parser to a patched version.
After changing these pins, check the build, open the editor, and render a video;
a successful build alone does not verify editor compatibility.

Open `http://127.0.0.1:9000/` for the editor, or
`http://127.0.0.1:9000/preview.html` to watch the exported animation. Edit
`media/routing-animation/src/scenes/routing.tsx` to change the scene. Keep its
example judgments explicitly illustrative and consistent with the routing code.

In the editor, choose **Video (FFmpeg)** and **Render**. Once rendering finishes,
generate the checked-in media and verify the source:

```sh
npm --prefix media/routing-animation run export:assets
npm --prefix media/routing-animation run check
npm --prefix media/routing-animation run build
```

The export script uses the encoder bundled with the Motion Canvas exporter to
write the MP4, GIF, and poster under `assets/`. Review playback before updating
those files. Intermediate renders in `output/` are ignored. No API keys or AI
requests are needed.

## Changes and reports

- Keep semantic classification in the classifier and policy decisions in code.
  Model and effort pinning, resume, explicit native overrides, and personal
  exclusions are existing contracts.
- For routing reports, provide a sanitized task, CLI/Node/OS versions, policy
  overrides, expected and actual selection, and redacted `switchboard explain`
  output. A selected model is not by itself evidence of answer quality.
- Follow the native adapter checks above when those paths change. Do not weaken
  native sandbox or approval settings to make a test pass.
- Update user-facing documentation when commands or behavior change. Preserve
  upstream notices for reused code.

Local skills, credentials, and `uat-scratch*/` directories are ignored. Keep
commits focused and describe what changed and how it was verified in the pull
request. Contributions are accepted under the project's Apache-2.0 license;
third-party portions retain their existing license notices.
