# Cutlyra — Google Play production readiness

**Prepared:** 2026-11-14
**Base:** `main` @ `85ef015b8e079e517a104894e4856c0f55c0d106`
**App identity:** `app.cutlyra.editor` · versionName `0.1.0` · versionCode `1` · minSdk 29 · targetSdk/compileSdk 36
**Release candidate branch:** `release/play-production-candidate`

This document is the source-side audit and final-gates record for Cutlyra's
first production release on the **existing** Google Play listing. It does not
upload, roll out, or modify any Play Console state, and it does not handle
signing credentials.

---

## Phase 1 — Release audit

### 1.1 Production build configuration
- `applicationId` = `app.cutlyra.editor` (unchanged).
- `versionCode 1`, `versionName "0.1.0"` (`apps/mobile/android/app/build.gradle`).
- `minSdkVersion 29` (Android 10), `targetSdkVersion`/`compileSdkVersion 36` (Android 16).
- `allowBackup=false`; no broad media/storage permissions; `CAMERA` declared but never requested at runtime (documented in `CUTLYRA-PLAY-SUBMISSION-READINESS.md` §2).
- Release build type: `minifyEnabled false`, `debugSymbolLevel FULL` (native symbols shipped), signing only when `CUTLYRA_RELEASE_KEYSTORE*` env vars present (unsigned otherwise — never silently debug-signed).
- Spike/autotest payload pruned from release assets (`pruneSpikeAssetsForRelease`).
- ABI filters: `arm64-v8a`, `x86_64` (64-bit only, satisfies Play 64-bit requirement).
- Whisper model `ggml-tiny.en.bin` bundled; native `libcutlyra_whisper.so` for both ABIs.

### 1.2 Play App Signing / upload key
- Strategy: Play App Signing with Google-held app-signing key + separate owner-held upload key (`docs/PLAY_STORE_RELEASE.md` §7 / `CUTLYRA-PLAY-SUBMISSION-READINESS.md` §7).
- Upload key generated 2026-10-30 (`cutlyra-play-upload`, RSA 2048, PKCS12, alias `cutlyra-play-upload`); four `PLAY_UPLOAD_*` secrets configured (names verified, values never read back).
- Cross-channel compatibility (GitHub direct APK vs Play): **not decided**. If GitHub-installed and Play-installed copies must update each other in place, Play App Signing must be enrolled with a copy of the same app-signing key before the first rollout; otherwise Google generates its own and the two channels cannot update each other. **Owner decision required before first production release.**
- No private key material was accessed, printed or exported in this audit.

### 1.3 Highest versionCode already uploaded to Play
- **Unavailable in-repo.** Play Console is the authoritative source. `CUTLYRA-PLAY-SUBMISSION-READINESS.md` records that the Console upload was **not** performed as of the last documented run; the only built AAB (`cutlyra-play-1d7b533…aab`, SHA `6659567e…07f2bcd`) was produced by `play-bundle.yml` run `41037884283` but not uploaded.
- Therefore the highest uploaded versionCode is assumed to be **0 / none**, and `versionCode 1` is the candidate for the first upload. **Owner must confirm in Play Console before upload.** If any upload (internal/closed/production) already occurred, bump `versionCode` to `highest + 1` and rebuild.

### 1.4 Production permissions and privacy declarations
- Permissions: `INTERNET`, `CAMERA` (declared, never requested at runtime), `android.hardware.camera required="false"`.
- No `READ_MEDIA_*`, `READ_EXTERNAL_STORAGE`, `MANAGE_EXTERNAL_STORAGE`, `RECORD_AUDIO`, location, contacts, SMS, call log, phone.
- Privacy policy hosted at `https://site-dcfc842ddace4944a7faea3dcc59ff84.freebuff.page/privacy-policy` (production, verified 200, no auth, digest `b295e1c8…a3bd50`); in-app privacy screen concordant.
- Data Safety: no off-device collection, no sharing, no sale, no accounts; camera optional/user-initiated; local-only media processing.
- Support email: **HUMAN INPUT — real verified contact required** (still outstanding; blocks submission).

### 1.5 Signed release R8 qualification
- Shipping `release` build type: `minifyEnabled false` (R8 disabled in production).
- A CI-only `r8test` build type runs the full instrumented suite under R8 (`android-instrumentation-r8` job) and is green on `main` (verified 2026-11-14, 9m26s).
- Conclusion: R8 keep rules are **qualified**, so enabling `minifyEnabled true` is technically supported, but it is **not** enabled for v0.1.0 by default to minimize first-release risk. Enabling requires owner approval and a re-run of the R8 job on the exact release commit. R8 is not being enabled merely to silence a warning (no such warning exists).

### 1.6 Native library / 16 KB page-size compatibility
- Every `libcutlyra_whisper.so` LOAD segment aligned to `0x4000` (16384) in debug, release and AAB, both ABIs (verified by `llvm-readelf` in CI).
- Native debug symbols shipped at `FULL` level in the AAB (`BUNDLE-METADATA/com.android.tools.build.debugsymbols/`).
- Model SHA-256 pinned: `921e4cf8…920b1f` (`ggml-tiny.en.bin`).

