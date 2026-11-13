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

## Isolated QA variant (app.cutlyra.editor.qa)

**Status:** PREPARED ONLY for physical POCO acceptance. The CI-managed API-35 emulator installed the QA APK beside the debug build and launched it successfully; the owner's POCO was not touched. No installation, uninstall, data clear, force-stop, settings change, media deletion, Play update, or Play closed-test change is authorized until the owner explicitly approves.

### Isolation proof (build-level)
- [ ] Application ID is `app.cutlyra.editor.qa`, distinct from production `app.cutlyra.editor`.
- [ ] App label is `Cutlyra QA`.
- [ ] FileProvider authority is `app.cutlyra.editor.qa.fileprovider`, distinct from production.
- [ ] APK is debug-signed with the standard Android debug keystore.
- [ ] Private app storage, database, media, cache, and FileProvider paths are package-scoped and are not shared with production.
- [ ] Production signing secrets, versionCode, AAB, and Play closed-test state are unchanged.

### Owner-authorized installation steps (after explicit approval only)
1. Confirm the production Cutlyra v0.1.0 installation and its data are backed up/recorded as needed.
2. Download the `cutlyra-qa-debug-apk` artifact from the qualified GitHub Actions run. The APK inside is `app-qa.apk`; the adjacent `.sha256` file records its checksum.
3. Verify the APK package ID (`app.cutlyra.editor.qa`), label (`Cutlyra QA`), provider authority (`app.cutlyra.editor.qa.fileprovider`), and Android Debug signature before installation.
4. With the device connected, install only with `adb -s <serial> install` for the QA APK; never use Gradle connected tasks on the physical device.
5. Launch `Cutlyra QA` and confirm it starts independently from production Cutlyra.
6. Do not uninstall, clear data, force-stop, or update the production app.

### Acceptance checklist for the isolated QA installation
- [ ] Fresh project creation.
- [ ] Import video and image.
- [ ] Multiple timeline clips.
- [ ] Filmstrip thumbnails.
- [ ] Portrait Fit/Fill.
- [ ] Rotate and Flip.
- [ ] Trim, Split and Speed.
- [ ] Replace Clip.
- [ ] Relink missing media.
- [ ] Replace with shorter source.
- [ ] Undo and Redo.
- [ ] Save and reopen.
- [ ] Backup and restore.
- [ ] Actual MP4 export.
- [ ] Audio/video synchronization.
- [ ] Background and foreground.
- [ ] Offline mode.
- [ ] Low-storage failures.
- [ ] Process-crash recovery.
- [ ] Proxy cache retention.
- [ ] Permission and picker behavior.
- [ ] UI clipping and navigation bars.
- [ ] Original source preservation.

For each case record setup, action, expected result, evidence, pass/fail criteria, and safe cleanup restricted to the QA installation. Destructive scenarios require explicit owner approval and must never touch production app data.

## POCO read-only discovery snapshot — 2026-11-11

**Device:** `22031116AI` / `evergo` / POCO M4 Pro 5G
**Android:** 13 (SDK 33), MIUI `V816`
**Build fingerprint:** `POCO/evergo_p_in/evergo:13/TP1A.220624.014/V816.0.1.0.TGBINXM:user/release-keys`
**Display:** 1080x2400, density 440
**Data storage:** 48G total, 37G used, 10G available (79% used)

Observed packages (read-only):
- `app.cutlyra.editor` — production, versionCode 1, versionName 0.1.0, installed by `com.android.vending`, last update 2026-10-31, different signature from QA
- `app.cutlyra.editor.qa` — an older QA installation already present, last update 2026-10-20; launcher resolves to `app.cutlyra.editor.qa/app.cutlyra.editor.FirstRunActivity`
- Additional pre-existing packages: `app.cutlyra.editor.rc`, `app.cutlyra.editor.rc2`, `app.cutlyra.editor.qa.test`

No install, uninstall, clear-data, force-stop, settings change, media deletion, Play update, or production modification was performed. The existing QA package must not be replaced until the owner approves installation of the qualified `app-qa.apk`.

### Validated merged-main artifact

- Workflow run: `43041318416`
- Artifact: `cutlyra-qa-debug-apk`
- File: `app-qa.apk`
- SHA-256: `43b0af87ee5c4b0d0a09be3addfce8468efd56eb5e23214c5ca561721689395b`
- Package: `app.cutlyra.editor.qa`
- Label: `Cutlyra QA`
- Provider: `app.cutlyra.editor.qa.fileprovider`
- Signing: `CN=Android Debug`

