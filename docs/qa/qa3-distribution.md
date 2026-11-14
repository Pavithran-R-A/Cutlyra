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
2. Actions → **QA3 signed APK** → *Run workflow* with `ref` set to that commit.
3. The job **fails** if any secret is missing or the signer digest does not
   match — it never falls back to a debug signature.
4. Download the `cutlyra-qa3-apk` artifact. It contains the APK, its SHA-256
   (`qa3-apk.sha256`) and the signer certificate (`qa3-signer.txt`).

The workflow also boots an API-35 emulator, installs the exact artifact,
confirms the process starts and survives 20 seconds, that the activity is
resumed, that no `FATAL EXCEPTION` mentions the QA3 package, and that its
app-private data directory exists.

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

`qa3-apk.yml` runs only on `workflow_dispatch`. It must never gain a
`pull_request` trigger and its secrets must never be exposed to PR code: a
modified Gradle script in a pull request could otherwise read the signing key.
PR CI builds QA3 **unsigned** and asserts that it has no signature at all.

## Signing stability check

Two builds from the same keystore must print the same
`Signer #1 certificate SHA-256 digest`. Confirm it on the first two artifacts
and after any change to the workflow or Gradle signing block; record the digest
here each time it is re-confirmed.
