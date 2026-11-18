# QA3 physical acceptance — POCO M4 Pro 5G — 2026-11-18

## Environment

| Item | Value |
|---|---|
| Device | POCO M4 Pro 5G (`22031116AI`, `evergo_p_in`), serial `CIUWEMJBPBDUWC7D` |
| OS | Android 13 (API 33), MIUI V816 |
| Package under test | `app.cutlyra.editor.qa3` |
| Version | versionName `0.1.1`, versionCode `2` |
| Installed at | 2026-11-18 20:03:45 (first install) |
| APK | `qa3-artifacts/run-43841922109/app-qa3.apk`, 127,971,836 bytes |
| APK SHA-256 | `c68af3bb4baabc4e115ec3d059751468d7e213ad08eddb88eee61cd6d0a3544f` (match, verified pre-install) |
| Signer | `CN=Cutlyra QA3, O=Cutlyra, C=IN`, SHA-256 `13457361f9f405147c8ada63de9c4ee876816383f403ffab9afd29324ce2f7cf` |
| Build source | run `43841922109` on `40ce2bf` (qualified QA3 artifact, not regenerated) |

### Installation

First attempt returned `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`
(MIUI "Install via USB" gate on this ROM). Device was awake and unlocked, so the
gate — not the lock screen — was the cause. After the owner approved the on-device
prompt, the identical APK installed with exit 0. No settings were changed and no
credential was touched.

### Which directory is `1000218593.mp4`

Imported media is copied into the app's private project storage and renamed to a
numeric display name. It is the pushed test clip, not user media.

## Other Cutlyra installs — unchanged

Baseline captured before install, re-checked after. All still present, all still
at their previous versionName, none reinstalled or cleared:

| Package | versionName | versionCode |
|---|---|---|
| `app.cutlyra.editor` (production) | 0.1.0 | 1 |
| `app.cutlyra.editor.qa` | 0.1.0 | 1 |
| `app.cutlyra.editor.qa2` | 0.1.0 | 1 |
| `app.cutlyra.editor.rc` | 0.1.0 | 1 |
| `app.cutlyra.editor.rc2` | 0.1.0 | 1 |
| `app.cutlyra.editor.qa.test` | (test package) | 0 |
| `app.cutlyra.editor.qa3` | **0.1.1** | **2** |

## Test media (pushed, additive, nothing overwritten)

New folder `/sdcard/Download/qa3-test/` (did not exist before):

- `clipA-landscape.mp4` — 1280×720, 6 s, AAC 440 Hz tone
- `clipB-portrait.mp4` — 720×1280, 5 s, AAC 660 Hz tone
- `photo1.png` — 1080×1440
- `music.m4a` — 8 s AAC (not imported; bundled "Soft Chime" used for the audio lane)

## Matrix

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | Timeline lane ordering + duplication | **PASS** | `09`, `12`, `16`, `42` |
| 2 | Touch drag / resize / pinch | **PARTIAL** | `44`, `49` (drag works; trim + pinch not automatable) |
| 3 | Rotation / Fit-Fill / export geometry | **PARTIAL (fit + geometry PASS)** | `49`, `26`, export probe |
| 4 | Replace Clip + undo/redo | **PARTIAL (undo/redo PASS; Replace Clip BLOCKED)** | `13`, `14`, `15` |
| 5 | Filmstrip thumbnails | **PASS** | `10` |
| 6 | Video export with audio | **PASS** | `export-720p-2021.mp4`, `25`, `26` |
| 7 | Project save / reopen | **PASS** | `28`, `41`, `42` |
| 8 | Backup + restore (non-destructive) | **PASS** | `37`, `40`, `41` |

### 1. Lane ordering and duplication — PASS

- Import order: portrait clip then landscape clip; total duration `00:11` = 6 s + 5 s, so both
  clips landed on the primary video track in import order (`09`).