This artifact is distinct from production `app.cutlyra.editor`. Installing it can only target `app.cutlyra.editor.qa`; it cannot update the production package because the application IDs and signatures differ.

## Installation approval gate — STOP HERE

Before any installation, the owner must explicitly authorize **only**:

```text
adb -s CIUWEMJBPBDUWC7D install -r <validated>/app-qa.apk
```

Authorization for this command does **not** authorize uninstalling either app, clearing production data, replacing production signing, force-stopping production, changing Play Console, deleting user media, or changing device settings. Do not install merely because the APK exists or because earlier GitHub instructions were followed.

### 2026-11-11 approved install attempt — blocked by device

The owner approved the QA-only install. The exact command was attempted and MIUI rejected it:

```text
INSTALL_FAILED_USER_RESTRICTED: Install canceled by user
```

The device was awake but focused on another app. No package, data, media or setting changed. Production remained at version 0.1.0, last update 2026-10-31 11:54:46, signature `cf056b8b`. The older QA package remained at last update 2026-10-20 14:23:58, signature `837049eb`.

A second authorized retry at `2026-11-11T21:51:43+05:30` returned the same `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`; focus was still `com.projecttwo.app` and no MIUI installer dialog was focused. The owner must unlock the phone and allow the MIUI ADB-install prompt (or enable the developer-option USB install permission) before another retry. No settings were changed by the agent.

## Repeatable acceptance journeys (all NOT EXECUTED on the POCO)

Use one evidence folder per session, for example `poco-acceptance-<date>/`, with subfolders `screenshots/`, `logcat/`, `exports/`, `backups/`, and `notes/`. Capture `adb -s CIUWEMJBPBDUWC7D logcat` before and after each journey. Use media copied into the QA app's own picker selection only.

### 1. Fresh QA launch
- **Start:** QA package installed; production untouched; device online.
- **Actions:** Launch `app.cutlyra.editor.qa` only; wait for first-run UI; background and relaunch once.
- **Expected:** QA launcher displays `Cutlyra QA`; no crash; project list is empty or contains only QA projects.
- **Evidence:** screenshot of launcher label, first-run screen, `pidof app.cutlyra.editor.qa`, logcat.
- **Pass:** no FATAL EXCEPTION; production package not launched or modified.
- **Recovery:** force-stop QA only if necessary; never force-stop production.

### 2. Create and save project
- **Start:** QA app open.
- **Actions:** Create a new project; add a short clip; save; return to project list; reopen.
- **Expected:** Project saves and reopens with the same timeline.
- **Evidence:** screenshots before/after, project name, logcat.
- **Pass:** reopen restores clip and authored settings; no production project appears.
- **Recovery:** leave the QA project saved; do not clear QA data without separate approval.

### 3. Import multiple videos and images
- **Start:** QA project open; 2–3 test videos and 2 images available in the picker.
- **Actions:** Import multiple items; append them to the main track.
- **Expected:** All imports complete; clips appear on the main track; no overlay misclassification.
- **Evidence:** picker selection, import progress, timeline screenshot, logcat.
- **Pass:** all expected clips present; no crash; source files remain unchanged.
- **Recovery:** delete only QA timeline clips if needed; do not delete source media.

### 4. Filmstrip rendering
- **Start:** Timeline contains at least two video clips.
- **Actions:** Scroll and zoom the timeline; wait for filmstrip decoding.
- **Expected:** Real distinct frames render, not placeholders.
- **Evidence:** screenshots at two zoom levels; contact-sheet or frame captures if available.
- **Pass:** frames are distinct and match clip content.
- **Recovery:** return zoom to default; no data deletion.

### 5. Fit/Fill portrait and landscape
- **Start:** Project has a portrait 9:16 source and a landscape 16:9 source.
- **Actions:** Set canvas ratios; toggle Fit and Fill for mismatched clips; preview each.
- **Expected:** Fit preserves the whole frame with intentional bars; Fill crops to cover without unintended bars.
- **Evidence:** screenshots of each state and exported frame comparisons.
- **Pass:** preview matches authored framing; settings survive save/reopen.
- **Recovery:** reset framing to Fit; do not alter source media.

