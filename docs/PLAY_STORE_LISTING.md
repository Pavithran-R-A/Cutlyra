# Cutlyra — Google Play listing draft

## Store details

**App name:** Cutlyra

**Suggested category:** Video Players & Editors

**Short description:**  
Offline video editor with captions, effects, keyframes and no watermark.

## Full description

Cutlyra is a private, offline-first mobile video editor built for editing on
your phone without an account, ads, subscriptions, telemetry, or a watermark.

Import your own videos, photos, and audio, edit them on a touch-friendly
timeline, and export the finished video directly on your device.

What you can do:
- Create and reopen local editing projects
- Import video, photos, and audio with Android system pickers
- Capture media from the camera when you choose
- Trim, split, delete, duplicate, undo, and redo timeline edits
- Add text and on-device captions
- Work with transitions, effects, transforms, keyframes, and audio controls
- Preview edits and export video locally
- Keep projects and media on-device

Privacy by design:
- No account or sign-in
- No ads
- No analytics or telemetry
- No cloud sync
- No broad photo-library permission
- Android cloud backup disabled for Cutlyra project/media data

Cutlyra is open-source software. Editing and export are designed to work
locally on the device.

Device codec/GPU capabilities can affect which media can be decoded or exported
successfully.

## Play Console setup draft

- App or game: App
- Free or paid: Free
- Contains ads: No
- App access: All functionality available without special access
- Account creation: No
- Primary purpose: Video editing / creative tool
- Target audience: General audience; not specifically designed for children
- Privacy policy: use the public Cutlyra privacy URL
- Support email: HUMAN INPUT — real verified contact required
- Website: optional; use the public Cutlyra site once deployed

## Required Play graphics

Google Play currently requires these assets for a phone/tablet store listing:

- **Store icon:** 512×512 PNG, max 1024 KB. Cutlyra's canonical source is
  `assets/brand/icon-only.png` (1024×1024); export a 512×512 store copy from
  that source rather than using a launcher-density raster.
- **Feature graphic:** 1024×500 JPEG or 24-bit PNG with no alpha. This is a
  store-marketing asset and must be created from Cutlyra's own brand/UI; do not
  reuse inherited OpenCut art.
- **Screenshots:** at least 2 are required. For strong Play recommendation
  eligibility, prepare at least 4 phone screenshots at 1080px or higher in
  9:16 portrait or 16:9 landscape. Screenshots must show the actual submitted
  app experience.

The older QA captures under `docs/screenshots/` are evidence/reference only.
The final store screenshots should be recaptured from the final Play-delivered
candidate so UI, permissions, version, and behavior match what reviewers/users
receive.

## Final screenshot plan

Capture from the final Play candidate:
1. Projects home — "Your edits stay on your device"
2. Timeline/editor — "Touch-first timeline editing"
3. Text/captions — "Create captions on-device"
4. Effects/keyframes — "Fine control without cloud processing"
5. Export/result — "Export locally with no watermark"

Keep any added tagline subordinate to the actual UI and avoid rankings,
testimonials, price claims, or download/install calls to action.

## Release notes

Cutlyra 0.1.0 — first Android release

- Offline-first mobile video editing
- Local project storage and media import
- Touch timeline editing, captions, effects and keyframes
- On-device video export
- No account, ads, telemetry or watermark
