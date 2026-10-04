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
- Camera only for explicit capture
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
- Camera is optional and user initiated

**Ads:** No.

**App access:** unrestricted; no reviewer login required.

**Account deletion:** not applicable; no accounts exist.

**Permissions:** camera only for optional capture; no broad media/storage,
microphone, location, contacts, SMS, call log, or phone permission.

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
developer/support/privacy contact email used by the Play listing. The policy
also exposes the Cutlyra project issue tracker as an inquiry mechanism; the
verified Play contact email remains the preferred user-facing contact once the
listing exists.

## Closed-test plan

Invite at least 15 people to preserve margin above Google's 12-tester floor.
Have each tester exercise: first launch; project create/open/delete; photo,
video and audio import; optional camera capture; timeline playback/scrub;
trim/split/delete/undo/redo; text/captions; normal effects/keyframes; export;
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
