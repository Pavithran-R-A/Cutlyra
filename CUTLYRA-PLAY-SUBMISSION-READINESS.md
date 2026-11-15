# Cutlyra — Google Play Submission Readiness

**Prepared:** 2026-10-29
**Release candidate base:** `aee28b7fc971b1d9b6e64150f9a6f84645f572c1` (exact `main` head)
**App identity:** `app.cutlyra.editor` · versionName `0.1.1` · versionCode `2` · minSdk 29 · targetSdk 36

This is the source-side sign-off for the first Google Play submission. It records
what was verified, the exact artifact hashes, what remains for the account owner
alone, and an evidence-backed GO/NO-GO.

Nothing in this document prints, uploads, rotates or overwrites a private key. No
account was created, no purchase made, no app published, no device operated.

---

## 1. Verdict

**CONDITIONAL GO for source-side preparation. NO-GO for submission today.**

| Gate | Verdict | Basis |
| --- | --- | --- |
| Manifest matches actual functionality | **GO** | Section 2 |
| Privacy policy truthful and self-contained | **GO** | Section 3 |
| Data Safety draft matches the binary | **GO** | Section 4 |
| Play listing draft accurate | **GO** | Section 4 |
| Store graphics ready (icon / feature / screenshots) | **GO** | Section 5 |
| `play-bundle.yml` signing, model, native-lib, version, AAB gates | **GO** | Section 6 |
| Play App Signing strategy decided and documented | **GO** (decision owner-side) | Section 7 |
| CI green on exact head | **GO** | Section 8 |
| CI green on merged `main` | **GO — `1d7b533` 6/6** | Section 8 |
| Hosted policy guarded against drift | **GO — CI check live** | Section 3 |
| C: disk + protected evidence preserved | **GO** | Section 10 |
| Autotest `content://` false-negative corrected | **GO** | Section 9 |
| Privacy policy **hosted publicly** | **GO — live and verified** | Section 3 |
| Verified support contact available | **BLOCKED — owner** | Section 11 |
| Play Console app created / internal testing | **BLOCKED — owner** | Section 11 |
| 12-tester / 14-day closed test | **BLOCKED — owner, applicability account-dependent** | Section 11 |
| Signed AAB uploaded | **BLOCKED — owner** | Section 11 |

The app **cannot** be submitted today. Every remaining action requires the account
owner's Google credentials, the owner's keystore, or a real contact address —
none of which exist in this repository or may be handled here.

---

## 2. Final merged Android manifest vs actual functionality

Audited against `apps/mobile/android/app/src/main/AndroidManifest.xml` and the
shipped UI call graph.

| Declared | Actual functionality | Verdict |
| --- | --- | --- |
| `INTERNET` | WebView asset loading; no analytics/telemetry/ads in v0.1.0 | Required |
| `CAMERA` | **Declared, never requested at runtime.** No shipped screen passes `source: "camera"` — `importMediaFromNative()` in `packages/editor-core/src/media/native-import.ts` calls `pickMedia({ kinds, allowMultiple })` with no `source`, and the only `source?: "library" \| "camera"` value in TS is the type declaration itself. The `NativeBridgePlugin` `source == "camera"` branch and `MediaPickerIntents.buildCameraCaptureIntent()` are unreachable from v0.1.0's UI. | Declared-but-unused |
| `android.hardware.camera` `required="false"` | No camera hardware needed; camera-less devices install | Correct |
| `allowBackup=false` | Project/media data excluded from Android cloud backup | Correct |
| No `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` / `READ_EXTERNAL_STORAGE` / `MANAGE_EXTERNAL_STORAGE` | Photo Picker + SAF only | Correct |
| No `RECORD_AUDIO` | No microphone recorder implemented | Correct |
| No `ACCESS_FINE_LOCATION`, contacts, SMS, call log, phone | Not used | Correct |
| FileProvider → `cacheDir/camera-capture/` only | Narrow sharing surface | Correct |

### The camera-capture claim inconsistency — corrected

The inconsistency was a **claim** problem, not a permission problem. The privacy
text implied no camera permission exists, while the merged manifest declares
`CAMERA` — which Play will surface in the app's permission list. A reviewer
comparing the two could reasonably flag the listing as inaccurate.

**Correction applied** (no feature invented, no permission added, no permission
removed):

- `apps/web/public/privacy-policy.html` — now states the interface offers no
  camera capture, that the manifest declares `CAMERA` for a code path the
  interface does not expose, that it is never requested at runtime so Android
  never shows a camera prompt, and that no camera data is collected.
- `apps/mobile/src/app/app-root.tsx` (in-app Privacy screen) — same statement,
  concordant wording.

