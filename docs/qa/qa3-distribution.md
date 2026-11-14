# QA3 — the permanently updatable test build

QA3 exists because QA2 could not be updated in place. Every QA2 build was
signed with a throwaway CI debug certificate, so each new APK was a
signature-mismatched update of the installed one and Android refused it.
QA3 fixes this by giving the test build **its own long-lived signing
identity**, independent of both the debug key and the production release key.

| | production | historical QA | QA2 (installed acceptance) | QA3 (this document) |
|---|---|---|---|---|
| package | `app.cutlyra.editor` | `app.cutlyra.editor.qa` | `app.cutlyra.editor.qa2` | `app.cutlyra.editor.qa3` |
| build type | `release` / `debug` | legacy | `qa` | `qa3` |
| signer | release key | legacy debug key | ephemeral CI debug key | **QA3 key, stable forever** |
| updatable in place | yes | no | no | **yes** |

QA3 changes nothing about the other three identities: their build types,
signing and package names are untouched, and QA3's app-private storage, media
paths and FileProvider authority (`app.cutlyra.editor.qa3.fileprovider`) are
all distinct, so the four applications coexist with no shared state.

## One-time owner setup (outside any agent session)

Run this on your own machine. The keystore file and its passwords must never
enter the repository, a CI log, or a chat transcript.

```bash
keytool -genkeypair \
  -keystore cutlyra-qa3.jks \
  -alias cutlyra-qa3 \
  -keyalg RSA -keysize 4096 -validity 36500 \
  -storetype PKCS12 \
  -dname "CN=Cutlyra QA3, O=Cutlyra, C=IN"
```

Back up `cutlyra-qa3.jks` **outside the repository** (encrypted archive,
password manager attachment, offline copy). Losing it means the installed QA3
can never be updated again — only uninstalled and replaced.

Then publish five values:

| GitHub setting | Kind | Value |
|---|---|---|
| `CUTLYRA_QA3_KEYSTORE_BASE64` | secret | `base64 -w0 cutlyra-qa3.jks` (single line) |
| `CUTLYRA_QA3_KEYSTORE_PASSWORD` | secret | the store password |
| `CUTLYRA_QA3_KEY_ALIAS` | secret | `cutlyra-qa3` |
| `CUTLYRA_QA3_KEY_PASSWORD` | secret | the key password |
| `CUTLYRA_QA3_CERT_SHA256` | **variable** (not secret) | signer certificate SHA-256, see below |

The certificate digest is public verification metadata, so it is pinned as a
variable: the workflow compares the APK's actual signer against it and fails on
any mismatch.

```bash
keytool -list -v -keystore cutlyra-qa3.jks -alias cutlyra-qa3 \
  | grep 'SHA256:' | head -1
```

Record the same digest in this file once the keystore exists, so the expected
identity is documented next to the process:

```
QA3 signer certificate SHA-256: (fill in after generating the keystore)
```

## Producing an APK

1. Mobile CI must be green on the commit you intend to test.
2. Actions → **QA3 signed APK** → *Run workflow* **on `main`**. There is no
   ref input: the workflow signs the commit it was dispatched on and refuses
   anything that is not `refs/heads/main`.
   Because the job uses the `qa3-signing` environment, dispatch may pause
   for a required reviewer's approval before the keystore is decoded; an
   account that dispatched the run cannot approve it when self-review is
   prevented.
3. Before the keystore is decoded, the job re-checks provenance: the SHA that
   `git rev-parse HEAD` actually produced (not a value passed in) must be an
   ancestor of `origin/main`, and **both** Bun CI and Mobile CI must be
   `completed/success` on that exact SHA. Anything else stops the run.
4. The job **fails** if any secret is missing or the signer digest does not
   match — it never falls back to a debug signature.
5. Download the `cutlyra-qa3-apk` artifact. It contains the APK, its SHA-256
   (`qa3-apk.sha256`) and the signer certificate (`qa3-signer.txt`).

The workflow also boots an API-35 emulator and runs
`scripts/ci/qa3-emulator-smoke.sh` as a single command (the emulator action
pipes each line through its own shell, so state and `set -e` cannot be carried
inline). That script installs the exact artifact and fails non-zero unless it
can prove: the package id, its own app-private data directory, its own
FileProvider authority, a launch of `FirstRunActivity`, a live process 20 s
later, no `FATAL EXCEPTION` for the package, and the expected resumed activity.

