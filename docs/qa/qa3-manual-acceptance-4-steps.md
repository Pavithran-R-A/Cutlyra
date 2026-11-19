# QA3 manual acceptance — the four remaining physical steps

**Status: NOT EXECUTED.** These four checks require human fingers on the device. Nothing in
this document has been marked as passed. `adb shell input` cannot inject two pointers, and
changing the device orientation setting was out of scope, so all four remain open.

This document exists so the remaining device work is a short, mechanical job rather than a
re-run of the whole QA matrix. The five PASS rows and three PARTIAL rows in
`qa3-evidence-poco-20261118/RESULTS.md` stand as recorded — do not re-do the passed cases.

| Item | Value |
|---|---|
| Device | POCO M4 Pro 5G, Android 13 (API 33), 1080×2400 |
| Package | `app.cutlyra.editor.qa3` |
| Last installed build | QA3 from `40ce2bf` (run 43841922109), 0.1.1 / vc2 |
| Install/update authorization | **withheld — request it before installing anything** |
| Why these four | trim-handle drag, two-finger pinch, Replace Clip via the physical UI, and device rotation cannot be driven by ADB's single-pointer input |

## Before you start

1. Create a disposable project (name it `accept-<today>`), import one portrait clip and one
   landscape clip. Do not use a project you care about.
2. Turn on screen recording for the whole session. That recording is the primary evidence.
3. Keep the phone on mains power. MIUI killed QA3 in the background during the earlier
   session; that is an OS behaviour, not an app crash.

## Step 1 — Manual trim-handle resize

| | |
|---|---|
| Do | Select a video clip on the timeline. Drag the **right** edge handle slowly left, then release. Repeat with the **left** edge handle. |
| Expected | The edge tracks your finger continuously with no jump at the moment the drag begins (this is the case PR #89 addressed). No gap or overlap appears at the release position. The clip duration label updates to match what is on screen, and the preview still plays across the new in/out points. |
| Evidence to capture | One screen recording containing both handles, plus a screenshot of the timeline immediately after release. |
| Fail if | The edge jumps on first movement; the handle releases to a position different from the finger; a gap or overlap appears; the duration label disagrees with the visible clip. |
| Record | PASS / PARTIAL / FAIL + timestamp in the recording |

## Step 2 — Two-finger pinch and finger-lift stability

| | |
|---|---|
| Do | Place two fingers on the timeline and pinch **in**, then **out**. Then repeat, but lift one finger first and, without lifting the second, try to pan. |
| Expected | The zoom stays anchored under your fingers; the timeline does not jump when the second finger lands or when one finger lifts. A single remaining finger pans smoothly from where the content already is — no re-anchoring jump. Pinch and pan do not change any clip's committed transform; only the timeline zoom changes. |
| Evidence to capture | One screen recording of pinch in, pinch out, and the lift-one-finger pan. |
| Fail if | The timeline jumps when the second finger contacts or leaves the screen; the surviving finger's drag starts from a position that was never displayed (the exact class of defect fixed in #82/#89); a clip's position or scale changes from a zoom gesture. |
| Record | PASS / PARTIAL / FAIL + timestamp in the recording |

## Step 3 — Replace Clip, Undo/Redo, save and reopen

| | |
|---|---|
| Do | Select a clip, use **Replace Clip** from the normal on-screen UI (not adb), pick a source of a **different duration and orientation**. Then Undo, then Redo. Then close the project and reopen it. |
| Expected | The clip is replaced in place at the same timeline position; the timeline length follows the documented clamp rather than collapsing; no unrelated clip changes; Undo restores the original media; Redo restores the replacement; after reopening, the replacement is still there and still plays. |
| Evidence to capture | Screenshots at four points: after replace, after undo, after redo, after reopen. |
| Fail if | Any other clip is altered or deleted; the project loses a previously committed edit; undo/redo lands on a state that was never shown; the reopened project shows missing media or a different duration. |
| Record | PASS / PARTIAL / FAIL + which of the four states first deviated |

## Step 4 — Native rotation / Fit-Fill visual confirmation

| | |
|---|---|
| Do | Select a clip, rotate it 90°, then −90°, then 180°; toggle **Fit** and **Fill**; apply a horizontal flip, then a combined rotate+flip. Watch the preview and then export one 720p file. |
| Expected | Each rotation is visually correct with no stretched or squashed geometry; Fit letterboxes and Fill crops, and the two differ as expected; flip mirrors the correct axis; the exported MP4 matches the preview, including letterbox placement, and keeps its audio. |
| Evidence to capture | Screenshot per rotation state, one screenshot per Fit/Fill state, and the exported MP4. |
| Fail if | Geometry is stretched; letterbox appears on the wrong axis or is missing in export; export differs from preview; audio is lost. |
| Record | PASS / PARTIAL / FAIL + which transform deviated |

## Recording the result

For each step, record the outcome, the timestamp in the recording, and the device/OS. Then
update `qa3-evidence-poco-20261118/RESULTS.md` rows 2, 3 and 4 to the observed result and
re-run `scripts/qa/qa3-evidence-index.sh` so `QA_SUMMARY.json` totals are recomputed from the
rows rather than typed by hand.

Rules that do not change:

- A partial observation stays PARTIAL. Do not round "it looked fine for one of three
  transforms" up to PASS.
- If a step cannot be completed because the build was not installed (authorization
  withheld), it stays open — do not substitute an emulator result for a device result.
- Do not clear app data, uninstall, or reset the phone to reproduce a failure. Note the
  failure and stop there.