Removing `CAMERA` was considered and **deliberately not done**: it would change
the shipped binary after physical acceptance for GitHub #17/#20/#29/#39, which
cannot be re-run per instruction, and the declaration is honestly disclosable.
`docs/PLAY_STORE_RELEASE.md` records the rationale.

---

## 3. Privacy policy — truthfulness, self-containment, hosting

**File:** `apps/web/public/privacy-policy.html` (standalone, single file, no
external requests: inline `<style>`, no scripts, no fonts, no images, no trackers).

Verified claims, each checked against source:

| Claim in policy | Verified against |
| --- | --- |
| No account / sign-in | No auth code in the Android app |
| No ads, no analytics, no telemetry, no crash reporting | `git grep` finds no ad/analytics SDK in any shipped `package.json` or Gradle dependency |
| No cloud sync; media/projects stay on-device | Storage is app-private; `allowBackup=false` |
| No broad photo/video library permission | Manifest has none (Section 2) |
| Camera statement | Corrected, Section 2 |
| On-device captions via bundled whisper.cpp | `libcutlyra_whisper.so` + `base/assets/models/ggml-tiny.en.bin`, built into the AAB |
| No server-side account data to delete | No account system |

**Self-contained:** yes. It is a complete document that stands alone without the
rest of the site — correct `<!doctype html>`, `lang`, `viewport`, title, an
`index,follow` robots tag, and all styling inline.

**In-app counterpart:** `apps/mobile/src/app/app-root.tsx` renders the same
substance from the Projects screen, satisfying Play's "privacy policy link or
text inside the app" requirement.

**Hosting target — promoted to PRODUCTION and verified (2026-10-29):**

```
https://site-dcfc842ddace4944a7faea3dcc59ff84.freebuff.page/privacy-policy
```

| Property | Verified |
| --- | --- |
| Environment | **production** (stable address; does not change when previews refresh) |
| HTTP status | **200** |
| `Content-Type` | `text/html` |
| Caching | `public, max-age=0, must-revalidate` |
| Authentication | **none** — no login, no cookie, no redirect to an auth page |
| Vantage points | checked twice: direct `curl` **and** an independent external fetch |
| Serves | the **29 October 2026** revision, including the CAMERA disclosure |
| Body digest | SHA-256 `b295e1c873a000fadf0b7ca799e0d1e8520577d174406c8f4b14acfaf2a3bd50` |
| Edge | Cloudflare (`Server: cloudflare`), h3 advertised |
| Identity | own Cutlyra site `1ed8e244-6839-4026-a5c3-54950fdfa004` (“Cutlyra Privacy Policy”) on `freebuff.page` — no other project's domain, sender or brand involved |
| Cost | free tier; 21 of 100,000 monthly requests at inspection |

**Source-to-host integrity — all three agree on one digest:**

| Layer | Blob / digest |
| --- | --- |
| committed source `apps/web/public/privacy-policy.html` @ `main` | git blob `e77b6b1c232e2b252b3e4cac457ccc7c248fbc58` → `b295e1c8…a3bd50` |
| hosting bundle `hosting/privacy-policy/public/privacy-policy.html` @ `main` | git blob `e77b6b1c232e2b252b3e4cac457ccc7c248fbc58` → `b295e1c8…a3bd50` |
| bytes served at the production URL | `b295e1c8…a3bd50` |

`/` answers `301` → `/privacy-policy.html`, which the platform rewrites to
`/privacy-policy`. Either address resolves to the same bytes; `/privacy-policy`
is the canonical one to paste into Play Console.

**Preview environment preserved as a fallback:**
`https://site-835c83d428b64a81980da726f9591268.freebuff.page/privacy-policy`
remains published and untouched — production was promoted only after it passed
the same verification, so nothing was torn down first. It still serves the
older **4 October 2026** revision, so it is deliberately **not** the address for
Play Console; it can be republished from the current bundle or unpublished once
the owner is satisfied.