### 6. Rotation and horizontal/vertical flip
- **Start:** A video and an image clip are selected.
- **Actions:** Apply +90, -90, 180, flip H, flip V; undo and redo each action.
- **Expected:** One undo step per action; orientation updates in preview and survives save/reopen.
- **Evidence:** screenshots of each orientation; exported frames if available.
- **Pass:** preview and saved state agree; no unrelated edits lost.
- **Recovery:** undo to identity transform.

### 7. Split, trim and speed
- **Start:** A video clip is on the main track.
- **Actions:** Split at playhead; trim both edges; change speed; save/reopen.
- **Expected:** Non-destructive edits; source remains available; values persist.
- **Evidence:** before/after timeline screenshots; logcat.
- **Pass:** expected durations and speed values persist after reopen.
- **Recovery:** undo edits; keep QA project only.

### 8. Replace Clip
- **Start:** A video clip with trim/transform edits exists; a second video is available.
- **Actions:** Replace the clip; confirm replacement; undo; redo; save/reopen.
- **Expected:** Media changes while authored edits remain; single-step undo/redo; correct media reference after reopen.
- **Evidence:** before/after media IDs, timeline screenshots, logcat.
- **Pass:** replacement persists and no unrelated edits are lost.
- **Recovery:** undo replacement or discard only the QA project.

### 9. Missing-media relink
- **Start:** QA project references a clip whose local media is unavailable.
- **Actions:** Relink the clip to a valid local file; save/reopen.
- **Expected:** Missing state is explicit; relink updates the reference; project saves.
- **Evidence:** missing-media UI, relink picker, saved project screenshot.
- **Pass:** no silent loss; reopened project points at the relinked media.
- **Recovery:** cancel relink if the wrong file is chosen.

### 10. Shorter-source replacement/clamp
- **Start:** Clip has a duration longer than the replacement source.
- **Actions:** Replace with a shorter source; observe the clamp prompt; accept and cancel once each.
- **Expected:** Clear clamp warning; accept shortens clip and keeps edits; cancel leaves project unchanged.
- **Evidence:** prompt screenshot, before/after duration, logcat.
- **Pass:** no silent truncation; cancel is a no-op.
- **Recovery:** undo the accepted replacement.

### 11. Undo and Redo
- **Start:** Several edit kinds have been applied (trim, transform, replace).
- **Actions:** Undo each action in reverse order; redo each action.
- **Expected:** Each action is one undo step; redo restores the same state.
- **Evidence:** screenshots at each step; project save after redo.
- **Pass:** state matches the pre-undo authored state.
- **Recovery:** save a copy of the QA project before starting.

### 12. Project reopen
- **Start:** QA project saved with video, image, transform, trim and speed edits.
- **Actions:** Close project; reopen from project list; relaunch the app and reopen again.
- **Expected:** Timeline, media references and authored settings restore.
- **Evidence:** screenshots after each reopen; logcat.
- **Pass:** no missing media, no reset settings.
- **Recovery:** keep the project; do not clear QA data.

### 13. Real MP4 export with audio
- **Start:** Project has video and audible audio; export target known.
- **Actions:** Export MP4; wait for completion; play exported file; inspect audio/video sync and geometry.
- **Expected:** Playable MP4; expected resolution/framerate; audio present and synchronized.
- **Evidence:** export settings, exported MP4, media probe output, playback screenshot.
- **Pass:** file plays, duration is correct, audio is audible and in sync.
- **Recovery:** delete only QA export output.

### 14. Backup and restore
- **Start:** QA project has media and edits.
- **Actions:** Export QA project archive; create a second QA project; restore the archive; reopen.
- **Expected:** Project and media restore; production data untouched.
- **Evidence:** archive path, restore screenshots, logcat.
- **Pass:** restored project matches source; no production project appears.
- **Recovery:** delete only QA restore artifacts.

### 15. Airplane-mode editing
- **Start:** QA project and media already imported.
- **Actions:** Enable airplane mode (only with owner approval); edit, save, reopen, export locally.
- **Expected:** Editing and local export work without network.
- **Evidence:** airplane-mode indicator, edit/save/export screenshots.
- **Pass:** no network dependency; no crash.
- **Recovery:** disable airplane mode after the journey.

### 16. Background/foreground recovery
- **Start:** QA project has unsaved or pending edits.
- **Actions:** Home/background the QA app; return; wait; save.
- **Expected:** Edits remain or fail visibly; no false success.
- **Evidence:** before/after screenshots, logcat timestamps.
- **Pass:** consistent project state after return.
- **Recovery:** reopen QA and use undo if needed.

