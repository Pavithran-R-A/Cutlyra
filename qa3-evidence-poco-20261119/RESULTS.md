# QA3 physical acceptance — POCO M4 Pro 5G — 2026-11-19 (Alpha candidate `aa11372`)

This is the second physical session and the first one on the **alpha candidate build**. It
covers the in-place update of the installed QA3 and re-runs the acceptance cases on that new
build. The 2026-11-18 session in `qa3-evidence-poco-20261118/` is unchanged and still stands
for the older `40ce2bf` build; do not merge the two sets of results.

## Environment

| Item | Value |
|---|---|
| Device | POCO M4 Pro 5G (`22031116AI`, `evergo_p_in`), serial `CIUWEMJBPBDUWC7D` |
| OS | Android 13 (API 33), MIUI V816 |
| Package under test | `app.cutlyra.editor.qa3` |
| Version | versionName `0.1.1`, versionCode `2` |
| Build source | `aa11372b371d7df5346c78e119e68270f3a008ca` (run `44530886713`) |
| APK | `qa3-artifacts/run-44530886713/app-qa3.apk`, 127,971,968 bytes |
| APK SHA-256 | `be1622ceac078f4b6c4ee50d9f584a48ea758612c6b8793fa627b9512f31e52f` |
| Signer | `CN=Cutlyra QA3, O=Cutlyra, C=IN`, SHA-256 `13457361f9f405147c8ada63de9c4ee876816383f403ffab9afd29324ce2f7cf` |
| Install type | in-place update of the existing QA3 (`adb install -r`), no uninstall, no data clear |
| Previous install | vc2 from run `43841922109` (`40ce2bf`), `c68af3bb…544f`, installed 2026-11-18 20:03:45 |

Full preflight and post-install data: `PREFLIGHT-INSTALL.txt`, `PRE-INSTALL-STATE.txt`,
`POST-INSTALL-STATE.txt`.

## Install outcome

The update went in over the existing package and the app came up on the same data:

- `firstInstallTime` unchanged (2026-11-18 20:03:45), `lastUpdateTime` 2026-11-19 20:57:50 —
  an update, not a reinstall.
- On-device `base.apk` pulled back and hashed: **`be1622ce…e52f`**, byte-identical to the
  artifact; on-device signer `13457361…f7cf`, identical to the pinned QA3 fingerprint.
- Project storage was byte-for-byte untouched by the install (same sizes and mtimes for
  every IndexedDB file), and the Projects screen listed both pre-existing projects.
- Two attempts of the same command first returned
  `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user` — MIUI's USB-install approval
  gate. The identical APK installed with `Success` once the approval landed. No uninstall, no
  `pm clear`, no signature bypass, no device setting changed.