- `Duplicate` placed the copy on the overlay lane directly beneath the primary lane, with the
  derived label `1000218593.mp4 (copy)` (`12`). Undo removed it (`13`); redo restored it
  (`14`, `15`).
- Adding audio with `Audio → Soft Chime` created an audio lane below the overlay lane (`16`).
- Lane order top→bottom is consistently **video → overlay → audio**, with audio drawn last and
  never reordered above video. No clip duplication appeared that was not explicitly requested.

### 2. Touch drag / resize / pinch — PARTIAL

- Timeline horizontal drag works: `input touchscreen swipe` on the clip lane pans the ruler and
  settles without overshoot or jump-back (`44`, `49`). Tapping a clip did not move or duplicate
  anything as a side effect of a drag.
- NOT VERIFIED: clip trim-handle resize. Handles are rendered (`44`/`49` show the rounded edge
  handle on the selected clip) but synthetic pointer sequences did not engage them.
- NOT VERIFIED: pinch (multi-touch). `adb shell input` can only synthesize a single pointer; no
  pinch could be generated.
- These two need the owner's fingers. Procedure: select a clip, drag its right edge ~1 s inward
  (duration must drop from `00:11`), then two-finger pinch on the timeline to zoom, and confirm
  the timeline does not jump or leave a gap.

### 3. Rotation / Fit-Fill / export geometry — PARTIAL

- Canvas is portrait for this project, and the timeline mixes a portrait and a landscape clip —
  the case the fix targeted.
- Fit behaviour is consistent: the landscape clip is letterboxed inside the portrait canvas in
  the preview (`49`) and the exported frame at 7 s shows the identical letterbox (`26`). The
  portrait clip fills the canvas in both (`45`, `25`).
- Export geometry: 1280×720 stored with `rotation=-90`, i.e. it displays as portrait 720×1280,
  matching the preview. 30 fps, 330 frames, 11.000 s.
- NOT TESTED: physical device rotation (portrait↔landscape). That changes a phone setting and was
  not authorized, so inset/layout behaviour while rotated is unverified.
- NOTE / RISK: portrait output is expressed as landscape pixel dimensions plus a rotation matrix
  rather than portrait-encoded pixels. Players, WhatsApp-style forwarders, and some uploaders
  ignore the matrix and would show the video sideways. Worth confirming against the store
  audience before production.

### 4. Replace Clip + undo/redo — PARTIAL

- Undo/redo is correct and scoped: undo reverted only the duplicate, leaving both imported clips
  and the audio lane intact; redo restored exactly one copy. Undo/redo buttons enable/disable
  consistently with history depth (`13`, `14`, `15`).
- Replace Clip NOT VERIFIED: the action needs a selected timeline clip, and clip selection by
  synthetic tap did not register reliably in the WebView (the panel answered
  "Select an element on the timeline first"). Underlying selection logic did work earlier in the
  session, so this is an automation limit, not a reproduced defect.

### 5. Filmstrip thumbnails — PASS

`10` is a 1:1 crop of the video track: real decoded frames (colour bars, diagonal sweep, moving
texture), contiguous across both clips, with segment tick marks and no placeholder or blank
tiles. Thumbnails survived panning and reopening (`42`).

### 6. Video export with audio — PASS

`Export → 720p / 30 fps / High`:

- Output `Movies/Cutlyra/Cutlyra-67b581cf-….mp4`, 5,891,471 bytes,
  SHA-256 `ee799fd92a5947d489800181a49fec18431fd1af9346ee85220c942074c4b453`
- Video: H.264, 1280×720, rotation −90, 30/1 fps, 330 frames, 11.000 s
- Audio: AAC, 44.1 kHz, mono, 11.016 s
- Audio is genuinely present and loud: `mean_volume -16.1 dB`, `max_volume -3.0 dB` (silent
  audio would read ≈ −91 dB)
- Duration, frame count and audio length all match the 11 s timeline; no truncation, no
  watermark, no export error dialog. A second identical export produced the same 5,891,471 bytes.

