# Cutlyra — Google Play release runbook

**Status 2026-10-04: FINAL RELEASE HARDENING IN PROGRESS; connected-device retest + publisher inputs remain.**

This is the source of truth for Cutlyra's Android Google Play release and
supersedes older notes that said "no Play Store release". Direct APK
distribution may continue separately.

## Verified source posture

- Application ID: `app.cutlyra.editor`
- Version: `0.1.0`, versionCode `1`
- minSdk 29; compileSdk/targetSdk **36**
- Play artifact: signed Android App Bundle (`.aab`)
- `allowBackup=false`
- Photo/video: Android Photo Picker; audio: SAF
- No broad `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`,
  `READ_EXTERNAL_STORAGE`, or `MANAGE_EXTERNAL_STORAGE`
- `CAMERA` is declared for a built-but-unreachable capture path; v0.1.0's UI
  exposes only Photo Picker / SAF import, so no runtime permission is requested
  and there is no in-app camera capture (matching the privacy policy)
- No `RECORD_AUDIO` in v0.1.0 because no microphone recorder is implemented
- No account, ads, analytics, telemetry, crash-reporting SDK, or cloud sync
- FileProvider exposes only `cacheDir/camera-capture/`
- Privacy policy text is reachable from the normal Projects screen
- Historical QA records a signed AAB rehearsal, 16 KB ZIP/ELF alignment,
  emulator testing, and physical Android 16 qualification; the final Play
  candidate must still be rebuilt from its final signed commit
- Release-prep source was merged to `main` at `ec4037d37e472db2a94f2b359da812344632f223`.
  On that exact merge SHA, **Bun CI passed on Ubuntu, Windows, and macOS** and
  **Mobile CI passed both Android and iOS simulator jobs**.

## Play requirements reflected in this branch

As of this runbook, new phone/tablet apps submitted after 2026-08-31 must
target Android 16 / API 36 or higher. Cutlyra does.

Google's current rule for **personal developer accounts created after
2023-11-13** is a closed test with at least 12 testers continuously opted in
for at least 14 days before applying for production access. Older personal
accounts and organization accounts may have different account-level gates;
Play Console is authoritative for the publisher account actually used.

Every Play app requires a public privacy-policy URL in Play Console and privacy
policy text or a link inside the app.

Cutlyra uses minimum-scope system pickers instead of broad photo/video access.

## Signing

Use **Play App Signing** and keep the **upload key separate** from the app
signing key. Google recommends this separation because an upload key can be
reset without changing the signing identity installed on users' devices.

Cutlyra also supports direct GitHub APK distribution. Decide the cross-channel
strategy before the first Play rollout:

- If GitHub-installed and Play-installed copies must be able to update one
  another in place, provide Play App Signing with a copy of the SAME
  app-signing key used by the GitHub direct APK channel, then use a distinct
  Play upload key for AAB uploads.
- If cross-channel updates are not required, let Google generate the Play
  app-signing key. GitHub and Play builds will then intentionally have
  different signing identities.

The Play AAB workflow uses dedicated upload-key secrets:
- `PLAY_UPLOAD_KEYSTORE_BASE64`
- `PLAY_UPLOAD_KEYSTORE_PASSWORD`
- `PLAY_UPLOAD_KEY_ALIAS`
- `PLAY_UPLOAD_KEY_PASSWORD`

The GitHub direct-release workflow uses separate `ANDROID_RELEASE_*` secrets.
Never commit any keystore or password. Human step: create and securely back up
the Play upload key, then configure only the `PLAY_UPLOAD_*` secrets here.

### Chosen Play App Signing strategy

**Use Play App Signing with a Google-generated app-signing key, and a
separate, owner-held upload key.** Rationale, in order of importance:

1. Google keeps the app-signing key in a hardware-backed HSM and never
   returns it, so the key that signs what users install cannot leak from a
   laptop, a CI log, or a backup.
2. If the upload key is ever lost or exposed, only the upload key is reset —
   the signing identity on users' devices is untouched and updates continue.
3. It keeps one credential (the upload key) in GitHub Actions secrets while
   nothing that can sign a store release ever exists in CI.

