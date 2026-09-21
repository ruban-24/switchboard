# Switchboard installation and releases

Switchboard uses the npm package **`@ruban24/switchboard`**, the executable
**`switchboard`**, and the GitHub repository
[**ruban-24/switchboard**](https://github.com/ruban-24/switchboard).

The Homebrew command uses [ruban-24/homebrew-tap](https://github.com/ruban-24/homebrew-tap),
which also distributes `agex`. Both installation methods use the compiled npm
artifact for the selected version.

## npm and npx

```sh
npm install -g @ruban24/switchboard
switchboard init
switchboard claude
# Or: switchboard codex
```

For a trial without a global installation:

```sh
npx --package=@ruban24/switchboard switchboard init
npx --package=@ruban24/switchboard switchboard claude
```

The package identifier includes the npm scope; the command does not. Pin the
published version when reproducing a result, for example
`@ruban24/switchboard@0.1.0` for the first release.

Node.js 22.18+ and an installed, logged-in Claude Code or Codex are required.
`init` detects agents, asks which to enable, offers Jev connection presets, and
accepts an API key through hidden input. It saves `connection.json` with owner-only
permissions beside `policy.json`. The CLI reads that file on launch.

For zsh, setup suggests `$ZDOTDIR/.zshrc` or `~/.zshrc`. For bash, it suggests
both `.bashrc` and the first existing login profile (`.bash_profile`,
`.bash_login`, or `.profile`), creating `.bash_profile` if none exists. This
covers login and non-login interactive terminals. You can choose another absolute path, such as `~/.zprofile`,
or skip the change. The marked block contains only `SWITCHBOARD_HOME`; it never
contains the API key. Existing text and symlinked dotfiles are preserved.

The shell block is optional: default settings work immediately without restarting
the shell. Re-running `init` can update the connection and managed block while
preserving policy overrides. `init --yes` creates default policy without prompts;
it does not save environment keys or edit shell profiles.

Installed commands do not load project `.env` files. The source command
`npm run switchboard -- ...` loads the checkout's `.env.local` if present.
Environment values override saved connection settings. See
[classifier connections](classifiers.md) for TypeSafe, OpenRouter, Vercel, and
compatible custom endpoints.

Setup and `doctor` make no AI calls. `doctor` checks enabled agents and credential
presence, not key validity. Neither command installs or logs in to coding agents.
A real routed task consumes classifier credits and native provider quota.

## Supported platforms

| Platform | Switchboard v0.1.0 status |
| --- | --- |
| macOS | Native interactive CLI adapters verified. |
| Linux | Native interactive CLI adapters verified in a Debian 12 ARM64 VM. |
| Native Windows | Unsupported in v0; publishing through npm does not add compatibility. |
| Windows with WSL2 | A possible Linux environment, but not separately verified for this release. |

See [native CLI compatibility](native-cli.md) for tested agent versions. The
Homebrew formula uses the same release archive on macOS and Linux.

## Configuration locations

| Variable | Purpose |
| --- | --- |
| `SWITCHBOARD_HOME` | Explicit directory for personal policy, connection settings, and saved routes. |
| `XDG_CONFIG_HOME` | If absolute and `SWITCHBOARD_HOME` is unset, use `$XDG_CONFIG_HOME/switchboard`; otherwise `~/.config/switchboard`. |
| `SWITCHBOARD_STATUSLINE` | Set to `off` to disable Claude's temporary Switchboard status line. |

Provider, key, URL, and classifier model variables are listed in the
[connection guide](classifiers.md#environment-overrides). Routing choices belong
in [personal policy](customization.md). Internal `SWITCHBOARD_TOKEN` and
`SWITCHBOARD_HOOK_URL` values are generated per launch; do not set them yourself.

## Homebrew

Install from `ruban-24/homebrew-tap`:

```sh
brew install ruban-24/tap/switchboard
switchboard init
switchboard claude
```

The formula belongs at `Formula/switchboard.rb` in that separate tap. It uses
the exact compiled npm artifact and installs Node as a dependency. Choose npm or
Homebrew for the global installation to avoid two package managers competing for
the same command. npm distribution does not establish Windows compatibility.

## Upgrade or uninstall

Use the same package manager that installed Switchboard. For an npm installation:

```sh
npm install -g @ruban24/switchboard@latest
switchboard doctor
```

For Homebrew:

```sh
brew update
brew upgrade ruban-24/tap/switchboard
switchboard doctor
```

Close running Switchboard sessions before upgrading, then relaunch. Personal
policy and credentials are stored outside the package and survive an upgrade.
Saved conversations keep their existing model and effort. For an npx trial, use
`npx --package=@ruban24/switchboard@latest switchboard doctor` to select the latest
published version, or replace `latest` with a version you want to reproduce.

To uninstall, exit running sessions and use the matching command:

```sh
# npm installation:
npm uninstall -g @ruban24/switchboard

# Homebrew installation:
brew uninstall ruban-24/tap/switchboard
```

An npx trial has no global Switchboard installation to remove. Uninstallation
preserves personal state and native Claude/Codex installations and logins.
The shared Homebrew tap can stay installed for `agex` or other packages.

If you enabled shell integration, edit the profile files listed by `init` and
remove only the block from `# >>> Switchboard >>>` through
`# <<< Switchboard <<<`. Bash setup can add it to both a login profile and
`.bashrc`. Open a new shell afterward, or run `unset SWITCHBOARD_HOME` to clear
that variable in the current shell.

To remove saved data too, record the policy directory reported by `doctor`
before uninstalling. After all routed sessions have stopped, you can delete
`connection.json` to remove the saved classifier key, or remove that whole
configuration directory to delete policy, routes, and usage records as well.
Deleting routes prevents automatic resume of their conversations. This does
not revoke the provider key or remove native transcripts or backup copies;
use the provider's account controls to revoke a key you no longer need.

## Local verification

```sh
npm ci
npm test
npm run test:package
```

The package check typechecks and builds the project, packs it, checks its file
allowlist, and installs that archive under a temporary global prefix. It checks
help, initialization, and policy validation, then uses npm exec (npx's engine)
from outside the source checkout to verify the same effective policy.

Only compiled output, the executable, selected public guides, and license and
attribution files belong in the npm archive. It excludes source, tests, local
skills, credentials, and UAT scratch files. Internal plans and trial reports
belong in neither the npm archive nor the public source repository.

The check removes its temporary home, prefix, and default npm cache. Public
npm dependencies may be downloaded. `SWITCHBOARD_SMOKE_NPM_CACHE` can select an
existing cache for reuse; that cache is preserved. User npm configuration and
provider credentials are not passed to the installation commands.

The configured GitHub workflow runs the suite and package check on macOS/Linux
with Node 22.18 and 24. A configured workflow is not a successful hosted run.
Use the checks in [CONTRIBUTING.md](../CONTRIBUTING.md) on each supported
platform, including native Linux sandbox execution before claiming Linux support.

## Maintainer release sequence

1. Create the public repository from a reviewed source-only export, without the
   private development repository's `.git` directory. This gives the first public
   commit a fresh history without planning files. Keep that export outside the
   development checkout; do not reset or force-push the development repository.
2. Confirm publishing access to the npm organization `ruban24` and complete npm
   login with 2FA. Use the existing `ruban-24/homebrew-tap`; preserve its other
   formulae. The first public version is `0.1.0`.
3. Review README, this guide, the tap README, SECURITY.md, and CHANGELOG.md for
   the target release. Installation instructions describe the published package;
   verify its public availability before announcing the release. Security fixes
   cover the latest published version only, with no response-time guarantee.
   Enable and verify GitHub private vulnerability reporting when making the
   source repository public.
4. Update the version in both package files and set `private: false` only in the
   authorized release package. `publishConfig.access` is already `public`.
   An isolated local packaging candidate can be prepared without publishing it;
   keep the development checkout private until publication is authorized.
5. Complete contributor checks on the supported platforms. When the owner
   authorizes the first commit and push, use only the clean export. The repository
   can remain private while GitHub CI runs. Verify hosted CI against the final
   release commit, including any later metadata changes. Then pack the reviewed
   candidate:

   ```sh
   mkdir -p release
   npm pack --pack-destination release
   ```

6. Inspect that exact archive and generate its Homebrew formula:

   ```sh
   npm run --silent homebrew:formula -- release/ACTUAL_PACKAGE_FILE.tgz > release/switchboard.rb
   ruby -c release/switchboard.rb
   ```

   The generator uses metadata inside the tarball, its versioned npm URL, and
   the SHA-256 of its actual bytes. It rejects private/unscoped packages and
   incomplete release metadata. Run it on macOS/Linux with `tar` available.

7. After the owner authorizes publication, publish the reviewed tarball without
   repacking it:

   ```sh
   npm publish ./release/ACTUAL_PACKAGE_FILE.tgz --access public
   ```

8. Verify global npm and npx against that public version. Test the generated
   formula in the local tap using `brew install --build-from-source` and
   `brew test` on the supported platforms, then publish the tap change. Install
   once through the public tap URL too. A local-artifact test cannot verify npm
   availability, the published checksum, or a user's public tap installation.

Any change to the archive requires a new checksum and regenerated formula. Keep
local candidate formulae unpushed until their exact npm artifact is available.
Record a `v0.1.0` tag and release notes for the commit that produced the published
artifact; later fixes use a new version.

No automatic publish workflow is installed. Git commits, pushes, package
publication, and updating the Homebrew tap are separate actions from local release
preparation. Personal policy is stored outside the installation directory and
is preserved during updates.

References: [npm scopes](https://docs.npmjs.com/about-scopes/),
[public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
[npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/), and
[Homebrew Node formula guidance](https://docs.brew.sh/Language-Specific-Formulae#node).

## GitHub review and CI rules

`.github/CODEOWNERS` assigns every path to `@ruban-24`. The JSON files in
[`.github/rulesets`](../.github/rulesets) define two rulesets for `main`:

- `required-ci.json` requires all four OS/Node checks and the animation job from
  GitHub Actions. Branches must be up to date. It also blocks force-pushes and
  deletion, with no bypass actors.
- `owner-review.json` requires a PR, an approving code-owner review, and resolved
  review threads. New commits dismiss stale approvals. Ruban can bypass the
  review rule through a PR because GitHub does not allow self-approval. The
  separate CI rule still applies.

These files do not activate themselves. GitHub Free supports these rules on
public repositories; private repositories need a paid plan that includes them.
After the first CI run, confirm the check names match the JSON. Once rulesets
are available, import both files through Settings → Rules → Rulesets, or create
them with the API after checking for existing rulesets:

```sh
gh api repos/ruban-24/switchboard/rulesets
gh api --method POST -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/ruban-24/switchboard/rulesets --input .github/rulesets/required-ci.json
gh api --method POST -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/ruban-24/switchboard/rulesets --input .github/rulesets/owner-review.json
```

Update existing rulesets instead of creating duplicates. Verify both are active
before accepting contributions. Other people can leave reviews; the required
code-owner approval is Ruban's. Repository administrators can edit protection
settings, so grant repository access deliberately.

See GitHub's [ruleset guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
and [code-owner documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

## Optional release candidates

A release candidate is optional. With testing complete, publish `0.1.0` directly
using the maintainer sequence above.

For a public trial before a stable release, `0.1.0-rc.1` means the first release
candidate for `0.1.0`. Set that version in both package files, set `private: false`,
commit it, and wait for CI on that commit. Pack and inspect it using the sequence
above.
After publication is authorized, publish that exact archive under `next`:

```sh
npm publish ./release/ruban24-switchboard-0.1.0-rc.1.tgz --tag next --access public
```

Testers opt in with `npm install -g @ruban24/switchboard@next` or
`npx --package=@ruban24/switchboard@next switchboard init`. The `next` tag does
not make the package private: anyone can download a public candidate.

Generate and test a local Homebrew formula against the same candidate archive.
Keep the public `switchboard` formula for stable releases. A separate public
Homebrew candidate channel would need its own formula and conflict handling for
the shared `switchboard` executable; it is not configured here.

For stable release, change the version to `0.1.0`, rerun CI, and create a new
archive and checksum. Publish that archive with `--tag latest`, update the tap,
and create the GitHub release from the matching commit and CHANGELOG.md entry.
An npm version's contents are immutable; a tag change cannot turn `rc.1` into
`0.1.0`. Use a new candidate version for fixes after publication.