## Matrix

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | In-place update + existing projects preserved and accessible | **PASS** | `PREFLIGHT-INSTALL.txt`, `01`, `02` |
| 2 | Trim-handle resize with stable release geometry | **PARTIAL** | `05-handle-zoom`, `06-trim-handle-drag` |
| 3 | Two-finger pinch, drag and finger-lift (PR #89) | **BLOCKED** | none — needs two real fingers |
| 4 | Replace Clip, Undo, Redo | **PASS** | `27`, `28`, `29`, `30`, `31`, `32` |
| 5 | Clip rotation ±90 / 180 and horizontal/vertical flip | **PASS** | `21`, `22`, `23`, `24` |
| 6 | Fit geometry and preview/export parity | **PASS** | `41`, `42`, `37`, `38`, `export-720p-postreplace.mp4` |
| 7 | Fill (crop) mode distinct from Fit | **BLOCKED** | none — no Fill control exposed in the shipped panels |
| 8 | 720p export with audio | **PASS** | `export-720p-postreplace.mp4`, `36` |
| 9 | Save and reopen after edits | **PASS** | `44`, `45` |

### 1. In-place update, projects preserved — PASS

Both projects created in the 2026-11-18 session were present after the update and both opened
with their full state: `01` shows the two `Project 1` cards (`0:11`), `02` shows the editor
reopened with the overlay `(copy)` clip, the `Soft Chime` audio lane and `00:11`.
`lastUpdateTime` moved and `firstInstallTime` did not, which is the platform's own proof that
this was an update over existing data rather than a replacement.

### 2. Trim-handle resize — PARTIAL

The handle is rendered and its geometry was located precisely (`05-handle-zoom` is a 2× crop
of the selected clip's left edge: the white rounded cap spans roughly x 674–692 at 1080 px
wide). A slow 1200 ms drag started exactly on that handle did **not** grab it: the timeline
panned and the playhead moved to `00:01` (`06-trim-handle-drag`), and the clip duration stayed
`00:11`. This is the same limit the previous session recorded — synthetic single-pointer
input is not accepted by the handle's gesture path.

So the two things the case is really about are still unproven on hardware:

- whether the edge tracks the finger without a jump on first movement, and
- whether the release position matches what was displayed (no gap or overlap).

Owner step to close it: select a clip, drag the **left** handle ~1.5 s to the right and
release, then the **right** handle ~1.5 s to the left. Expected: both edges follow the finger
from the first pixel with no jump, the clip's duration label matches the visible length, the
neighbouring clip does not move, and playback across the new in/out points still works. Record
the whole gesture; a screenshot of the timeline right after release is the second piece.

### 3. Two-finger pinch, drag and finger-lift (#89) — BLOCKED

`adb shell input` can only synthesize a single pointer; it cannot place two contacts on the
touchscreen, so the exact defect PR #89 fixed — movement banked while the preview is below the
drag slop, released as a jump when the second finger joins or leaves — cannot be reproduced or
cleared from here. Nothing in this session should be read as a device verification of #89. It
stays proven by `preview-gesture.test.ts` and the 61 instrumentation tests only.

Owner step to close it: on the preview, put one finger down and hold still (under ~6 px), then
land a second finger and keep pinching; then do the reverse — start a two-finger pinch, lift
one finger, and keep panning with the one that remains. Expected: the picture never jumps at
the moment the second finger lands or the first one leaves, and the surviving finger pans from
where the content already is. Any jump of a distance you never dragged is the #89 failure.

### 4. Replace Clip, Undo, Redo — PASS

Replace Clip opened the system photo picker (`27`), a different source was chosen from the
normal on-screen UI (the 5 s portrait clip, against the 6 s landscape original), and the app
confirmed `Clip media replaced and saved.` with the clip label updated and the timeline still
`00:11` — the clamp held, nothing collapsed and no other clip changed (`30`). Undo restored
the original media (`31`, label back to `1000218593.mp4 (copy)`); Redo restored the
replacement (`32`). Both directions moved only the one clip.

One honest limitation on this row: the export taken afterwards is **byte-identical** to the
previous session's export of the same project (`ee799fd9…b453`, 5,891,471 bytes). The overlay
lane's visibility control read `Off` throughout this session and a synthetic tap on it did not
toggle it (`39`, `40`), so the replaced clip was not contributing to the render and the
identical bytes are the expected outcome — not evidence that Replace Clip is inert. Whether
the replacement changes the picture when that lane is visible still needs a human eye.

### 5. Rotation and flip — PASS

With a clip selected, the Transform row stepped `0° → −90° → 0° → 90°` as read back from the
panel after each tap (`21`, `22`), and horizontal and vertical flips applied with the preview
following (`23`, `24`). Geometry stayed correct at each state — the rotated frames were
rotated, not stretched — and the value was returned to `0°` with both flips off before the
export, so the export row is not measuring a transform.

### 6. Fit geometry and preview/export parity — PASS

The project mixes a portrait canvas with a landscape clip. In the preview the landscape clip
is letterboxed inside the portrait canvas with black above and below, and the exported file at
the same point in the timeline shows the identical letterbox — same content, same placement
(`41` preview at `00:07`, `42` the export's corresponding frame). `37`/`38` are the 1 s and 7 s
export frames: the portrait segment fills the frame and the landscape segment is letterboxed,
which is the Fit behaviour working in the render as well as the preview.

### 7. Fill (crop) mode — BLOCKED

Fit and Fill are supposed to differ: Fit letterboxes, Fill crops. Fit is proven above. A
distinct Fill control was not found in any panel this build exposes — the bottom navigation
carries `Edit, Audio, Text, Overlay, Filters, Adjust, Captions` and, once scrolled,
`Stickers, Transcript, Aspect ratio, Background, Template`; `Edit` and `Adjust` were both
opened and enumerated (`Edit: Split, Duplicate, Delete, Cut gaps, Replace, Speed, Volume,
Transform`; `Adjust: Brightness, Contrast, Saturation, Sharpen, Temperature, Tint, Vignette`),
and `Aspect ratio` only changes the canvas frame (`43`). So Fill was not exercised rather than
failed.

Owner step to close it: select a landscape clip on a portrait canvas and toggle the
fit/fill control in the preview area, then compare. Only claim PASS if the two states visibly
differ (letterbox vs crop) and the exported file matches whichever state was active.

### 8. 720p export with audio — PASS

`Export → 720p / 30 fps / High` produced `Movies/Cutlyra/Cutlyra-88f20175-…mp4`:

| Property | Value |
|---|---|
| Bytes | 5,891,471 |
| SHA-256 | `ee799fd92a5947d489800181a49fec18431fd1af9346ee85220c942074c4b453` |
| Video | H.264 1280×720, rotation −90 (displays 720×1280 portrait), 30/1 fps, 330 frames |
| Duration | 11.016 s (matches the `00:11` timeline) |
| Audio | AAC 44.1 kHz mono, mean −16.1 dB, max −3.0 dB — real audio, not a silent track |

No crash, no export error, no watermark. The app reported
`Saved to Gallery — Movies/Cutlyra` (`36`). A copy is kept here as
`export-720p-postreplace.mp4`.

### 9. Save and reopen — PASS

Closing the project committed it: the Projects list showed the edited card dated `19/11/2026`
next to the untouched `18/11/2026` one, both still `0:11` (`44`). Reopening the edited project
brought back the replacement clip label, the `Soft Chime` audio lane and the `00:11` duration
(`45`), and the IndexedDB store advanced normally (new `.ldb` segments written at 21:36–21:39).

## Not performed, deliberately

- No uninstall, no `pm clear`, no data wipe of any package.
- No action on `app.cutlyra.editor`, `.qa`, `.qa2`, `.rc` or `.rc2`.
- No device setting changed (rotation lock, install policy, developer options untouched).
- No destructive test (no kill-during-write, no overwrite-restore, no delete of existing media).
- No Play Console or Play API action.
- The one `FATAL EXCEPTION` in the crash buffer belongs to the `uiautomator` shell tool that
  was dumping the hierarchy concurrently (`UiAutomationService … already registered`), not to
  Cutlyra; it is kept verbatim in `_crash-buffer.txt` so the distinction can be checked.