### 1.7 Android 15/16 edge-to-edge compatibility
- targetSdk 36 enforces edge-to-edge by default on Android 15+.
- Web layer handles insets via `viewport-fit=cover` + `env(safe-area-inset-*)` padding in `packages/mobile-ui/src/components.css`, `apps/mobile/src/style.css`, `apps/mobile/src/app/app-root.css` (verified by source inspection).
- Theme sets `statusBarColor` transparent. No `enableEdgeToEdge()` call in Kotlin; insets handled at the WebView/CSS layer, consistent with the Capacitor WebView model.
- **Residual risk:** physical device verification of inset handling on Android 15/16 not yet performed (deferred; see Phase 3).

### 1.8 Crash and ANR readiness
- No crash-reporting or analytics SDK shipped (privacy posture); crashes rely on Play Console Android Vitals post-upload.
- Native crash symbolication available via `FULL` debug symbols.
- No ANR-inducing blocking work identified in source review; Media3 export runs on background threads (per `docs/EDL.md`).
- **Gap:** no in-app crash capture; production crash data only available after first Play rollout via Vitals.

### 1.9 Data preservation across app updates
- `allowBackup=false` (excludes app data from Android cloud backup — intended).
- App-private storage under the app's own data directory; FileProvider authority `app.cutlyra.editor.fileprovider` (production) distinct from QA variants.
- QA variants (`.qa`, `.qa2`, `.qa3`) use distinct applicationIds and storage — no cross-contamination with production.
- Restore-without-overwrite behavior verified in source (release notes / physical QA matrix).

### 1.10 Remaining Play Console policy warnings
- Support email still `HUMAN INPUT` (blocks submission).
- Content rating (IARC), target audience, Data Safety questionnaire to be transcribed from drafts.
- Closed-test 12-tester / 14-day requirement applicability is account-dependent (Play Console authoritative).
- Camera permission declared-but-unused is documented and disclosed in privacy policy (not a removal; intentional).

---

## Phase 2 — Release candidate

### 2.1 Branch
- `release/play-production-candidate` created from `main` @ `85ef015`.
- `applicationId` remains `app.cutlyra.editor`.
- `versionCode` remains `1` (no Play upload confirmed; see §1.3). **Owner must confirm highest uploaded versionCode before upload; if > 0, bump and rebuild.**

### 2.2 R8 decision
- Keep `minifyEnabled false` for v0.1.0 (see §1.5). R8 qualified but not enabled.

### 2.3 Release-like AAB validation
- Trigger `play-bundle.yml` (workflow_dispatch) on `main` to produce a fresh signed AAB + checksum + native symbols; validate container, signature, model SHA, native libs, 16 KB alignment, no spike assets. (Build only — no upload.)
- Previous validated AAB: `cutlyra-play-1d7b533…aab`, SHA `6659567e…07f2bcd` (run `41037884283`, all steps green).

### 2.4 Critical bridge / Media3 / WhisperJNI / Capacitor verification
- Media3 Transformer 1.11.0 (export, cross-fade compositor) — covered by instrumentation suite.
- WhisperJNI native symbols — covered by `android-instrumentation` and R8 job.
- Capacitor plugins — covered by unit + instrumentation tests.
- Full instrumented suite green on `main` (API 35 emulator + R8 variant, verified 2026-11-14).

### 2.5 Seven-job CI matrix
- On `main` @ `85ef015`: Bun CI (3 invariants: ubuntu/windows/macos) + Mobile CI (iOS, Android debug APK, API-35 instrumentation, R8) = **7/7 green** (verified 2026-11-14).
- RC branch will re-run the same matrix on push.

---

## Phase 3 — Physical acceptance (QA3, owner-approved only)

Use the separately owner-approved QA3 installation (`app.cutlyra.editor.qa3`, distinct signing identity) to validate — **no device package install/modify without owner approval**:

- [ ] Correct timeline lane ordering.
- [ ] No drag/resize jumping.
- [ ] Real video thumbnails.
- [ ] Rotate/Fit/Fill exported-frame parity.
- [ ] Restore without overwriting an existing project.
- [ ] Audio-bearing MP4 export.
- [ ] Replace Clip durability.
- [ ] Save and reopen.
- [ ] Backup and restore.

Production and historical QA applications must be preserved (six Cutlyra-related packages currently installed; QA3 is separate and not yet installed).

---

## Phase 4 — Play Console production-access answers (drafts)

### 4.1 About your closed test
- Tester count invited: ≥15 (margin above 12 floor); record actual opted-in count and dates from Play Console.
- Testers exercised: first launch; project create/open/delete; photo/video/audio import; optional camera capture; timeline playback/scrub; trim/split/delete/undo/redo; text/captions; keyframes/cross-fade; export; play/share; force-stop/reopen persistence.
- Recorded per tester: device, Android version, features exercised, failures, feedback, fixes applied.
- **Do not invent usage statistics or claim unexecuted physical tests passed.** The existing test is nearing its 14-day requirement; do not create a new test or remove existing testers.