## Installing on the phone

Verify both digests before installing:

```bash
sha256sum cutlyra-qa3.apk                       # must equal qa3-apk.sha256
apksigner verify --print-certs cutlyra-qa3.apk  # must equal QA3 signer SHA-256
adb devices
adb install -r cutlyra-qa3.apk
adb shell pm list packages | grep cutlyra       # four packages, all present
```

`-r` is a plain update of QA3 and never touches the other three installs.

## Trusted-workflow rule

`qa3-apk.yml` runs only on `workflow_dispatch`, only on `main`, and only for a
commit whose Bun CI and Mobile CI runs already succeeded. It must never gain a
`pull_request` trigger or an arbitrary ref input: a modified Gradle script in a
pull request could otherwise read the signing key. PR CI builds QA3
**unsigned** and asserts, with the same verification script in its `unsigned`
mode, that it has no signature at all.

## GitHub Actions environment setup (`qa3-signing`)

The four QA3 secrets and the public certificate digest are scoped to a
protected GitHub Actions environment named `qa3-signing`. The workflow job
`qa3-signed-apk` declares `environment: qa3-signing`, so dispatching it
requires satisfying every protection rule on that environment before the
keystore is ever decoded.

Configure the environment once, as the repository owner, in
**Settings → Environments → qa3-signing**:

1. **Deployment branches** — restrict to `main` only. No other branch,
   tag or arbitrary ref may deploy. This mirrors the workflow's own
   `refs/heads/main` refusal and is the environment-level lock.
2. **Required reviewers** — add at least one reviewer. Enable the toggle
   only if a second account (or a separate approver) is actually
   available: when **"Prevent self-review"** is on, the account that
   dispatched the run **cannot** approve its own deployment. If only the
   owner account exists, either leave self-review disabled or arrange a
   second reviewer account before relying on approval. Never assume
   self-approval works.
3. **Wait timer** — optional; if set, it adds a mandatory delay before
   the secrets are exposed.
4. **Secrets** (four, environment-scoped, never repository-scoped once
   this is configured):
   - `CUTLYRA_QA3_KEYSTORE_BASE64`
   - `CUTLYRA_QA3_KEYSTORE_PASSWORD`
   - `CUTLYRA_QA3_KEY_ALIAS`
   - `CUTLYRA_QA3_KEY_PASSWORD`
5. **Variables** (one, public verification metadata, NOT a secret):
   - `CUTLYRA_QA3_CERT_SHA256` — the pinned signer certificate SHA-256.

Repository secret names stay the same; only their scope changes from the
repository to the environment. The workflow reads them through the same
`secrets.*` / `vars.*` names, so no code change is needed beyond
`environment: qa3-signing`.

## Protect `main` with repository rules

Apply these repository rules so the source the environment signs cannot be
mutated without review, even by an account that holds the signing secrets:

- Require pull requests before merging to `main` (no direct pushes).
- Require the full seven-job CI matrix to pass: Bun CI's three
  `invariants` jobs plus Mobile CI's `iOS (simulator, unsigned)`,
  `Android (debug APK)`, `Android instrumentation (API 35 emulator)` and
  `Android instrumentation (R8 test variant)`.
- Require the `qa3-apk.yml` workflow's provenance checks (qualified SHA,
  Bun CI + Mobile CI `completed/success`) to pass before any signed
  artifact is produced — these run inside the job, not as branch
  protection, but the branch rules guarantee the inputs they inspect are
  the reviewed commit.
- Restrict who can push to / approve changes touching
  `.github/workflows/qa3-apk.yml`, `apps/mobile/android/app/build.gradle`
  and the signing-related Gradle configuration.
- Do not allow force-push or branch deletion on `main`.

Dispatch then needs a human approval before the key is ever decoded, which
is a second lock independent of this file.

## Signing stability check

Two builds from the same keystore must print the same
`Signer #1 certificate SHA-256 digest`. Confirm it on the first two artifacts
and after any change to the workflow or Gradle signing block; record the digest
here each time it is re-confirmed.
