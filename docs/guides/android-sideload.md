# Install Cutlyra on Android (direct APK)

> **Pre-release guide.** Google Play is the planned primary Android release
> channel. This page documents the optional direct-APK path for users who
> intentionally choose to sideload an official Cutlyra release.

## Requirements

- Android 10 (API 29) or newer on a supported 64-bit device.
- Enough free storage for Cutlyra, imported media, proxies, and exports.
- No Cutlyra account or sign-in is required.

Cutlyra's editing, captions, playback, and export pipeline is designed to work
locally on the device. The app does not request broad media-library access:
visual media uses Android's system Photo Picker and audio uses the system
document picker.

## 1. Get an official APK

Only install an APK that the Cutlyra maintainer has published as an official
release artifact. The canonical repository is:

`Pavithran-R-A/Cutlyra`

Do not install APKs re-uploaded by third-party download sites. If a release
includes `SHA256SUMS.txt`, verify the APK checksum before installing it.

If the repository has no published release yet, there is no official direct
APK to install; use the Google Play testing/release channel when it becomes
available instead of downloading an unofficial build.

## 2. Allow installation from the source you used

Android normally blocks APK installation from browsers/file managers until
you explicitly allow that source.

1. Open the downloaded official APK.
2. If Android blocks the install, open the offered **Settings** page.
3. Enable **Allow from this source** only for the browser or file manager you
   used.
4. Return to the installer.

The exact wording varies by Android/OEM. You can turn this permission off again
after installation.

## 3. Install and launch

1. Tap **Install**.
2. Wait for Android's package verification to finish.
3. Tap **Open**.
4. Complete Cutlyra's first-run screen and create or open a project.

Cutlyra uses system pickers when you choose media, so selecting a file grants
access to the item you picked rather than to your entire library.

## 4. Verify the app identity

For a release APK, verify that:

- package name is `app.cutlyra.editor`;
- the version matches the release you intended to install;
- the signing certificate matches the fingerprint published with the official
  Cutlyra release.

Do not proceed if Android reports an unexpected package/signing conflict or if
the checksum/certificate does not match the release record.

## Updating a sideloaded copy

Android will install an update in place only when the package name and signing
identity match the installed app. Keep the permanent Cutlyra release key
unchanged across releases; otherwise Android treats the new APK as a different
signing identity and an in-place update is impossible.

## Privacy

Cutlyra has no account, advertising, analytics, telemetry, or cloud-sync
requirement in the v0.1 release model. Imported media and projects stay in
app-private/on-device storage unless you explicitly export or share an output.

For the current release process, signing, Play distribution, and verification
steps, see `docs/RELEASING.md` and `docs/PLAY_STORE_RELEASE.md`.
