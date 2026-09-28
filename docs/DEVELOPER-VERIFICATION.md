# Android developer-verification readiness (informational)

**Status: informational only. Nothing in this document is done, registered,
or submitted. Cutlyra is currently distributed as source and debug APKs.**

Android's developer-verification ecosystem is changing through 2026–2027
(Google's announced move toward verified developer identities for apps
distributed outside Play, alongside the existing Play signing/identity
requirements). This note records what Cutlyra will eventually need so a
maintainer can plan for it — it is **not** a task list an agent should
execute, because every item requires a real human identity, a real
account decision, or money, and none of it may be fabricated.

## What Cutlyra will eventually need

### 1. Package-name ownership (already satisfied in code)

- The application ID is `app.cutlyra.editor`
  (`apps/mobile/android/app/build.gradle`). It is a normal,
  org-controlled reverse-domain style ID.
- Ownership of the `cutlyra` domain/namespace is what makes this ID
  *defensible*. Whatever entity publishes Cutlyra should control
  `cutlyra.<tld>` (or be prepared to prove the ID's provenance another
  way) before relying on it publicly. **Action: maintainer decision,
  outside any agent session.**

### 2. Signing-certificate ownership (deliberately not yet created)

- No release keystore exists in this repository, and none may be created
  by automation — the signing identity is the app's permanent public
  identity, and creating it is a one-time human decision (see
  `docs/RELEASING.md` §1: `keytool`, strong passwords, durable backup).
- Everything *around* the key is already wired: the release build
  consumes `CUTLYRA_RELEASE_KEYSTORE{,_PASSWORD}` and
  `CUTLYRA_RELEASE_KEY_{ALIAS,PASSWORD}` from the environment, CI
  decodes the keystore from repo secrets on tag pushes, and builds
  without credentials fall back to a clearly-labeled unsigned APK.
- When direct-download distribution becomes subject to
  developer-verification rules, the same certificate will be the thing
  registered; rotating it later is treated as a different app by
  Android. **Action: human, once, with backup discipline.**

### 3. Direct-download distribution

- Current posture: GitHub Releases with a signed APK + `SHA256SUMS.txt`
  (`.github/workflows/release.yml`). No store, no fees.
- If/when sideload verification regimes arrive (verified-install
  prompts, developer identity checks at install time), the maintainer
  will need: the verified developer account, the signing certificate
  registered with it, and release notes/checksums kept consistent — the
  workflow already produces all of the artifacts such a flow would ask
  for. No code change is anticipated.

### 4. Google Play distribution (optional, not planned for v0.1.0)

- Play is not a v0.1.0 requirement (direct distribution is the chosen
  channel). If it is ever chosen, the additional pieces would be:
  - a Play developer account (identity + fee) — human,
  - an **AAB** (`./gradlew bundleRelease` — the project builds APKs
    today; adding AAB output is a one-line gradle addition when needed),
  - Play App Signing enrollment (Google holds the actual app signing
    key; the upload key would be Cutlyra's own release keystore),
  - Play data-safety declarations — Cutlyra's honest answers are
    favorable: **no data collected, no data shared, everything
    on-device** (`allowBackup` is off; the offline audit enforces no
    network paths).
- None of this blocks source/release engineering, and none of it is
  done.

## What an agent must never do here

- Register any account, submit any identity document, or pay any fee.
- Generate a "real" release keystore or invent keystore passwords.
- Put any secret material in the repository.

See `docs/RELEASING.md` for the exact human steps when the time comes.
