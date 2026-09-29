# Cutlyra — Google Play release runbook

**Status 2026-09-29: SOURCE PREP COMPLETE; HUMAN ACCOUNT/SIGNING INPUTS REMAIN.**

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
  candidate must still be rebuilt from its final commit

## Play requirements reflected in this branch

As of this runbook, new phone/tablet apps submitted after 2026-08-31 must
target Android 16 / API 36 or higher. Cutlyra does.

New personal developer accounts created after 2023-11-13 require a closed test
with at least 12 testers continuously opted in for at least 14 days before
production-access application.

Every Play app requires a public privacy-policy URL in Play Console and privacy
policy text or a link inside the app.

Cutlyra uses minimum-scope system pickers instead of broad photo/video access.

## Signing

Use **Play App Signing**. Let Google manage/generate the Play app-signing key
for this new app unless a later migration requirement justifies a different
choice. The developer-owned keystore used to sign the uploaded AAB is the
**upload key**.

GitHub Actions secrets:
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Never commit the keystore or passwords. Human step: create and securely back up
the real upload key, then configure these secrets.

## Play AAB workflow

Run `.github/workflows/play-bundle.yml` manually. It runs invariants, builds
the mobile payload, syncs Capacitor, executes `./gradlew bundleRelease`,
checks the AAB ZIP/JAR signature and manifest, rejects internal spike assets,
and uploads the AAB plus SHA-256 checksum as a private Actions artifact.

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

The app now contains privacy text. The web source at
`apps/web/src/app/privacy/page.tsx` has also been rewritten for Cutlyra.

Before Play submission, the publisher must make that page available at an
active public non-PDF URL and supply the real developer/support/privacy contact
email used by the Play listing. The privacy text intentionally points to that
Play developer-contact email instead of inventing an address.

## Closed-test plan

Invite at least 15 people to preserve margin above Google's 12-tester floor.
Have each tester exercise: first launch; project create/open/delete; photo,
video and audio import; optional camera capture; timeline playback/scrub;
trim/split/delete/undo/redo; text/captions; normal effects/keyframes; export;
play/share result; force-stop/reopen persistence.

Record device, Android version, tested features, failures, feedback and fixes.

## Human-only sequence

1. Create/verify Play Console account and pay registration fee.
2. Complete identity/contact/device verification.
3. Create app `app.cutlyra.editor`.
4. Supply the real developer/support/privacy contact email.
5. Publish the privacy policy at a public URL.
6. Create/back up the upload key and configure GitHub secrets.
7. Run the Play AAB workflow; retain AAB + checksum.
8. Enroll in Play App Signing and upload to Internal testing.
9. Smoke-test the Play-delivered build on a real phone.
10. Start Closed testing; keep >=12 testers continuously opted in >=14 days.
11. Apply for production access with recorded test evidence.
12. Submit production release and monitor Android Vitals/reviews.

## Release gate

- [x] targetSdk 36
- [x] AAB build workflow added
- [x] broad photo/video/storage permissions absent
- [x] unused microphone permission removed
- [x] FileProvider minimized
- [x] privacy policy text available in-app
- [x] store/Data Safety drafts prepared
- [ ] final GitHub CI gates execute green
- [ ] real Play upload key configured
- [ ] final AAB rebuilt/checksummed
- [ ] public privacy URL + real contact live
- [ ] Play account/identity/device verification complete
- [ ] Internal test Play build smoke-tested
- [ ] closed-test requirement complete
- [ ] production access approved
- [ ] production release approved