### 17. Low-storage warnings
- **Start:** Device reports limited free space; use a disposable QA project.
- **Actions:** Attempt import/export/backup until a storage failure is reached.
- **Expected:** Visible, actionable error; project left consistent; no partial success claimed.
- **Evidence:** free-space reading, error UI, logcat.
- **Pass:** failure is explicit and recoverable.
- **Recovery:** delete only disposable QA artifacts; do not delete user media.

### 18. Process restart recovery
- **Start:** QA project has a pending save/replacement; disposable QA project only.
- **Actions:** Terminate only the QA process with owner-approved tooling; relaunch; reopen.
- **Expected:** Correct media reference or explicit failure; no false success.
- **Evidence:** before/after project state, logcat, process death timing.
- **Pass:** consistent state after restart.
- **Recovery:** restore from QA backup if available.

### 19. Native proxy retention
- **Start:** Import a video that generates a proxy.
- **Actions:** Play, edit, close/reopen, inspect QA cache size over time.
- **Expected:** Proxy is retained while needed and cleaned safely; no orphan growth.
- **Evidence:** before/after cache sizes, logcat, screenshots.
- **Pass:** proxy is used and cleanup does not remove originals.
- **Recovery:** delete only QA cache if approved.

### 20. No interference with production app
- **Start:** Production Cutlyra v0.1.0 is installed and untouched.
- **Actions:** Before and after QA journeys, read production version, install time and data path; confirm production was not launched by QA flows.
- **Expected:** Production package, version, signature and data remain unchanged; QA and production coexist.
- **Evidence:** before/after `dumpsys package app.cutlyra.editor`, `pm path`, installed package list.
- **Pass:** production identity and timestamps are unchanged; QA provider authority is distinct.
- **Recovery:** stop the session and report any production change immediately.

---

## Physical acceptance run — POCO M4 Pro 5G (`app.cutlyra.editor.qa2`) — 2026-11-13

Resumed from the previous session's handoff after the desktop connection dropped. **No device command was replayed.** Every result below was executed in this or an earlier QA2 session on this device; no prior screenshot, export, clip or project was deleted or overwritten, and the verified export `qa-evidence/exported_video_audio.mp4` is untouched.

### Tested build and starting condition

| Field | Value |
| --- | --- |
| Device | POCO M4 Pro 5G (22031116AI), Android 13, MIUI V816 |
| ADB serial | CIUWEMJBPBDUWC7D |
| Package under test | `app.cutlyra.editor.qa2` |
| Installed APK | Predates PR #77 and PR #78. No APK was installed this session: reinstalling QA2 requires explicit owner approval. |
| `origin/main` at session start | `e553282da4814f727722c5f9519915c8c988601f` |
| Fixture | `1000216533.mp4` — colour bars, 1280x720, 30 fps, 12.000 s, H.264 + AAC 44.1 kHz mono |
| Project | Project 3, id `b21dbe45…`, one clip, `transform.scaleY = -1` |
| Earlier 5 s fixture | `1000218175.mp4` → `qa-evidence/exported_video_audio.mp4`: 1920x864, 25 fps, 5.000 s, AAC mono 44.1 kHz, mean −21.1 dB / max −17.2 dB (non-silent), no black first/last frame |

Project store unchanged from the handoff: 3 rows — Project 1 `cf5e6879…` (0:03), Project 2 `5803dae1…` (0:04), Project 3 `b21dbe45…` (0:12).

### Tally

| Result | Count |
| --- | --- |
| PASS | 17 |
| FAIL | 3 |
| NOT EXECUTED | 10 |

### Results

