# Releasing Cutlyra

> **Distribution decision updated 2026-09-29:** Google Play is now a planned
> Android release channel. This file documents the direct Android APK release
> workflow; Play's source of truth is [PLAY_STORE_RELEASE.md](PLAY_STORE_RELEASE.md).
> Older "no Play Store" wording below is historical context, not current policy.
>
Cutlyra's Android release plan supports **Google Play plus optional direct
APK distribution**. The older no-store decision is retained only as historical
context in `docs/DECISIONS.md`; the current Play source of truth is
[PLAY_STORE_RELEASE.md](PLAY_STORE_RELEASE.md). Direct releases are GitHub
Releases attached to a `v*.*.*` tag and built by
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

- **Android:** a signed release APK, installable directly (sideload), plus
  native debug symbols and checksums.
- **iOS:** source/simulator health is maintained, but iOS is not a validated
  v0.1.0 shipping target and no iOS binary is published in the GitHub release.
  The source-build guide remains development documentation only.

This document covers (1) the one-time Android keystore setup a human
does locally, outside of any agent session, and (2) how to cut a
release once that's done. **Nothing in this document or in the release
workflow generates, stores, or embeds secret material in the repo.**
The keystore lives only in your local machine and in GitHub's encrypted
repo secrets store.

---

## 1. One-time setup: the Android release keystore

Do this once, on your own machine, **not** inside an agent session (the
project's engineering rules explicitly keep agent sessions away from
real signing — see the top-level directives this plan operates under).

### 1a. Generate a keystore