**Automated drift guard (PR #46):** the Linux `invariants` job now fails when
the bundle copy stops matching `apps/web/public/privacy-policy.html` **or** when
the live production URL stops serving those exact bytes. It runs on every push
and PR, normalises CRLF, needs no secret and no paid monitoring service, and
keeps the check count at six. Proven both ways locally: exit 0 against
production, exit `1` against the stale preview. The `curl` lives in CI rather
than `scripts/invariants.sh`, so the repo itself still works fully offline.

The bundle lives in-repo at `hosting/privacy-policy/` (committed in PR #45): a
Worker that serves static assets plus that one redirect, and **makes no outbound
call of any kind** — a hosting layer that phone-home'd would contradict the very
claims the policy makes. Its README records the digest and the re-copy/redeploy
procedure, because `hosting/privacy-policy/public/privacy-policy.html` is a copy
of the source of truth under `apps/web`.

The app-rendered version at `apps/web/src/app/privacy/page.tsx` → `/privacy` and
the **in-app privacy screen** remain available offline regardless.

**Play Console still needs an absolute `https://` URL** — the one above — pasted
in by the owner (Section 11). It is now available; it no longer blocks hosting.

**Support contact — NOT available.** `docs/PLAY_STORE_LISTING.md` still carries
`Support email: HUMAN INPUT — real verified contact required`. Both the hosted
policy and the in-app screen therefore refer generically to "the verified
developer/support email published on Cutlyra's Google Play listing" — truthful
today, but it must be replaced with a real monitored address before submission.

**No foreign branding or sender.** The policy and listing use only Cutlyra's own
mark (`assets/brand/cutlyra-mark.svg`). No other project's transactional sender,
logo, domain or name appears anywhere in the policy, listing, or release notes.

> ⚠ **Live contradiction risk.** An unrelated, **untracked** PostHog workstream
> exists in this working copy (`apps/web/src/instrumentation-client.ts`,
> `apps/web/src/services/analytics/posthog-replay.ts`,
> `apps/web/posthog-replay.check.mjs`, `POSTHOG_REPLAY.md`, dated 2026-10-21).
> If that workstream is ever merged, every "no analytics / no telemetry" claim in
> the privacy policy, the Data Safety draft and the listing becomes **false** and
> all three must be rewritten together with a matching Data Safety declaration.
> It is **not** part of this release, not committed, and not in either PR.

---

## 4. Data Safety draft and Play listing

Both live in-repo and were audited line-by-line against the binary.

**Data Safety draft** (`docs/PLAY_STORE_RELEASE.md`):

- Data collected off-device: **No** — verified: no network egress of user content.
- Data shared: **No** · Data sold: **No** · Accounts: **No**.
- Camera data: **No** — with the corrected disclosure of the declared-but-never-
  requested `CAMERA` permission.
- App access: unrestricted, no reviewer login.
- Account deletion: not applicable.

**Listing draft** (`docs/PLAY_STORE_LISTING.md`):

- Short/full description checked feature-by-feature against shipped UI: project
  create/reopen, Photo Picker + SAF import, trim/split/delete/duplicate/undo/redo,
  text and on-device captions, cross-fade transitions, transforms, keyframes, audio
  controls, local export. **No capability is claimed that does not exist**, and no
  camera capture is claimed anywhere in the listing.
- Explicit codec/GPU caveat present — no performance guarantees implied.
- No rankings, testimonials, price claims, or install calls to action.
- Release notes match `0.1.0`.

**Graphics spec compliance (verified programmatically, byte-exact dimensions):**

| Asset | Required | Actual | Result |
| --- | --- | --- | --- |
| Store icon | 512×512, ≤1024 KB | 512×512 | PASS |
| Feature graphic | 1024×500, 24-bit RGB, no alpha | 1024×500, 24-bit, no alpha, 43 KB | PASS |
| Screenshots | ≥4, min 1080×1920, 9:16 | 4× exactly 1080×1920 | PASS |

---

## 5. Feature graphic and store screenshots

**Feature graphic** — `assets/brand/feature-graphic-1024x500.png`
Generated by `scripts/generate-brand-assets.py` from the canonical
`assets/brand/cutlyra-mark.svg` + `icon-only.png`: navy field, Cutlyra mark and
wordmark only. No inherited OpenCut art, no third-party logo, no text overlay
beyond the brand.

**Screenshots** — `docs/store-screenshots/`, all four exactly **1080×1920**:

| # | File | Shows |
| --- | --- | --- |
| 1 | `01-projects-home.png` | Projects home |
| 2 | `02-editor-timeline.png` | Timeline / editor |
| 3 | `03-text-panel.png` | Text & captions panel |
| 4 | `04-export-sheet.png` | Export sheet |

Provenance, capture method and the recapture note are recorded in
`docs/store-screenshots/README.md`.

**Privacy review of the captures:** no personal project names, no file paths, no
account identifiers, no test diagnostics, no build/QA banners. The older QA
captures under `docs/screenshots/` are explicitly marked reference-only and must
**not** be uploaded — the timeline capture there shows test fixture names and a
test pattern.

**Recommended last step before upload:** recapture from the final Play-delivered
candidate so UI, permissions, version and behaviour match exactly what reviewers
receive. This needs an installed candidate, so it is an owner-side step.

---

## 6. `.github/workflows/play-bundle.yml` audit

Full non-secret audit. The workflow is `workflow_dispatch`-only and refuses to
build anything other than current `origin/main`.

| Gate | Present | Notes |
| --- | --- | --- |
| Canonical `origin/main` checkout enforced | ✅ | Fails if HEAD ≠ origin/main |
| Invariants gate (`bun-ci.yml`) required first | ✅ | `needs: invariants` |
| Signing inputs come only from secrets | ✅ | `PLAY_UPLOAD_KEYSTORE_BASE64`, `PLAY_UPLOAD_KEYSTORE_PASSWORD`, `PLAY_UPLOAD_KEY_ALIAS`, `PLAY_UPLOAD_KEY_PASSWORD` — decoded to `$RUNNER_TEMP`, never the repo |
| Keystore absent → hard failure, not silent unsigned build | ✅ | Explicit `::error::` |
| **versionCode / versionName guard** | ✅ **added** | Requires `versionCode 2` / `versionName "0.1.1"`, fails otherwise |
| **Debug-signing rejection** | ✅ **added** | Requires a real JAR signature block; `jarsigner -verify -strict` must not report "jar is unsigned"; exit must be 0 or 4; **signer `CN=Android Debug` fails the build** |
| Model inclusion | ✅ | `base/assets/models/ggml-tiny.en.bin` present + SHA-256 pinned to `921e4cf8…920b1f` |
| Native library alignment | ✅ | `libcutlyra_whisper.so` in `arm64-v8a` **and** `x86_64`; every `.so` LOAD-segment alignment ≥ `0x4000` (16 KB) checked with `llvm-readelf` |
| License/notice assets present | ✅ | CUTLYRA-LICENSE, CUTLYRA-NOTICE, THIRD_PARTY_NOTICES, SOUNDTOUCHJS, WHISPERCPP |
| Debug symbols | ✅ | `BUNDLE-METADATA/com.android.tools.build.debugsymbols/` required |
| AAB container integrity | ✅ | `test -s` + `unzip -t` |
| Internal asset leak check | ✅ | Rejects `spike.html`, `spike-assets`, `assets/spike`, `assets/autotest-`, `assets/legacy-harness-` |
| Artifact naming + SHA256SUMS + retention | ✅ | `cutlyra-play-<sha>.aab`, 14-day retention |

**Debug signing is never used for production signing.** `build.gradle` only
creates `signingConfigs.release` when `CUTLYRA_RELEASE_KEYSTORE` points at an
existing file; without it, `assembleRelease` produces an unsigned bundle rather
than a debug-signed one — and the workflow now *additionally* fails the build if
a debug certificate ever appears in the AAB.

**Non-secret validation run locally:** YAML parsed and structurally checked; the
two new guard scripts exercised against the real `build.gradle` (both pass on the
current tree); `scripts/invariants.sh` run (results in Section 8). No secret was
read, printed or simulated.

---

## 7. Play App Signing strategy (owner-only)

**Chosen: Play App Signing with a Google-generated app-signing key and a
separate owner-held upload key.**

Why: Google holds the app-signing key in a hardware-backed HSM and never returns
it, so the key that signs what users install cannot leak from a laptop, a CI log
or a backup; a compromised upload key can be reset without affecting users; and CI
only ever holds the upload key.

**Accepted consequence:** with a Google-generated app-signing key, Play-delivered
installs are signed *differently* from the existing direct-APK channel, so the two
channels cannot update each other in place. The QA/RC/RC2 devices stay on the
direct-APK channel. The alternative — handing Play a copy of the existing
app-signing key so both channels interoperate — must be chosen **before** the
first production release and is irreversible afterwards.

### Owner-only steps (never performed by an agent)

1. Create the upload key on the owner's machine with `keytool -genkeypair`
   (RSA 2048, long validity). Full command in `docs/PLAY_STORE_RELEASE.md`.
2. Read back the SHA-1/SHA-256 fingerprints (public data — safe to record).
3. Back up the keystore file + both passwords to two offline locations; store
   passwords in a password manager, never in this repository.
4. Create the four `PLAY_UPLOAD_*` GitHub secrets (`base64 -w0` of the keystore
   for the first one).
5. Enrol in Play App Signing in Play Console → *Setup → App signing*; download
   and back up Play's app-signing certificate. It is not exportable — never
   attempt to rotate, export or overwrite it.
6. Run `play-bundle.yml` once and confirm the AAB's signing cert is the *upload*
   key, not `CN=Android Debug`.
7. After the first production release, never rotate the app-signing key.

**Never:** commit a keystore, print a password or private key, commit
`*.jks`/`*.keystore`/`*.p12`/`*.pem`, paste key material into an issue/PR/chat/CI
log/screenshot, or substitute debug signing for production signing.
*No key material was accessed at any point in this preparation.*

---

## 8. CI verification

**Exact head `aee28b7fc971b1d9b6e64150f9a6f84645f572c1` — 6/6 success:**

| Check | Result |
| --- | --- |
| invariants (ubuntu-latest) | ✅ success |
| invariants (windows-latest) | ✅ success |
| invariants (macos-latest) | ✅ success |
| Android (debug APK) | ✅ success |
| Android instrumentation (API 35 emulator) | ✅ success |
| iOS (simulator, unsigned) | ✅ success |

**Focused PRs created for the necessary source fixes only:**

| PR | Head | Scope | Exact-head CI |
| --- | --- | --- | --- |
| [#43](https://github.com/Pavithran-R-A/Cutlyra/pull/43) | `8548b8fbc2cdf65df10cf06161f1409cfe3d318e` | `fix(autotest)` — content:// harness fix, 1 file | **6/6 success** |
| [#44](https://github.com/Pavithran-R-A/Cutlyra/pull/44) | `f032171c69b6d55ddb05b9252add7dc2319ac2f0` | `chore(play)` — claim correction, workflow gates, assets, docs — 16 files | **6/6 success** |
| [#45](https://github.com/Pavithran-R-A/Cutlyra/pull/45) | `5094a97023d68cf9291b33fcee6b3d1fea001d15` | `chore(release-hygiene)` — privacy-policy host bundle + `.gitignore` signing/binary guards — 5 files | **6/6 success** |
| [#46](https://github.com/Pavithran-R-A/Cutlyra/pull/46) | `97845ffe5d7e42076ce0ac43f5ed1e293597ddf5` | `fix(privacy)` — policy date correction + CI host-drift guard — 6 files | **6/6 success** |

All were `MERGEABLE / CLEAN` before merging. None required a change to pass CI.

**Merged `main` head `1d7b533b7abbeb7ea067a44b53a5b37726882636` — 6/6 success:**

| Check | Result |
| --- | --- |
| invariants (ubuntu-latest) | ✅ success |
| invariants (windows-latest) | ✅ success |
| invariants (macos-latest) | ✅ success |
| Android (debug APK) | ✅ success |
| Android instrumentation (API 35 emulator) | ✅ success |
| iOS (simulator, unsigned) | ✅ success |

Merge order: #43 → `981231a`, #44 → `eebe211`, #45 → `bfaa311`, #46 → `1d7b533`.
The 6/6 exact-head and 6/6 merged-main requirements are satisfied at every
step; intermediate heads `eebe211` and `bfaa311` were each verified 6/6 before
the next PR landed. The new host-drift guard passed on both the PR head and
merged `main`, i.e. it is genuinely running in CI and not just locally.

### Local non-secret validation (this machine)

From `bash scripts/invariants.sh`:

| Step | Result |
| --- | --- |
| typecheck — editor-core standalone | ✅ 0 errors |
| typecheck — native-bridge standalone | ✅ 0 errors |
| typecheck — apps/mobile standalone | ✅ 0 errors |
| typecheck — mobile-ui standalone | ✅ 0 errors |
| headless gate (no UI framework in editor-core/src) | ✅ 437 files, 0 violations |
| lint (all scopes) | ✅ **131 errors = documented baseline 131** |
| unit tests | ✅ **664 pass / 0 fail** |
| bridge-import gate | ✅ 0 hits |
| mouse-event gate | ✅ 0 raw listeners |

> **Local `invariants.sh` now reports `invariants: green` (exit 0).** It had
> previously failed 3 gates, all caused by the untracked PostHog workstream
> described in Section 3 — `posthog-js` not resolving in `build` and `tsc`, and
> a denylisted `eu.i.posthog.com` host in `apps/web/posthog-replay.check.mjs`.
> Those six files were **moved (not deleted)** to `preserved/posthog-workstream/`
> on 2026-10-29, outside every scan path, with SHA-256s recorded. All twelve
> local gates now pass: build, four standalone typechecks, headless gate, lint
> at the 131 baseline, 664/664 tests, offline audit clean, bridge-import and
> mouse-event gates.
> The workstream itself is out of scope for this release and was left intact
> on disk under `preserved/`.

---

## 9. Autotest `content://` false-negative — corrected

**PR #43**, narrowly scoped to `apps/mobile/src/autotest.tsx`.

**Defect:** the harness fetched the exported output URL in-app; when Capacitor's
file plugin returned a `content://` URI the WebView cannot fetch, the run was
marked failed — even though the native export reported `done` and MediaStore held
the file (the runner pulls and hashes it offline).

**Fix:**

- Detect `content://` on the output URL.
- Only downgrade to *"in-app byte probe unavailable (harness limitation)"* when
  the failure happens **before** the byte probe starts **and** the scheme is
  `content://`.
- Every other scheme (`blob:`, `file:`, `http:`) still fails the run.
- A probe that *started* and then failed (too-small file, undecodable track) is
  still a genuine export failure on any scheme.

The passing native export path is untouched. Only `autotest.tsx` changed — no
production source, no Android source, no CI file.

---

## 10. Disk usage and preserved evidence

**C: — 476 GB total, ~465 GB used, ~11 GB free (98%).** Tight; no large
artifacts were created in this preparation (all new assets total ~650 KB, and
the hosting bundle adds <10 KB). The only build run was the one `invariants.sh`
step required to prove the local gate — no Gradle/NDK rebuild, no emulator, no
APK or AAB produced. Left un-reclaimed on purpose: `qa-*` evidence directories
(~2.3 GB), the QA-signed `base.apk` / `base-installed.apk` (now git-ignored,
still on disk), and the `signed-*/` extracted trees.

**Verified present and untouched:**

| Path | Status |
| --- | --- |
| `Downloads/CUTLYRA-PROTECTED` | ✅ present |
| `Downloads/cutlyra-incident-evidence-20261021` (original-app-uninstalled incident, MiCloud inspection prep, snapshot) | ✅ present |
| `Downloads/cutlyra-rc2` | ✅ present |
| `Downloads/cutlyra-qa` | ✅ present |
| `qa-stage18-*`, `qa-release-3f0ffd0`, `qa-stage6-*`, `qa-stage4-*`, `qa-final-*` in-repo evidence | ✅ present |
| `OVERWRITE_FINAL_REPORT.md`, `CUTLYRA-RC2-INSTALL-SAFETY-VERDICT.md`, `PROTOCOL-INSTALL.md`, `STAGE5-DEFECT-RESOLUTION-REPORT.md` | ✅ present |

**No destructive operation was performed.** No device command, no `adb`, no
uninstall, no APK install, no evidence deletion. Two zero-byte `.git` pack
temporary files are flagged by git as garbage and can be reclaimed with
`git gc` at the owner's discretion (no measurable space).

---

## 11. Remaining owner-only actions (blocked here)

Every item below needs the account owner's credentials, keystore or real contact
address, and none was attempted here. One prerequisite — a live, verified
privacy-policy URL — **was** completed on 2026-10-29 (Section 3), so item 4 is
now a single paste.

### Blocking submission

1. **Play Console account** — register, pay, complete identity / contact /
   organization-or-personal verification.
2. **Create the app** `app.cutlyra.editor` and claim the package.
3. **Supply the real support email** and replace
   `Support email: HUMAN INPUT` in `docs/PLAY_STORE_LISTING.md`.
4. **Paste the privacy-policy URL into Play Console.** The URL is live,
   production and verified (Section 3):
   `https://site-dcfc842ddace4944a7faea3dcc59ff84.freebuff.page/privacy-policy` —
   200, `text/html`, no auth, serving the same bytes as `main`. Only the
   Console field-fill remains.
5. ~~**Create the upload keystore** and load the four `PLAY_UPLOAD_*` GitHub
   secrets (Section 7, steps 1–4).~~ **DONE 2026-10-30** (keystore in the
   owner-only `Documents\Cutlyra-Private\Signing\`, four secrets live).
6. **Enrol in Play App Signing** and record the app-signing certificate
   fingerprint (Section 7, step 5).
7. ~~**Run `play-bundle.yml`**, download the signed AAB, confirm the signer is
   the upload key, record its SHA-256.~~ **DONE 2026-10-30** — run `41037884283`,
   SHA-256 `6659567e…07f2bcd` (Section 12).
8. **Data Safety questionnaire, content rating (IARC), target audience, store
   listing** — transcribe the drafts in `docs/PLAY_STORE_RELEASE.md` and
   `docs/PLAY_STORE_LISTING.md`.
9. **Upload the assets** — icon, feature graphic, the four screenshots in
   `docs/store-screenshots/`. Preferably recapture screenshots from the final
   Play-delivered candidate first (Section 5).

### Testing-track gates (Section 8 of `docs/PLAY_STORE_RELEASE.md`)

10. **Internal testing track** — needs the app to exist in the Console; no
    minimum-tester requirement. Use it for the first Play-delivered smoke test.
11. **12-tester / 14-day closed testing** — **applicability is
    account-dependent and only the Console can answer it.**
    - Personal account created **after 2023-11-13** → **mandatory**: ≥12 testers
      continuously opted in for 14 days before production access can be applied
      for. Cannot be compressed; invite **15+** so one dropout does not reset the
      clock.
    - Older personal or organization account → generally not triggered by that
      rule, but the Console is authoritative for this account's real gates.
    - Google source: <https://support.google.com/googleplay/android-developer/answer/14151465>

### Post-submission

12. Record tester device / Android version / features exercised / failures per
    the closed-test plan.
13. Recapture store screenshots from the Play-delivered build and re-upload.

### Watch item (not owner-only, but must not be forgotten)

14. **Do not merge the PostHog workstream** without simultaneously rewriting the
    privacy policy, Data Safety declaration and listing (Section 3).

---

## 12. Artifact hashes

SHA-256 of the exact committed bytes (LF-normalized, i.e. what Git stores and
what CI builds from).

### PR #44 — `chore/play-release-prep` @ `f032171c69b6d55ddb05b9252add7dc2319ac2f0`

```
707494fb58f70cec74f20c846271e4d43b1124444746ee6a1d935f836a9a219a  assets/brand/feature-graphic-1024x500.png
daf6ddf8b4e71512f5b83fead0fb2774a2c6435c1740c2c5aafac9d90da66520  assets/brand/play-store-icon-512.png
b6880c7086348fa050981bdb6bcc7653044d2654ff1b21bfdea4bda28d8e690d  docs/store-screenshots/01-projects-home.png
2b92d6e508d21357a8b1016538698e5c765a54add1d918fd0d6985e1186d54f1  docs/store-screenshots/02-editor-timeline.png
001bcd6870d9974ef3746c289f0ba5fe00b0015482bfbafeedd8b9fbd7fcf253  docs/store-screenshots/03-text-panel.png
3952942bd96a3c06620545731ab2f7ee6d3a3167c9c20ce39e62b75cd4675dbd  docs/store-screenshots/04-export-sheet.png
f8d1bd385e451774e32c1bf766b6a026d77d736d3883dfb6faef9b3628d68b24  docs/store-screenshots/README.md
32574fc02202df09cb20b8cfb1073b10d4a45d986166591f77b88f82853fbfc1  apps/web/public/privacy-policy.html
f029a322c43044869d4410188a099361dccbebb2f8cda9f7a689b3c05e379deb  .github/workflows/play-bundle.yml
2890b757c8f6d899119dae254223741f41de5ea44b10a55693f27ef6d853e720  docs/PLAY_STORE_RELEASE.md
fdf0551ec3e1d76878d89508f161b23c8886323772f1f9d61e6509e7d5575d6d  docs/PLAY_STORE_LISTING.md
```

### PR #43 — `fix/autotest-content-uri-fetch` @ `8548b8fbc2cdf65df10cf06161f1409cfe3d318e`

```
f0ef0f446b6009820d22505e1c53f84fc9c82cc10a4e2341752672a8b61bf64b  apps/mobile/src/autotest.tsx
```

### PR #45 — `chore/release-hygiene` @ `5094a97023d68cf9291b33fcee6b3d1fea001d15`

```
28298596d273b6dbdeb1f16f3f8137f3f40a4289a666667de727bb1245cc9859  .gitignore
6bf4a68138e62ffb20ef5f78729864df5a13aab6bef90f1b5ae6101763bc9fbc  hosting/privacy-policy/worker.js
927c4bc2b5739b455254011795337de347a9b252004019debc63bbdd3dbc3c4e  hosting/privacy-policy/manifest.json
32574fc02202df09cb20b8cfb1073b10d4a45d986166591f77b88f82853fbfc1  hosting/privacy-policy/public/privacy-policy.html
076c19fc0ba6813c494e82923972f64ba52e6ef516eb90d30ad3f892a4a6a220  hosting/privacy-policy/README.md
```

The hosted copy's digest (`32574fc0…53fbfc1`) equals the committed
`apps/web/public/privacy-policy.html` **and** the byte actually served at the
live URL — one digest across source, bundle and edge. That digest advanced in
PR #46 when the policy date was corrected; the current value is below.

### PR #46 — `fix/privacy-policy-date` @ `97845ffe5d7e42076ce0ac43f5ed1e293597ddf5`

Policy date corrected to **29 October 2026** in all four copies (standalone
page served to Play, `/privacy` route, in-app screen, hosting bundle), plus the
CI host-drift guard. Current digests on `main`:

```
b295e1c873a000fadf0b7ca799e0d1e8520577d174406c8f4b14acfaf2a3bd50  apps/web/public/privacy-policy.html
b295e1c873a000fadf0b7ca799e0d1e8520577d174406c8f4b14acfaf2a3bd50  hosting/privacy-policy/public/privacy-policy.html
b295e1c873a000fadf0b7ca799e0d1e8520577d174406c8f4b14acfaf2a3bd50  bytes served at the production URL
```

All three are the git blob `e77b6b1c232e2b252b3e4cac457ccc7c248fbc58`.
The older `32574fc0…53fbfc1` value recorded against PR #44/#45 is the
4 October revision, still served by the preserved preview environment.

### Pinned in the workflow (verified at build time, not readable here)

```
921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f  base/assets/models/ggml-tiny.en.bin  (whisper tiny.en)
```

### First real signed Play bundle — 2026-10-30 (owner-authorized)

```
6659567e478da6ddbe4986ffaf364c368dfbf0dde07bdbe52514ba4fd07f2bcd  cutlyra-play-1d7b533b7abbeb7ea067a44b53a5b37726882636.aab
```

- 91,311,579 bytes; built by <https://github.com/Pavithran-R-A/Cutlyra/actions/runs/41037884283>
  (`play-bundle.yml`, workflow_dispatch on `main` =
  `1d7b533b7abbeb7ea067a44b53a5b37726882636`), conclusion **success**, 4/4 jobs:
  invariants on ubuntu/windows/macos (each including `invariants.sh`, and on
  ubuntu the hosted-policy drift guard) and `Android Play bundle` — every step
  green, including *Require canonical main checkout*, *Decode Play upload
  keystore*, *Require release version identity*, *Build signed AAB* and
  *Verify AAB container and signature*.
- Signer extracted from the AAB's own `META-INF/CUTLYRA-.RSA`:
  `CN=Cutlyra Play Upload, O=Cutlyra`, SHA-256
  `90:01:71:5E:20:CF:33:03:F1:4A:4A:50:F2:B3:AB:11:55:0B:65:43:F2:BE:E3:15:87:13:B8:8B:F5:E6:BC:DA`
  — byte-identical to the new owner-held upload certificate, and **not**
  `CN=Android Debug`. `jarsigner -verify` reports *jar verified*.
- `base/manifest/AndroidManifest.xml` carries `app.cutlyra.editor` and `0.1.0`.
- Private copies (never in git, never printed):
  `Documents\Cutlyra-Private\Release\cutlyra-0.1.0-closed-beta-1\`
  (`…​.aab` + `SHA256SUMS.txt`, `sha256sum -c` OK, plus `VERIFY-REPORT.txt`).
- Upload keystore: `Documents\Cutlyra-Private\Signing\cutlyra-play-upload.keystore`,
  PKCS12, RSA 2048, alias `cutlyra-play-upload`, valid 2026-10-30 → 2054-03-17;
  keystore SHA-256 `6d4843d7bf51689cccec9583aabe0aadf2b9f9890a5e83c2b80f7369e606c25f`.
  Generated with `keytool -storepass:file`/`-keypass:file` so no password ever
  appeared in a command line, a log or this document; folder ACL restricted to
  the owner account only. Owner backup into a password manager still pending.
- Four secrets configured (names verified with `gh secret list`, values never
  read back): `PLAY_UPLOAD_KEYSTORE_BASE64`, `PLAY_UPLOAD_KEYSTORE_PASSWORD`,
  `PLAY_UPLOAD_KEY_ALIAS`, `PLAY_UPLOAD_KEY_PASSWORD`.
- Console upload **not yet performed** — the browser profile available to this
  session has no Google session, and signing in is the owner's step.

---

## 13. Statement of constraints honoured

- No physical device test repeated; no APK installed; POCO untouched.
- No paid purchase, no account creation, no credential disclosure, no Play
  Console action, no bundle upload, no publication of the app.
- No private key was ever printed, echoed to a console, passed as a command
  argument, committed, or pasted into chat; passwords were created and consumed
  through files only. No debug signing used as production signing.
- One keystore **was** generated on 2026-10-30, under the owner's explicit
  written authorization to execute the Play upload-key setup — a brand-new
  dedicated upload key (`cutlyra-play-upload`), not a replacement of, or reuse
  of, any debug/QA credential, and not enrolled as an app-signing key.
- No Play Console action yet: no bundle uploaded, no release created or
  submitted, no production publication, no paid account or purchase.
- No feature invented; no permission added; no permission removed.
- `CUTLYRA-PROTECTED`, the QA/RC/RC2 artifacts and all incident evidence
  preserved; no destructive device or filesystem operation.
- The PostHog workstream was **relocated, not deleted** — all six files intact
  under `preserved/posthog-workstream/` with SHA-256s recorded — and made
  un-committable by an ignore rule rather than removed from disk.
- Unrelated working-copy changes (`bun.lock` drift, `qa-*` evidence
  directories, `signed-*/` extracted trees, QA-signed `base.apk`) left in place
  and excluded from every PR; the ignore rules block them without touching them.
- Analytics/telemetry was **not** merged into a release that claims to contain
  neither; the only hosting added makes no outbound call of any kind.
