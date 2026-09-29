# Android developer-verification readiness

**Status (2026-09-29): Google Play distribution is planned.** This supersedes
the earlier note that Play was optional/not planned.

## Package identity

- Android application ID: `app.cutlyra.editor`.
- Keep it stable once the Play app is created.
- Play package registration/identity verification is a human account action.

## Signing model

Use Play App Signing. For the Play channel, the developer-owned keystore used
to sign the uploaded AAB is the **upload key**; Google Play manages the app
signing key used for Play-delivered APKs.

Gradle signing variables remain:
- `CUTLYRA_RELEASE_KEYSTORE`
- `CUTLYRA_RELEASE_KEYSTORE_PASSWORD`
- `CUTLYRA_RELEASE_KEY_ALIAS`
- `CUTLYRA_RELEASE_KEY_PASSWORD`

GitHub Actions maps encrypted repository secrets to those variables. Never
commit secret material.

The Play artifact is built by `.github/workflows/play-bundle.yml` with
`./gradlew bundleRelease`.

Direct APK signing remains a separate compatibility concern. Do not assume a
direct APK and a Play-delivered APK are update-compatible unless their effective
app-signing identity matches.

## Human-only verification

Automation must not impersonate the publisher, submit identity documents or
device verification, accept legal agreements, pay fees, invent a contact email,
or expose production signing secrets.

See `docs/PLAY_STORE_RELEASE.md`.