```sh
keytool -genkeypair \
  -v \
  -storetype PKCS12 \
  -keystore cutlyra-release.keystore \
  -alias cutlyra \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

`keytool` will prompt for a store password, a key password, and your
name/org details (these become the certificate's DN — they can be
anything; they are not user-facing). **Write the store password and key
password down somewhere durable** (a password manager) — if the
keystore or its passwords are ever lost, every future release becomes a
*new, different signing identity*, and Android treats an update signed
with a different key as a different app (users would have to uninstall
and reinstall to get updates). Back up `cutlyra-release.keystore`
itself the same way.

### 1b. Base64-encode it, for the repo secret

```sh
base64 -i cutlyra-release.keystore | tr -d '\n' > cutlyra-release.keystore.b64
```

### 1c. Add four repo secrets for direct GitHub APK releases

Using the [`gh` CLI](https://cli.github.com/) (or the GitHub web UI
under **Settings → Secrets and variables → Actions**):

```sh
gh secret set ANDROID_RELEASE_KEYSTORE_BASE64   --repo Pavithran-R-A/Cutlyra < cutlyra-release.keystore.b64
gh secret set ANDROID_RELEASE_KEYSTORE_PASSWORD --repo Pavithran-R-A/Cutlyra   # paste when prompted
gh secret set ANDROID_RELEASE_KEY_ALIAS         --repo Pavithran-R-A/Cutlyra   # "cutlyra", if you used the command above
gh secret set ANDROID_RELEASE_KEY_PASSWORD      --repo Pavithran-R-A/Cutlyra   # paste when prompted
```

These `ANDROID_RELEASE_*` secrets are for the GitHub/direct-distribution
APK signing identity only. Google Play's AAB upload uses a separate upload
key and separate `PLAY_UPLOAD_*` secrets; see `PLAY_STORE_RELEASE.md`.

Then **delete the local `.keystore.b64` file** (keep only the raw
`.keystore` file, backed up privately — the base64 copy has no purpose
once it's in the secret store):

```sh
rm cutlyra-release.keystore.b64
```

### 1e. What the workflow does with these

`.github/workflows/release.yml`'s `android-release` job decodes
`ANDROID_RELEASE_KEYSTORE_BASE64` back to a file at runtime, points four
environment variables at it
`CUTLYRA_RELEASE_KEYSTORE{,_PASSWORD}` / `CUTLYRA_RELEASE_KEY_{ALIAS,PASSWORD}`),
and runs `./gradlew assembleRelease`.
`apps/mobile/android/app/build.gradle` reads those same four env vars to
build a `signingConfigs.release` block — see the comment at the top of
that file. If the env vars are absent (any build that isn't this
workflow), the `release` build type simply has no signing config and
`assembleRelease` still succeeds, producing an **unsigned** APK. That's
intentional: `bun run android:build:release` (or the underlying
`apps/mobile/scripts/build-android-release.sh`) is always safe to run
locally without the secrets — it just won't be signed, and (verified
directly, running both variants of this exact build locally)
**Android's own tooling also renames the output file** in that case:
`app/build/outputs/apk/release/app-release.apk` when a signing config
was applied, vs. `.../app-release-unsigned.apk` when it wasn't. The
build script above reports whichever one it actually finds.

### 1d. Decide Play/direct signing compatibility before first Play rollout

Android updates are tied to the app-signing certificate. If you want a user
who installed Cutlyra from GitHub to be able to update that same installation
from Google Play (or vice versa), configure Play App Signing to use a copy of
the **same app-signing key** as the direct APK channel before the first open
testing/production rollout. Keep the **Play upload key separate**; it only
authorizes AAB uploads and is resettable.

If cross-channel update compatibility is not required, Google may generate the
Play app-signing key. In that case GitHub-direct APKs and Play-delivered APKs
will have different signing identities and cannot update one another in place.

No iOS secret setup is needed. There is deliberately no CI-held Apple
signing identity for this project (see the "iOS — the honest cost of
no-store" note in plan M13, and `docs/guides/ios-xcode-build.md`).

---

## 1f. Release payload: the spike diagnostics exclusion (Stage 9)

The M1 spike's throwaway diagnostics payload (spike.html + its hashed
JS/CSS chunk + the committed `public/spike-assets/*.mp4` test videos, plus
the native fixture clips `assets/spike/clip-{a,b}.mp4` — see
`CUTLYRA_HANDOFF.md` "Stage 9") is **excluded from release APKs at build
time**. It is NOT excluded from debug builds, which keep the full payload
for development/QA.

How it works (all in `apps/mobile/android/app/build.gradle`):

- The two native fixture clips live in the debug source set
  (`src/debug/assets/spike/`), so release asset merges never see them.
- A Gradle task, `pruneSpikeAssetsForRelease`, deletes the spike web
  payload from the gitignored `cap sync` OUTPUT copy
  (`android/app/src/main/assets/public/` — never a tracked source) and is
  wired as a dependency of `mergeReleaseAssets` for release variants only.
  It does NOT touch APKs after the fact, does not mutate tracked sources,
  and runs identically in local builds, `mobile-ci.yml`, and
  `.github/workflows/release.yml` (which invokes plain
  `./gradlew assembleRelease`).

Two non-obvious AGP behaviors make pruning the merge/compress
intermediates unusable (verified empirically during Stage 9): the asset
compress task silently keeps stale `<path>.jar` outputs for inputs that
vanish upstream (leaking them into the APK), and it hard-fails on a later
incremental build when its recorded output is deleted out from under it.
Pruning the merge INPUT avoids both.

Debug-note: `cap sync` regenerates `assets/public/` wholesale, and both
variants share that copy — so after a release build, a bare
`./gradlew assembleDebug` (without the canonical
`bun run build && cap sync` first) will package without the throwaway
diagnostics until the next sync. This is benign and self-healing; the
canonical debug flow always syncs first.

## 2. Cutting a release

Once the keystore secrets exist:

1. Update version numbers (`apps/mobile/android/app/build.gradle`
   `versionCode`/`versionName`; `apps/mobile/ios/App/App.xcodeproj`
   `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`) in a normal commit on
   `main`, and make sure `scripts/invariants.sh` is green on that
   commit.
2. Tag it and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. `.github/workflows/release.yml` runs automatically:
   - `invariants` — the same full gate as every push to `main`
     (`.github/workflows/bun-ci.yml`, called via `workflow_call`), on
     all three OSes. The rest of the workflow does not start until this
     is green.
   - `android-release` builds, signs, and verifies the Android APK and
     generates native debug symbols.
   - `publish-release` downloads the Android artifacts, writes a
     `SHA256SUMS.txt`, and creates the GitHub Release.
4. Once the release is live, update the two install guides in
   `docs/guides/` if the flow changed.

### Fast rollback

If a release turns out to be broken: delete the GitHub Release and its
tag (`gh release delete vX.Y.Z --cleanup-tag`), and re-point the publik
listing at the last-known-good tag. This is the same "pull the release
asset + repin the guide" ritual used elsewhere — see plan M13 item 5.

---

## 3. Status of this workflow

**Current repository CI is green.** On merged release-prep SHA
`ec4037d37e472db2a94f2b359da812344632f223`, Bun CI passed its Ubuntu,
Windows, and macOS invariant matrix and Mobile CI passed both Android debug
and iOS simulator jobs.

**The tag-triggered release workflow itself has not had a real publish run yet** — no
tag has been pushed. What *has* been verified directly, locally, in
this session, against the real Android toolchain (SDK platform 36 /
build-tools 36.0.0, JDK):

- `./gradlew assembleRelease` with `CUTLYRA_RELEASE_KEYSTORE*` env vars
  pointed at a throwaway local test keystore (never committed, deleted
  after) **succeeds and produces a genuinely signed APK** —
  `apksigner verify --print-certs` confirmed the output APK's signer
  certificate matches the test keystore's.
- The same build **without** those env vars set also succeeds (doesn't
  break local/CI-without-secrets builds), producing an unsigned APK
  under a different filename (`app-release-unsigned.apk` — see §2's
  note above; `apksigner verify` correctly reports no signature on it).

What has **not** yet been run is the tag-triggered GitHub Actions workflow
as a whole (release provenance gate, secret-backed signing, artifact hand-off,
and `gh release create`). Do not create a throwaway semver tag on production
history merely to exercise publishing; the workflow now fails closed on
version/tag provenance, and the real v0.1.0 tag should be created only after
the final physical candidate passes.

**Stage 10 update (2026-09-24, signed-release rehearsal):** the full
signing path was re-qualified end to end with a disposable rehearsal
keystore (`cutlyra-rc-rehearsal`, generated in the OS temp dir, deleted
after use — never in the repo, never a production identity):
`assembleRelease` + `bundleRelease` both signed successfully through
the four env vars, `apksigner verify` confirmed the rehearsal
certificate (v2 scheme, minSdk 29 needs no v1), per-entry CRC parity
vs the unsigned slimmed RC was byte-identical (all 494 entries — the
only size delta is the +8,192 B signing block), and the APK passed
16 KB zipalign + ELF checks with zero spike entries. The release build
was also run on the emulator (installed in-place over the QA debug
install via a debug-cert-signed copy explicitly labeled
`release-mode-debug-cert-test-only`, QA data preserved, golden debug
APK restored afterwards): cold launch, persisted-project open,
Media3 export to completion, and playback all PASSED with no fatal
logcat errors. Evidence retained (gitignored):
`dist/rehearsal/cutlyra-v0.1.0-release-REHEARSAL-NOT-FOR-DISTRIBUTION.apk`
+ its `SHA256SUMS.txt`.

---

## 4. Final release-owner procedure

Physical-device qualification is already complete: Stage 11 in
`CUTLYRA_HANDOFF.md` records the full iQOO I2221 Android 16 pass, including
release-mode export, persistence, offline operation, and the real-device bugs
found and fixed during qualification. The remaining path is publisher-owned:

1. **Generate the permanent Cutlyra direct app-signing key** — §1a, on your
   own machine, alias `cutlyra`. Decide the Play/direct signing compatibility
   strategy in §1d before the first Play rollout.
2. **Back it up securely** (password manager for the passwords, plus a
   private backup of the `.keystore` file itself).
3. **Configure the four `ANDROID_RELEASE_*` GitHub repo secrets** — §1c.
   Configure Play's separate `PLAY_UPLOAD_*` secrets only after generating
   the Play upload key per `PLAY_STORE_RELEASE.md`.
4. **Recommended:** run one final local signed build with the permanent key
   (§1e's script with the four `CUTLYRA_RELEASE_*` env vars set) and install
   it on the qualified phone before tagging.
5. **Create `v0.1.0`** — §2 steps 1–2 (version bump commit, tag, push).
6. **Let the release workflow build/sign/verify** — §2 step 3.
7. **Verify the published artifacts:** `SHA256SUMS.txt` must match your
   downloads, and the APK's certificate must be *yours*:

   ```sh
   apksigner verify --print-certs cutlyra-v0.1.0-android.apk
   # or, to print the fingerprint straight from the keystore:
   keytool -list -v -keystore cutlyra-release.keystore -alias cutlyra | grep SHA256
   ```

   Record the SHA-256 fingerprint somewhere durable; that fingerprint
   IS the app's permanent public identity.

**Never lose or casually replace the permanent signing key.** Android
application updates depend on signing identity: an update signed with
any different key is a *different app* as far as every installed device
is concerned, and there is no recovery short of uninstall/reinstall for
every user. (The Stage 10 rehearsal key was disposable by design; the
fingerprint printed from it must never be reused or mistaken for the
production identity.)
