# Security

Security fixes are provided for the latest published release only. Older
versions do not receive backports; update to the latest release to receive
fixes. Before the first publication, fixes target the current source branch.

## Report a vulnerability

Use **Report a vulnerability** on
[ruban-24/switchboard's Security page](https://github.com/ruban-24/switchboard/security)
to send a private report. If that option is unavailable, open an issue requesting
a private contact channel without including exploit details, keys, or private
data. There is no guaranteed response or resolution time.

Include affected versions, a minimal synthetic reproduction, and the impact.
Do not post API keys, OAuth links, native credentials, full transcripts, or
private repository content in public issues.

## Data handling

The local proxy forwards native inference to the tool's provider. Extracted task
text is also sent to the selected Jev provider for classification, even when
local raw-prompt capture is disabled. Native CLI transcripts and provider data
retention are separate from Switchboard's local history settings.

Interactive `switchboard init` saves classifier credentials in `connection.json`
beside the personal policy, with owner-only read/write permissions. The key is
plaintext, so protect that file and its backups. Environment overrides are also
supported; only the source-checkout commands load `.env.local`. Keep credentials
out of `policy.json` and Git. Classifier keys are removed from the native child
environment. The proxy binds to loopback with a per-launch secret; this is not
intended to protect against other code already running as the same local user.

Before sharing diagnostics, inspect and redact them. See [privacy and data
flow](docs/privacy.md) for recipients and storage, and the [native CLI guide](docs/native-cli.md)
for supported execution modes and current limitations.