| # | Test | Result | Evidence |
| --- | --- | --- | --- |
| 1 | QA2 launches beside production and old QA | PASS | `qa-evidence/coll*.png` |
| 2 | Video import through Collections → From this device → Downloads | PASS | project 3 clip `1000216533.mp4` |
| 3 | Preview playback | PASS | `qa-evidence/` playback captures |
| 4 | Timeline duration 12.000 s / earlier 5.000 s | PASS | `metadata.duration 1440000` ticks |
| 5 | Real MP4 export with decoded audio | PASS | `qa-evidence/exported_video_audio.mp4` |
| 6 | Fit / Fill preview change | PASS | session captures |
| 7 | Rotation control state 0° → 90° → −90° | PASS (state only) | `qa-evidence/transform_rot90.png` |
| 8 | Flip H — control, preview, undo, redo, **exported-frame parity** | PASS | `exported_fliph.mp4`, `_probe/frames/fliph0.png`, `tr_state_{flip,undo,redo}.png` |
| 9 | Flip V — control, preview, **exported-frame parity** | PASS | `exported_flipv.mp4`, `_probe/frames/flipv0.png` |
| 10 | Replace clip with a longer source | PASS | `exported_replace_longer.mp4`, `replace_longer.mp4` |
| 11 | Shorter source raises the explicit clamp prompt | PASS | `replace_shorter.mp4` |
| 12 | Cancel at the clamp prompt leaves the project unchanged | PASS | `cancel*.png`, `cancel2.xml` |
| 13 | Accept-shorten → 4 s timeline and 4 s export, no black tail | PASS | `exported_shortened_4s.mp4` (610,048 B) |
| 14 | Undo / Redo of a replacement (single step, unrelated edits kept) | PASS | session captures |
| 15 | Save and reopen the project (durability) | PASS | see "Durability" below |
| 16 | Backup export, media bytes present | PASS | ZIP with 8/8 media entries hash-verified |
| 17 | Restore into a separate project | **FAIL** | `qa-evidence/DEFECT-restore-remap-overwrites-project.md` |
| 18 | Rotate +90° exported-frame parity | **FAIL** | `exported_rot90.mp4`, `_probe/frames/rot90.png` |
| 19 | Rotate −90° exported-frame parity | **FAIL** | `exported_rot-90.mp4`, `_probe/frames/rotm90.png` |
| 20 | Export-button hit-testing | PASS (no defect) | `phase7_export_rot.xml`, `preview_rot90_clean.png` |
| 21 | Audio continuity across transformed exports | PASS | `volumedetect` on baseline and flipV: mean −21.1 dB, max −17.2 dB (AAC LC 44.1 kHz mono) |

Flip parity was verified on an asymmetric fixture (six colour bars plus a diagonal and an orange marker), by decoding exported frames — not by watching a control toggle on a symmetric source.

### Durability (save and reopen)

Recorded before closing and again after reopening Project 3:

- `transform.scaleY = -1`, `scaleX = 1`, `rotate = 0` preserved exactly.
- Row `id` `b21dbe45…` equals the project `metadata.id`; still 3 rows.
- Clip `1000216533.mp4` present once, timeline `00:00 / 00:12`, `metadata.duration` 1440000 ticks.
- `mediaId` `91a7ef15-0fd6-4733-be07-a6c5e00177e2` unchanged.

**PASS** — the transform and clip linkage survive a full close/reopen.

### Backup and restore

- Backup export: **PASS**. The archive's 8 media entries were byte-checked (SHA-256) against the on-device sources; references were all present.
- Restore into a separate project: **FAIL**. The restore path overwrites the project record it is restoring next to. Recorded as a P1 in `qa-evidence/DEFECT-restore-remap-overwrites-project.md`; fix is PR #77 (`fix/restore-remap-clobber`, `1709f3a`), green on all seven CI jobs.
- This FAIL is a property of the **installed APK**, which predates that fix. Restore must be re-executed on a QA2 build that contains PR #77 before it can be called PASS; that needs an owner-approved reinstall, so it is **NOT EXECUTED** for this build.

### Transformation parity (exported frames)

| Transform | Direction / geometry | Exported frame | Result |
| --- | --- | --- | --- |
| Flip H | Left/right mirror, diagonal preserved | `_probe/frames/fliph0.png` — exact mirror of `base0.png`, content bbox 1271x716, ar 1.775 | PASS |
| Flip V | Top/bottom mirror, geometry intact | `_probe/frames/flipv0.png` — bars unchanged, diagonal flipped, checkerboard moved to top | PASS |
| Rotate +90° | Bars horizontal R,G,Y,B,M,C top→bottom; diagonal top-right→bottom-left | `_probe/frames/rot90.png` — direction correct, but content fills 1264x720 (ar 1.756) | **FAIL** (aspect) |
| Rotate −90° | Bars horizontal C,M,B,Y,G,R top→bottom; diagonal bottom-left→top-right | `_probe/frames/rotm90.png` — direction correct, same stretch | **FAIL** (aspect) |