**Consequence to accept explicitly before the first Play upload:** with a
Google-generated app-signing key, the Play-delivered app is signed
*differently* from the existing GitHub-direct APK channel. The two channels
then cannot update each other in place — a user who sideloaded a GitHub APK
must uninstall before installing the Play build (or vice versa). The QA / RC /
RC2 devices in this program are on the direct-APK channel; that is unaffected
by Play App Signing. If same-key cross-channel updates turn out to be required,
the alternative is documented above: hand Play a copy of the *existing*
app-signing key as the Play app-signing key and keep a distinct upload key.
That decision is irreversible after the first production release, so make it
once, deliberately.

### Owner-only signing steps (never performed by an agent)

These are the only steps that touch key material. Run them on the owner's own
machine with the owner present. No step below is ever to be executed by an
automated session, and no keystore, password, key file, or PEM/DER export may
be printed, pasted into chat, committed, or uploaded to a public URL.

1. **Create the upload key** (owner machine, offline):

   ```bash
   keytool -genkeypair -v \
     -keystore ~/cutlyra-play-upload.keystore \
     -alias cutlyra-play-upload \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

   Choose a strong store password and a strong key password; record them in
   the owner's password manager, not in this repository.
2. **Verify the certificate is the expected one** (fingerprints are public
   data derived from the key — safe to print):

   ```bash
   keytool -list -v -keystore ~/cutlyra-play-upload.keystore \
     -alias cutlyra-play-upload | grep -E 'SHA1:|SHA256:'
   ```
3. **Back up the keystore file and its passwords** to at least two offline
   locations (encrypted external drive + password manager). Losing the
   upload key without a Play App Signing enrolment means the whole app
   signing identity must be re-established.
4. **Load the four GitHub secrets** (repo or environment secrets, not
   repository files):
   - `PLAY_UPLOAD_KEYSTORE_BASE64` = `base64 -w0 ~/cutlyra-play-upload.keystore`
   - `PLAY_UPLOAD_KEYSTORE_PASSWORD`
   - `PLAY_UPLOAD_KEY_ALIAS` = `cutlyra-play-upload`
   - `PLAY_UPLOAD_KEY_PASSWORD`
5. **Enrol in Play App Signing** in Play Console → *Setup → App signing*:
   upload the *app-signing key request* CSR/package generated by Play, or let
   Play generate the app-signing key, then download Play's app-signing
   certificate and store it with the backups. Never attempt to export Play's
   app-signing key — it is not exportable.
6. **Confirm which identity the first bundle carries** by running
   `.github/workflows/play-bundle.yml` and reading the signing-cert
   fingerprint out of the produced AAB. It must be the *upload* key, never
   the platform debug certificate. The workflow now fails the build if the
   bundle carries no JAR signature block, reports itself unsigned, or is
   signed with `CN=Android Debug`.
7. **Never rotate or overwrite the app-signing key** after the first
   production release. Rotation is a Play Console operation with user-facing
   consequences and is out of scope for any release runbook entry.

**What must never happen:** committing a keystore, printing a password or
private key, committing an `*.jks` / `*.keystore` / `*.p12` / `*.pem` file,
pasting key material into an issue, PR, chat transcript, CI log, or screenshot,
or substituting debug signing for production signing.

## Play Console setup, internal testing and closed testing

**Applicability: applicable, and every one of these gates needs owner
access. Nothing in this category can be completed from the repository.**

### What is already available (verified in this repo)

| Item | State | Evidence |
| --- | --- | --- |
| Play AAB build workflow with upload-key secrets | present | `.github/workflows/play-bundle.yml` |
| Store icon 512×512 | ready | `assets/brand/play-store-icon-512.png` |
| Feature graphic 1024×500 | ready | `assets/brand/feature-graphic-1024x500.png` |
| Phone screenshots 1080×1920 ×4 | ready | `docs/store-screenshots/` |
| Standalone privacy-policy page | ready, not yet hosted | `apps/web/public/privacy-policy.html` |
| Data Safety / listing drafts | ready | this file + `docs/PLAY_STORE_LISTING.md` |
| Release identity | `app.cutlyra.editor`, versionCode 1, versionName 0.1.0 | `apps/mobile/android/app/build.gradle` |
| CI green on exact main head | 6/6 checks success on `aee28b7` | GitHub Actions |

### What requires owner access (not available from here)

- A Play Console account, paid registration fee, and completed identity /
  contact / D-U-N-S-or-personal-ID verification.
- Creation of the app `app.cutlyra.editor` and package claim in the Console.
- The real developer/support/privacy contact email used on the listing.
- A hosted, public, non-geofenced, non-PDF privacy-policy URL.
- The four `PLAY_UPLOAD_*` repository secrets (only the owner can create the
  keystore and enter them).
- Play App Signing enrolment.
- **Internal testing track** access — available only after the app exists in
  the Console. It has no minimum-tester requirement and is the right place for
  the first Play-delivered smoke test, because it needs no opt-in programme.
- **Closed testing (12 testers / 14 days)** — see below.
- Data Safety questionnaire, content-rating (IARC) questionnaire, target
  audience and store listing publication.

### Is the 12-tester / 14-day closed test required?

Google's current rule: a **personal** developer account **created after
2023-11-13** must run a closed test with **at least 12 testers opted in
continuously for the preceding 14 days** before it may apply for production
access. This is still the active rule as of 2026-10 (Google's own help page:
<https://support.google.com/googleplay/android-developer/answer/14151465>).

- **If the owner's account is a personal account created after 2023-11-13 →
  applicable and mandatory.** Budget a 14-day wall-clock run before production
  access is even requestable; it cannot be compressed.
- **If it is an older personal account or an organization account →
  generally not triggered by that specific rule**, but the Console shows the
  account's actual production-access requirements, and other gates (identity,
  closed-testing-at-Google's-discretion, API-approval) can still apply.
- **Determinable only inside the Console.** The repository contains no Play
  Console credentials or exports, so this cannot be answered from source.

Practical consequence: if the rule applies, the schedule is
`upload → internal testing smoke test → closed testing with ≥15 testers for
14 days → production access application → production release`. Invite 15+, not
12, so one dropout does not reset the 14-day clock. Record tester device,
Android version, features exercised and failures, per the closed-test plan
below.

## Play AAB workflow

Run `.github/workflows/play-bundle.yml` manually. It runs invariants,
fetches whisper.cpp at the immutable v1.9.2 commit, downloads the pinned
tiny.en model and hard-verifies its SHA-256, builds the mobile payload, syncs
Capacitor, executes `./gradlew bundleRelease`, checks the AAB ZIP/JAR
signature and manifest, proves the bundled offline-caption model and native
libraries are present, rejects internal spike assets, and uploads the AAB plus
SHA-256 checksum as a private Actions artifact.

Expected Gradle output:
`apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`

## Play Console declaration draft for v0.1.0

**Data Safety**
- Data collected off-device: **No**
- Data shared by Cutlyra: **No**
- Data sold: **No**
- Accounts: **No**
- User-selected media/project processing is local-only
- No camera data collected; the `CAMERA` permission is declared but never
  requested at runtime because v0.1.0 has no in-app camera capture

**Ads:** No.

**App access:** unrestricted; no reviewer login required.

**Account deletion:** not applicable; no accounts exist.

**Permissions:** declared by Cutlyra: `INTERNET` and a
`CAMERA` that is never requested at runtime (v0.1.0 has no in-app camera
capture). Platform libraries additionally contribute the normal
`ACCESS_NETWORK_STATE` / `WAKE_LOCK` entries seen in a merged install. No
broad media/storage, microphone, location, contacts, SMS, call log, or phone
permission — see `CUTLYRA-RC2-INSTALL-SAFETY-VERDICT.md` for the observed
installed-permission list of a build made from this exact `main`.

**Target audience:** general-purpose creative/video-editing tool, not designed
specifically for children. The account owner must answer Google's exact
age-group and IARC questions truthfully from the final feature/listing set.

## Privacy-policy blocker owned by the publisher

The app now contains privacy text. For public hosting, the repository also
contains a standalone, dependency-free policy at
`apps/web/public/privacy-policy.html`. Use that static page (or an equivalent
verbatim deployment) for the Play Console privacy-policy field so the public
document cannot inherit unrelated web-app branding, scripts, analytics, or
runtime dependencies.

Before Play submission, the publisher must make that page available at an
active, public, non-geofenced, non-PDF URL and supply the real
developer/support/privacy contact email used by the Play listing. The
standalone policy intentionally relies on that verified public contact rather
than a private repository issue tracker.

**Verification of `apps/web/public/privacy-policy.html` (re-checked against
exact main `aee28b7`):**

- **Self-contained:** yes. One HTML file, inline `<style>` only — no
  `<script>`, no `<link>`, no images, no fonts, no network calls. It can be
  served by any static host with no build step and no runtime dependency.
- **Truthful against the shipped build:** yes. It states no account, no ads,
  no analytics/telemetry, no cloud sync, no account data, `allowBackup`
  disabled, on-device captions, and — matching the merged manifest — no
  in-app camera capture and no runtime camera, broad media, microphone,
  location, contact, SMS, call-log or phone permission.
- **Branding:** Cutlyra only. It deliberately does **not** inherit the Next.js
  web app, which still carries inherited OpenCut branding in several
  components (`apps/web/src/components/header.tsx`, `apps/web/src/app/brand/`,
  etc.) — another reason to publish this static file rather than the `/privacy`
  route for the Play Console field.
- **Hosting target:** **not yet established.** There is no deploy workflow in
  `.github/workflows/` (only `bun-ci.yml`, `mobile-ci.yml`, `play-bundle.yml`,
  `release.yml`), and no configured site/domain. `https://cutlyra.dev/` appears
  in the repo only as the EDL JSON-Schema identifier
  (`packages/editor-core/schema/edl-v1.json`), which is **not** evidence the
  domain is registered or serving. Owner must pick and verify a host.