### 7. Save / reopen — PASS

- Closing the editor with `X` committed the project; the Projects screen showed `Project 1`,
  `0:11`, dated 18/11/2026 (`28`).
- Reopening restored the full state: both video lanes, the audio lane, the `(copy)` overlay and
  the `00:11` duration, with undo history back at its base (`42`).
- A second kill/relaunch cycle after restore behaved identically.

### 8. Backup and restore, non-destructive — PASS

- `Backup & restore → Back up` wrote
  `/sdcard/Download/qa3-test/Project 1 backup 2026-11-18.cutlyra-backup` (3,218,095 bytes), with
  the on-screen confirmation that existing projects were not touched (`37`).
- `Restore archive…` on that same archive produced the message
  **"Restored as a NEW project with a fresh ID — your existing projects were left untouched."**
  (`40`). The Projects screen then held **two** cards (`41`), both `0:11`.
- The restored copy opened with all three lanes and the correct duration (`42`), so the archive
  round-trips media and edits, not just metadata.
- Only disposable QA3 projects were involved. No existing project, media file, or other Cutlyra
  install was overwritten or deleted.

## Observations (not defects)

- After restore, both projects are named `Project 1`, since the restored copy keeps the source
  name. With several backups this becomes ambiguous; a `(restored)` suffix would help.
- Project cards showed a play-icon placeholder until the project was opened once, then the real
  thumbnail appeared.
- Clip labels use the imported numeric display name, which reads oddly next to a user's own
  filenames.

## Additional measurements — same session, after the matrix

### Timeline pan responsiveness (complaint A: "pause/trim/crop lag")

Method: launch QA3 (non-destructive; the app restored the existing project), then
`adb shell dumpsys gfxinfo app.cutlyra.editor.qa3 reset`, eight
`input touchscreen swipe 950 1700 450 1700 400` pans on the clip lane, then
`dumpsys gfxinfo`. Raw output: `_gfxinfo-pan.txt`.

| Metric | Value |
|---|---|
| Frames rendered | 53 |
| Janky frames | 0 (0.00%) |
| p50 / p90 / p95 / p99 frame time | 13 ms / 13 ms / 13 ms / 13 ms |
| Missed vsync | 0 |
| Slow UI thread | 0 |
| Slow issue draw commands | 0 |
| Frame deadline missed | 0 |

Honest reading: **panning is smooth on this device** — no jank and every rendered
frame inside the 16.7 ms 60 Hz budget. Two limits on that claim:

- Cutlyra's preview loop skips rendering when neither the frame index nor the render
tree changed, so 53 frames is rendered work, not display cadence. This is not a
sustained-fps number.
- It measures **panning only**. Trim-drag responsiveness, seek latency after a ruler
tap, and thumbnail-generation overhead were **not** measured, so "lag" reports on
those paths are neither confirmed nor refuted here.

### Gesture banking defect found from this evidence (fixed in PR #89)

Reviewing the pointer path against the PARTIAL row 2 result found a real defect that
synthetic one-finger input cannot reach: below the 6 px drag-slop threshold the
preview is withheld, but a second finger landing still banked the withheld delta, so
the next real move jumped the element by an amount the user never saw. Fixed in
`fix(preview): stop banking drag movement that was never shown` (PR #89) with five
unit regressions driving the production gesture functions.

**Row 2 stays PARTIAL.** A source-level fix plus deterministic tests do not replace
two fingers on this phone, and this session could not inject a second pointer.

## Not performed (deliberately)

- No uninstall, no `pm clear`, no data wipe of any package.
- No changes to production, QA, QA2, RC or RC2.
- No phone setting changed (rotation, install policy, developer options untouched).
- No destructive testing (overwrite-restore, delete, process-kill/relaunch-loop) — needs separate
  authorization.
- No Play Console action.
- No uninstall/reinstall for the gfxinfo measurement: the already-installed QA3 was
  relaunched and the existing project reused.
