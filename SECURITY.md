# Security Policy

## Supported versions

Cutlyra is a young project. Security fixes land on the latest release tag
only.

## Reporting a vulnerability

Please open a private security advisory via GitHub ("Security" →
"Report a vulnerability") on this repository, or contact the maintainers
through the repository's contact channel. Include:

- affected version/commit,
- a description of the issue and its impact,
- reproduction steps or a proof of concept if available.

Please do not open a public issue for an unpatched vulnerability.

## Scope notes

Cutlyra is a fully offline editor: it performs no network requests for any
editing, captioning, or export functionality, and never uploads user media
anywhere. `scripts/offline-audit.sh` (run in CI on every push) enforces
this at the source and bundle level. Any report of outbound network
traffic from the app is in scope and taken seriously.

Third-party dependencies are inventoried in `docs/THIRD_PARTY_NOTICES.md`
with their licenses; dependency updates flow through the usual PR process.
