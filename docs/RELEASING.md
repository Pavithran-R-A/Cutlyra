# Releasing Cutlyra

Cutlyra ships **direct-distribution only** — no App Store, no Play Store
(plan `~/.claude/plans/opencut-mobile-port.md` §8.0 item 5, ratified
2026-08-17; see `docs/DECISIONS.md`). Every release is a GitHub Release
attached to a `v*.*.*` tag, built by
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

- **Android:** a signed release APK, installable directly (sideload).
- **iOS:** an unsigned `.ipa` — there is no CI-held Apple signing
  identity and no store review. See `docs/guides/ios-xcode-build.md` for
  the two ways a real iPhone actually gets this app installed.

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

### 1c. Add four repo secrets

Using the [`gh` CLI](https://cli.github.com/) (or the GitHub web UI
under **Settings → Secrets and variables → Actions**):

```sh
gh secret set ANDROID_KEYSTORE_BASE64   --repo <your-org>/cutlyra < cutlyra-release.keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --repo <your-org>/cutlyra   # paste when prompted
gh secret set ANDROID_KEY_ALIAS         --repo <your-org>/cutlyra   # "cutlyra", if you used the command above
gh secret set ANDROID_KEY_PASSWORD      --repo <your-org>/cutlyra   # paste when prompted
```

Then **delete the local `.keystore.b64` file** (keep only the raw
`.keystore` file, backed up privately — the base64 copy has no purpose
once it's in the secret store):

```sh
rm cutlyra-release.keystore.b64
```

### 1d. What the workflow does with these

`.github/workflows/release.yml`'s `android-release` job decodes
`ANDROID_KEYSTORE_BASE64` back to a file at runtime, points four
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

No iOS secret setup is needed. There is deliberately no CI-held Apple
signing identity for this project (see the "iOS — the honest cost of
no-store" note in plan M13, and `docs/guides/ios-xcode-build.md`).

---

## 1e. Release payload: the spike diagnostics exclusion (Stage 9)

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
   - `android-release` and `ios-release` run in parallel, each building
     its artifact.
   - `publish-release` downloads both, writes a `SHA256SUMS.txt`, and
     creates a GitHub Release on the tag with all three files attached.
4. Once the release is live, update the two install guides in
   `docs/guides/` if the flow changed.

### Fast rollback

If a release turns out to be broken: delete the GitHub Release and its
tag (`gh release delete vX.Y.Z --cleanup-tag`), and re-point the publik
listing at the last-known-good tag. This is the same "pull the release
asset + repin the guide" ritual used elsewhere — see plan M13 item 5.

---

## 3. Status of this workflow

**The GitHub Actions workflow itself has not had a real run yet** — no
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

What has **not** been run in this session: the GitHub Actions workflow
itself (job graph, the `workflow_call` gate, artifact hand-off between
`android-release`/`ios-release` and `publish-release`, `gh release
create`), and the iOS unsigned-`.ipa` packaging step (needs a real
device-SDK Xcode build, not exercised this session — see the M12
handoff for what was and wasn't run there). Verify the full workflow
end to end against a real tag (a `v0.0.0-test`-style tag against a
disposable release is a reasonable first check) before relying on it
for a real release.

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

## 4. Final pre-physical-QA procedure (the whole remaining human path)

Everything automatable before a real phone exists is done. What
remains, in order:

1. **Physical-device QA.** Install a debug (or rehearsal-style locally
   signed) build on the target phone and re-run the qualification the
   emulator cannot give: real codec/GPU behavior, thermals, OEM WebView
   stacks (`docs/EMULATOR-QA.md` records what emulator QA did cover).
2. **Generate the permanent Cutlyra signing key** — §1a, on your own
   machine, alias `cutlyra`.
3. **Back it up securely** (password manager for the passwords, plus a
   private backup of the `.keystore` file itself).
4. **Configure the four GitHub repo secrets** — §1c.
5. **Optional:** run one final local signed build with the real key
   (§1d's script with the four `CUTLYRA_RELEASE_*` env vars set) and
   install it on the phone from step 1 before tagging.
6. **Create `v0.1.0`** — §2 steps 1–2 (version bump commit, tag, push).
7. **Let the release workflow build/sign/verify** — §2 step 3.
8. **Verify the published artifacts:** `SHA256SUMS.txt` must match your
   downloads, and the APK's certificate must be *yours*:

   ```sh
   apksigner verify --print-certs cutlyra-v0.1.0.apk
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