Both rotations turn the picture the right way; neither preserves aspect. The preview does not match the export for these two cases: after +90° the preview shows an aspect-correct portrait footprint, cropped (content ≈566x570 device px, no red/cyan bands — `qa-evidence/preview_rot90_crop.png`), while the export smears all six bars across the full landscape width.

Direction proof is coordinate-based, not eyeballed: the orange source marker at pixel (335,540) of the 1280x720 fixture lands at ≈(319,188) in the export, matching the plain-NDC-rotation prediction (320,188) and not the pixel-space prediction (460,55).

### Export-button hit-testing

- Visible DOM rect for `Export video`: CSS `[16,779,361,43]` → device centre (540,2297).
- Accessibility node bounds: `[44,2235][1036,2304]` — clipped ≈36 CSS px above the true sheet bottom (2356) by the bottom system-gesture inset.
- With the current layout, single centre taps started an export **3/3** in this session (`Cutlyra-be5f186b…`, `Cutlyra-d1618ac9…`, `Cutlyra-ea04b00d…`), and the overlay showed "Exporting — encoding NN% / Cancel" each time.
- **No reproducible hit-test defect.** The earlier multi-tap symptom is consistent with stale bounds after a sheet resize, not a touch-target bug. No CSS, layout or Android navigation setting was changed for this.

### Defects found

| Severity | Defect | Reproduction | Code path | Fix |
| --- | --- | --- | --- | --- |
| P1 | Restore overwrites an existing project record, losing its clips | Back up a project, restore the archive while the source project still exists, reopen → the restored record replaces the existing one | `packages/editor-core/src/services/storage/indexeddb-adapter.ts` | PR #77 (`1709f3a`) — 7/7 CI jobs pass |
| P1 | Rotate ±90° stretches a non-square canvas instead of rotating it | 1280x720 clip → Transform → Rotate R → Export → decode any frame: bars fill the full 1280x720 width with no portrait footprint | `apps/mobile/android/app/src/main/java/app/cutlyra/editor/export/EdlTransformEffect.kt` `matrixFor` (NDC rotation without canvas-aspect conjugation) | PR #78 (`fix/export-rotation-aspect`, `09875a8`) — `matrixValues()` conjugates by `h/w`; 98 JVM unit tests pass, 8 new |

Why CI missed the rotation defect: `ExportTransformParityInstrumentedTest` uses square sources **and** square canvases, where a bare NDC rotation and a pixel-space rotation are identical.

### Not executed (and why)

1. Restore PASS on a build containing PR #77 — needs an owner-approved QA2 reinstall.
2. Re-export of Rotate ±90° on a build containing PR #78 — same reason.
3. Missing-media relink — no genuinely missing-media fixture was created (that would require moving or deleting a source file).
4. Airplane-mode editing — would change a system setting.
5. Low-storage / quota-pressure behaviour — deliberately disruptive; requires separate approval.
6. Background/foreground during a pending replacement save — would need a timed mid-save interruption.
7. Process-kill recovery during a pending save — out of scope for a non-destructive session.
8. Native proxy retention and cache growth over time — needs a multi-session observation window.
9. Image clip import in a replacement project — not exercised this run.
10. Multi-clip projects (>1 clip) — all durability and transform evidence above is single-clip.

### Safety confirmation

- Production `app.cutlyra.editor` untouched: last update time 2026-10-31 11:54:46, unchanged; never launched.
- Old QA `app.cutlyra.editor.qa` untouched: last update time 2026-10-20 14:23:58, unchanged.
- QA2 was not reinstalled, uninstalled, cleared or force-stopped; no device settings, Play Console state, signing config, `versionCode` or R8 config changed.
- Device media, clips and the previously verified export are intact; the media picker was driven through Collections → From this device → Downloads throughout.

### Next engineering priority

1. Merge PR #77 (restore) and PR #78 (rotation) after their CI is green, then cut a QA2 APK from merged main and get owner approval to install it — that single reinstall unblocks both FAIL items and their re-verification.
2. After reinstall: re-run restore-into-separate-project and ±90° export parity on the POCO, comparing the exported marker position against (460,55) for +90°.
3. Then close the coverage gap the square-canvas parity suite leaves: add a non-square canvas case to `ExportTransformParityInstrumentedTest` (16:9 source, 90°, assert the portrait footprint and the marker's expected pixel).
4. Add a UI-level preview/export parity assertion for rotations, so the preview's correct footprint becomes the reference the export is checked against.
5. Only then resume the not-executed group (missing-media relink first, storage pressure last).
