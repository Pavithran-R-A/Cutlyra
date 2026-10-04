# Contributing to Cutlyra

Thanks for helping improve Cutlyra. The v0.1 line is a **local-first mobile
editor**, so changes must preserve the product's offline/privacy guarantees and
the native/web engine boundaries already enforced by CI.

## Development setup

Prerequisites for the TypeScript/Rust checks:

- Bun 1.3.14
- Rust + the `wasm32-unknown-unknown` target when touching the compositor/WASM
- Git

For Android work also install JDK 21, Android SDK platform 36/build-tools 36,
NDK 27.2.12479018, and CMake 3.22.1.

From the repository root:

```sh
bun install
bash scripts/invariants.sh
```

The invariants script is the merge gate. It builds the web harness, typechecks
the app/packages, enforces the headless-engine and shell-bridge boundaries,
runs lint and unit tests, performs the offline-network audit, and checks input
event invariants.

For Android:

```sh
cd apps/mobile
bun run build
bunx cap sync android
cd android
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

For iOS simulator setup, see `apps/mobile/README.md`.

## Product invariants

- Do not add analytics, advertising, telemetry, account/cloud dependencies, or
  required network calls to the editing/export path without an explicit product
  decision and corresponding privacy-policy change.
- Do not import Capacitor/Tauri APIs directly into editor/UI packages; platform
  access goes through `packages/native-bridge`.
- Keep user media in app-private/local storage unless the user explicitly
  exports or shares it.
- Do not weaken release signing, permission minimization, 16 KB native-library
  compatibility, or the release asset-pruning checks.
- Bug fixes should include a regression test whenever the behavior is testable.

## Pull requests

Keep each PR focused, explain the user-visible impact, and state exactly which
checks you ran. CI must be green before merge. Never commit keystores,
passwords, tokens, generated signing material, or private user media.

For security reports, follow [SECURITY.md](../SECURITY.md) instead of opening a
public issue.
