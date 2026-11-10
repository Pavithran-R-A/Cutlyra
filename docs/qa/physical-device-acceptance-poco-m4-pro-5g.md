# Physical-device acceptance checklist — POCO M4 Pro 5G (prepared, not executed)

**Status:** PREPARED ONLY. Not executed in this environment (no physical POCO M4 Pro 5G / Play Console access). Owner must run on device and record evidence (screen recording, exported MP4s, logcat as needed).

**Scope relevant to PR #66 (#22 canvas fit/fill framing):** portrait framing correctness, Fit/Fill behavior, preview↔export parity, edge-to-edge/system bars on Android 15/16, and save/reopen/undo sanity.

## Device / environment
- [ ] POCO M4 Pro 5G, record exact Android version (target Android 15 and/or Android 16 behavior as available), build fingerprint, display size/density, and Cutlyra build SHA/versionCode.
- [ ] Verify app installs/launches cleanly; note any OEM-specific permission or media picker behavior.

## Edge-to-edge / system bars (Android 15/16)
- [ ] Editor, project list, panels, export sheet, and preview do not clip under status/navigation/gesture bars; touch targets remain reachable.
- [ ] Rotation (if supported) and display cutout/inset handling do not obscure timeline controls, playhead, or Fit/Fill controls.
- [ ] Keyboard/open sheets do not hide critical actions.

## Canvas ratio + framing (#22)
- [ ] Import a portrait (9:16) clip: project/canvas adoption behaves as expected; no silent aspect-ratio overwrite of existing projects.
- [ ] Set canvas to 9:16, 16:9, 1:1; confirm preview updates and authored settings survive save/reopen.
- [ ] For a main-track video/image with mismatched canvas: **Fit** preserves the whole frame with understandable background/letterbox treatment; **Fill** crops intentionally to cover the canvas.
- [ ] Preview framing matches exported result (same clip, same ratio, Fit vs Fill). Capture exported MP4s and inspect frames/edges (no unexpected bars for Fill; bars/background only where Fit intends).
- [ ] Reposition/transform (where supported) behaves understandably with Fit/Fill; no hidden cropping surprises beyond authored framing.
- [ ] Undo/redo restores framing changes; backup/restore preserves framing settings.

## Regression sanity
- [ ] Portrait→portrait, portrait→landscape, landscape→portrait cases (Fit and Fill where applicable).
- [ ] Transitions, overlays, and text alignment remain visually correct with framing changes.
- [ ] Export completes; output geometry is exact for selected resolution; playback is smooth and audio/video sync is sane.

## Evidence to attach
- [ ] Device info, build SHA (`1c351be` or later PR/final head), screenshots/recording, exported sample MP4s for Fit and Fill mismatch cases, and pass/fail notes per item.

## Replace Clip / Relink / durability acceptance (PR #72 + corrective save/backup work)

### Scope
- Applies to video and image clips only. Audio clips and cross-type replacement are not supported.
- Record Android version actually installed on the POCO M4 Pro 5G (do not assume Android 15/16). Read it from Settings → About phone before testing.

### CI-emulator-covered (already automated)
- [ ] `ReplaceClipMediaCommand` persistence race suites (31 focused tests) and backup-service archive tests.
- [ ] Save/backup durability gates: `saveCurrentProject()` and `buildExportRecipe()` wait for pending media transactions and fail closed.
- [ ] Android API 35 instrumentation 61/61 and R8 variant 61/61.

### Physical-device required
- [ ] Import a video and an image; note their media IDs.
- [ ] Replace a video clip with a longer source; verify duration/trim and other edits remain.
- [ ] Replace with a shorter source and confirm the explicit clamp prompt; verify clip shortened and edits retained.
- [ ] Cancel a replacement at picker and at clamp prompt; verify project byte-for-byte unchanged.
- [ ] Relink a missing-media clip; verify media ID changes and project saves.
- [ ] Undo and Redo a replacement; verify single undo step and no unrelated edits lost.
- [ ] Close and reopen project; verify correct media reference and no missing media.
- [ ] Export after replacement; verify output playable and references correct media.
- [ ] Backup and restore after replacement; verify media bytes and references restored.
- [ ] Offline usage: airplane mode; replacement/import/export/backup flows behave without network.
- [ ] Low available storage: trigger quota pressure; verify failure is visible, clip left unchanged, no partial save.
- [ ] Background/foreground: app backgrounded during replacement save; verify completion or safe failure on return.
- [ ] App process termination and relaunch: kill app during pending replacement save; verify reopen resolves correct media or reports failure; no false success.
- [ ] Native proxy cache behavior: verify proxy generated/used; no orphan growth or unsafe deletion.
- [ ] Original media preservation: source media remains available; no user-selected source deleted.
- [ ] No unrelated edits lost: rotate/trim/params survive replacement and save.

### Evidence to capture
- [ ] Screenshots before/after, relevant logcat, before/after media IDs, exported MP4s, backup archive, free-space measurements, and pass/fail notes per item.
- [ ] Do not uninstall the owner's app, clear app data, alter Play closed test, change versionCode, or upload AAB during this acceptance.