### 4.2 About your app/game
- App name: Cutlyra. Package: `app.cutlyra.editor`.
- Category: Video Players & Editors (creative tool).
- Target audience: general-purpose, not designed specifically for children.
- Ads: none. In-app purchases: none.
- Permissions: camera only (optional capture); no broad media/storage, microphone, location, contacts, SMS, call log, phone.
- Data Safety: no off-device collection, no sharing, no sale, no accounts; local-only media processing.
- Privacy policy URL: `https://site-dcfc842ddace4944a7faea3dcc59ff84.freebuff.page/privacy-policy`.
- Support email: **HUMAN INPUT required.**

### 4.3 About your production readiness
- Evidence: source-side CI green (7/7 on merged main), R8 keep rules qualified, 16 KB alignment verified, targetSdk 36, native debug symbols, privacy policy hosted and drift-guarded.
- Outstanding: support email, physical acceptance (Phase 3), final Play-delivered smoke test, closed-test 14-day completion (if applicable to this account).

---

## Phase 5 — Final gates

### Release readiness verdict
**CONDITIONAL GO for source-side preparation. NO-GO for production upload/rollout today.**

### Existing Play package and version details
- Package: `app.cutlyra.editor` · versionName `0.1.0` · versionCode `1` · minSdk 29 · targetSdk 36.
- No Play upload confirmed in-repo (Console authoritative).

### Next eligible versionCode
- If no upload occurred: `1` (candidate). If uploads exist: `highest_uploaded + 1`. **Owner must confirm in Play Console; not guessed.**

### Production AAB validation results
- Previous validated AAB SHA-256: `6659567e478da6ddbe4986ffaf364c368dfbf0dde07bdbe52514ba4fd07f2bcd` (run `41037884283`).
- Fresh build produced by `play-bundle.yml` run `43597025250` on `main` @ `85ef015` (build only, no upload): invariants gate (ubuntu/windows/macos) + Android Play bundle — **all green**, 4/4 jobs. AAB built, container/signature/model/native-lib/16 KB alignment/spike-asset checks passed.

### Signing compatibility assessment
- Play App Signing with separate upload key (decided). Cross-channel (GitHub direct APK ↔ Play) compatibility **undecided** — owner must choose before first rollout (see §1.2).

### Required owner actions
1. Confirm highest uploaded versionCode in Play Console; set `versionCode` accordingly and rebuild if needed.
2. Create/verify Play Console account, identity verification, create app `app.cutlyra.editor`.
3. Supply real support email; replace `HUMAN INPUT` in `docs/PLAY_STORE_LISTING.md`.
4. Decide cross-channel signing compatibility and enroll in Play App Signing accordingly.
5. Run `play-bundle.yml`, download AAB + checksum, verify signer is upload key.
6. Complete Data Safety, content rating (IARC), target audience, store listing from drafts.
7. Upload icon, feature graphic, screenshots (prefer recapture from final candidate).
8. Internal testing track smoke test on a real phone.
9. Closed testing (if account requires): ≥12 testers continuously opted in ≥14 days.
10. Apply for production access with recorded test evidence.
11. Owner-approved QA3 physical acceptance (Phase 3) before submission.
12. Explicit owner approval before any production upload or rollout.

### Unresolved P0/P1 bugs
- None identified as P0/P1 in source audit. (Physical acceptance items in Phase 3 are unexecuted and must not be claimed as passed.)

### Production-access application readiness
- Not ready until: support email supplied, physical acceptance executed, closed-test 14-day requirement satisfied (if applicable), Play-delivered smoke test passed.

### Exact PR and CI evidence
- QA3 signing environment PR: #85, merge `85ef015`, 7/7 CI green on merged main.
- Play readiness PRs #43–#46 (see `CUTLYRA-PLAY-SUBMISSION-READINESS.md` §8).
- Play bundle run: `41037884283` (AAB SHA `6659567e…07f2bcd`).
- Seven-job matrix on `main` @ `85ef015`: all green (2026-11-14).

### Remaining reasons not to publish
1. Support email not supplied.
2. Physical acceptance (Phase 3) unexecuted.
3. Closed-test 14-day requirement status unconfirmed for this account.
4. Play-delivered build not yet smoke-tested on a real phone.
5. Cross-channel signing compatibility undecided.
6. No explicit owner approval for production upload/rollout.
7. Highest uploaded versionCode unconfirmed in Play Console.

---

## Constraints honoured
- No production upload or rollout performed.
- No device package installed or modified.
- No signing credential accessed, printed, exported or uploaded.
- Production signing, Play Console, versionCode, app identities, user media untouched by this audit.
- QA3 remains separate from the Play application.
- No AI attribution in commits/PRs.