- **Support contact:** **not yet available.** No Cutlyra developer/support/
  privacy address exists anywhere in the repository; the only email-like
  strings found belong to third-party packages (`fflate`'s author) or the
  inherited OpenCut upstream (`brand@opencut.app`, `security@opencut.app`).
  Neither may be used. The policy therefore points at the verified contact
  that will be published on the Play listing — the owner must supply a real
  address before submission.

## Closed-test plan

Invite at least 15 people to preserve margin above Google's 12-tester floor.
Have each tester exercise: first launch; project create/open/delete; photo,
video and audio import; timeline playback/scrub;
trim/split/delete/undo/redo; text/captions; keyframes/cross-fade; export;
play/share result; force-stop/reopen persistence.

Record device, Android version, tested features, failures, feedback and fixes.

## Source-readiness verdict

Release hardening is complete only when the fixed connected-test harness runs
green on a real device and the final physical export/release-mode matrix is
repeated from the merged release candidate. Do not call the repository 100%
release-ready merely because host CI is green. Publisher-controlled Play gates
remain separate from engineering readiness.

## Human-only sequence

1. Create/verify Play Console account and pay registration fee.
2. Complete identity/contact/device verification.
3. Create app `app.cutlyra.editor`.
4. Supply the real developer/support/privacy contact email.
5. Publish `apps/web/public/privacy-policy.html` (or equivalent) at an active public URL and verify it in a signed-out browser.
6. Prepare the required Play icon, feature graphic, and final-candidate screenshots per `PLAY_STORE_LISTING.md`.
7. Create/back up the upload key and configure GitHub secrets.
8. Run the Play AAB workflow; retain AAB + checksum.
9. Enroll in Play App Signing and upload to Internal testing.
10. Smoke-test the Play-delivered build on a real phone.
11. If the publisher account is subject to the new-personal-account rule, start Closed testing and keep >=12 testers continuously opted in >=14 days.
12. Apply for production access with recorded test evidence when Play Console requires it.
13. Submit production release and monitor Android Vitals/reviews.

## Release gate

- [x] targetSdk 36
- [x] AAB build workflow added
- [x] broad photo/video/storage permissions absent
- [x] unused microphone permission removed
- [x] FileProvider minimized
- [x] privacy policy text available in-app
- [x] store/Data Safety drafts prepared
- [x] target/API/permission/privacy source hardening complete
- [ ] fixed connected instrumentation suite executes 0 failures on real device
- [ ] final physical import/edit/caption/export/offline/release-mode matrix passes
- [ ] final GitHub CI gates execute green on merged hardening source
- [ ] real Play upload key configured
- [ ] final AAB rebuilt/checksummed
- [ ] public privacy URL + real contact live
- [ ] required Play icon + feature graphic + final-candidate screenshots prepared
- [ ] Play account/identity/device verification complete
- [ ] Internal test Play build smoke-tested
- [ ] closed-test requirement complete
- [ ] production access approved
- [ ] production release approved
