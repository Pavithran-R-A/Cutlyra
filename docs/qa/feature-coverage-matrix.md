# Cutlyra capability matrix — what ships, what is partial, what is absent (#58)

**Method:** every row is classified from the current source on `main@8b3b878` plus
the executed suites (unit suites via `scripts/invariants.sh`, and 58 instrumented
tests on the API-35 emulator in both the normal and R8 test variants). A row is
`SHIP` only when the code path exists **and** something in the repo exercises it —
a test, or a shipped panel/toolbar entry point. Engine-only support with no UI to
reach it is `PARTIAL`, never `SHIP`. Rows that an emulator export test covers are
still device-unverified; see the `BLOCKED` rows and the rebaseline notes.

**Legend**

| Tag | Meaning |
| --- | --- |
| **SHIP** | Reachable from the v0.1 UI, and edited state persists/undoes; where output matters, an export test covers it |
| **PARTIAL** | Some of the capability exists (engine, or a narrow UI), or it is reachable but unverified on a device |
| **GAP** | No implementation found in the tree |
| **FUTURE** | Feasible on this architecture, deliberately not scheduled |
| **BLOCKED** | Cannot be judged without hardware this session does not have (device codec, 10-min source, Play Console) |

This is a checklist, not a promise list. No unchecked item is production-ready.

---

## 1. Microfeatures users notice first

| Capability | State | Evidence / what is missing |
| --- | --- | --- |
| Filmstrip with real frames | **PARTIAL** | Placeholder tiles on `main`; real source-offset frames are the subject of #54 (PR #60, contact-sheet artifact). Until that merges, this row is the P0. |
| Filmstrip cache / retry / portrait | **PARTIAL** | `ThumbnailStripGenerator` writes JPEGs per asset; retry + source-offset correctness for split/retime land with #54 |
| Waveform for imported audio | **PARTIAL** | Decoding exists in `packages/editor-core/src/media`; visual + zoom rendering not exercised on a device this pass |
| Waveform matches export levels | **PARTIAL** | Same; no test compares drawn waveform against exported PCM |
| Append vs overlay placement | **SHIP** | `insert-element-canvas-adoption.test.ts`, `asset-reference-integrity.test.ts` (main track holds 3 clips after 3 appends) |
| Drag reorder / long-press move | **PARTIAL** | `MoveElementCommand` + `snap.test.ts` cover the model; gesture feel unverified |
| Split at playhead | **SHIP** | `split.test.ts`; also driven end-to-end in the #55 integrity test |
| One-tap delete, duplicate | **SHIP** | `DuplicateElementsCommand` covered in the #55 test (lands on a PiP overlay); delete covered by command suite |
| Trim without losing source | **SHIP** | Non-destructive `trimStart`/`trimEnd`; `split.test.ts` |
| Gap removal / ripple | **PARTIAL** | `dead-space.test.ts` + `dead-space-cut.test.ts` cover maths; UI exposure unverified |
| Replace clip | **SHIP** (video/image only) | `ReplaceClipMediaCommand` + `planClipMediaReplacement`; Edit panel Replace/Relink; 19 unit tests + 3 ExportReplaceClip instrumentation tests; durability races (12 tests: 7 original + 5 reliability) + per-asset serialized persistence coordinator; project save/backup durability gate. Cross-type and audio-clip replacement are not supported. |
| Freeze frame | **PARTIAL** | `freeze` handling exists in the engine; no toolbar/panel entry point found |
| Reverse | **GAP** (hidden in shipping UI) | `packages/mobile-ui` has a `toggleReversed` action and editor-core carries a `reversed` param for project compatibility, but `packages/mobile-ui/src/components/panels/edit-panel.tsx` intentionally hides Reverse in v0.1.0 until preview and native export can honor it. Android native export source (`apps/mobile/android/app/src`) has no reverse implementation. `docs/PHYSICAL-QA-MATRIX.md` records a historical Stage 11 PASS claim; do not treat that as current shipping parity without UI+export proof. |
| Rotate ±90/180 and H/V flip on a clip | **SHIP** | Edit panel Transform controls (`edit-panel.tsx` Rotate L/R, Flip H/V + degree readout) over `rotateVisualElement`/`flipVisualElement`; one `UpdateElementsCommand` per action, so each is one undo step. Exported pixels are asserted for identity, ±90°, 180°, H, V and rotate+H/V by `ExportTransformParityInstrumentedTest` (12 cases, both instrumentation variants). Emulator-only: physical-device parity remains `BLOCKED` (see the row below). |
| Crop with aspect-ratio presets | **GAP** | `RATIO_PRESETS` is the *canvas* ratio list, not a per-clip crop tool; no crop-rect UI or crop param exists. Fill+framing is the only cropping behaviour, and it is cover-and-centre, not user-chosen. |
| Undo / redo | **PARTIAL** | Every mutation is a `Command`. Transform actions now have action-level undo/redo and single-step `BatchCommand` assertions (`transform-params.test.ts`), but the stack itself is still unasserted across other edit kinds (see `timeline-05`) |
| Import multiple videos at once | **BLOCKED** | Needs the Photo Picker multi-select grid on a device |
| Battery/disk-hungry states | **BLOCKED** | Needs a device |

## 2. Video image tools

| Capability | State | Evidence / what is missing |
| --- | --- | --- |
| Position/scale/rotation/opacity | **SHIP** | Keyframe + transform params on video elements |
| Canvas 9:16 / 16:9 / 1:1 / 4:5 | **SHIP** | `RATIO_PRESETS` → `setProjectResolution`; `canvas-settings-roundtrip.test.ts` |
| Fit/fill, background colour | **SHIP** | Background panel; `background.ts` |
| Background blur | **GAP** | No blur background implementation |
| Colour adjust (brightness/contrast/saturation/…) | **SHIP** | `adjust` effect definitions; instrumented `effect_bearing_clip_exports_...matches_preview` |
| Filters with intensity | **SHIP** | `FILTER_PRESETS`; same export-parity instrumented test |
| LUT import | **GAP** | No `.cube`/LUT loader found, despite "lut" appearing in effect plumbing |
| Keyframes with easing | **SHIP** | `keyframe-eval-parity.test.ts`, `keyframe-graph-sheet.tsx` |
| Masks / tracking | **GAP** | "mask" appears only as an RGBA/alpha concept in the renderer, not as a user mask tool |
| Background removal / green screen | **GAP** | No chroma-key effect; "blur" exists as an effect, keying does not |
| Blur / pixelate region | **PARTIAL** | `effects/definitions/blur.ts` exists; a region/pixelate UI was not found |
| Stabilisation | **GAP** | No stabiliser |
| Overlay / PiP layers | **SHIP** | Overlay panel (opacity/blend), overlay track on duplicate; export covered by the crossfade+overlay instrumented tests |
| Multiple overlays | **SHIP** | Placement `newTrack` per duplicate/overlay insert |
| Crossfade + cut transitions | **SHIP** | Instrumented crossfade geometry/blend/luminance tests, plus `22 fps`/`24 fps` variants |
| Zoom/slide/blur/whip transitions | **GAP** | Only fade-style transitions are mapped to native |
| Animated stickers / GIF | **GAP** | Stills only |
| Editable project templates | **GAP** | Toolbar entry shows the deliberate "not in Cutlyra yet" sheet (`docs/DECISIONS.md`) |

## 3. Audio

| Capability | State | Evidence / what is missing |
| --- | --- | --- |
| Import audio (SAF) | **SHIP** | `library_pick_intent_resolves_to_either_the_photo_picker_or_the_saf_fallback` |
| Audio in export for file-backed clips | **SHIP** | `export_clamps_audio_that_outlasts_visual_timeline`, `exports_a_video_only_mp4_...` |
| Bundled sound library audible in export | **SHIP** | Fixed under #63 (closed 2026-11-09): library sounds are materialized into a real asset (`materializeLibraryAudio`/`ensureLibraryAudioAsset`, `library-audio.test.ts`) so they no longer reach `audibleClips` with a null `assetId`. `ExportLibraryAudioInstrumentedTest` decodes the exported MP4 and asserts the synthesized library tone is present at the expected amplitude; it is part of the 58-test suite green on `8b3b878`. |
| Mute / volume / split / extract | **SHIP** | Edit + audio panels; `channel-layout.test.ts` |
| Fades | **PARTIAL** | Transition/volume plumbing exists; a fade-in/out audio UI was not found |
| Voiceover recording | **GAP** | No `RECORD_AUDIO`, no recorder |
| Ducking / beat markers / silence detection | **FUTURE** | Needs DSP work; nothing in tree |
| Equaliser / noise reduction / pitch | **GAP** | Only playback-rate pitch preservation exists |
| Local royalty-free sound pack | **PARTIAL** | `packages/editor-core/src/sounds/local-sounds.ts` bundles a small offline set |

## 4. Text, captions, stickers

| Capability | State | Evidence / what is missing |
| --- | --- | --- |
| Text add / edit / size / colour | **SHIP** | `text-panel.tsx`, `typography.ts` |
| Stroke / shadow / background box | **PARTIAL** | Stroke + background exist in `primitives.ts`/`typography.ts`; shadow not found |
| Font families | **PARTIAL** | A fixed bundled set; licence-safe custom font import is absent |
| Text animations / karaoke | **PARTIAL** | Param animation channels exist; karaoke word highlight absent |
| On-device English captions | **SHIP** | `caption-pipeline-integration.test.ts`, `generate-captions-e2e.test.ts`, instrumented caption-window diagnostics |
| Edit/correct transcript text and timing | **PARTIAL** | Caption track rows are editable; per-word timing UI not found |
| SRT/VTT import or export | **GAP** | No serialiser; "srt" appears only in a comment |
| Multilingual captions | **GAP** | Single English model; no optional multilingual pack |
| Emoji stickers | **SHIP** | Stickers panel; `sticker-id.test.ts` |
| Sticker packs / animation / transform | **GAP** | Fixed set, still, no transform handles |

## 5. Export, project, lifecycle

| Capability | State | Evidence / what is missing |
| --- | --- | --- |
| H.264/AAC MP4 | **SHIP** | Many instrumented export tests (geometry, blend, grade, fps, audio clamp) |
| 720p / 1080p exact output | **SHIP** | `exports_exact_1280x720_...`, `exports_exact_1920x1080_...`, portrait 1080×1920 |
| 4K | **PARTIAL** | `export-sheet.tsx` offers 4K; no test proves a 4K encode, and device support is unknown |
| 24/25/30/60 fps | **SHIP** | FPS selection with honest downgrade warnings (`export-frame-rate.ts` + tests) |
| Bitrate selection | **PARTIAL** | Quality control exists; exact bitrate mapping unverified |
| Progress / cancel | **PARTIAL** | Native progress stream exists; cancel unverified on device |
| Video-only input export | **SHIP** | `exports_a_video_only_mp4_without_creating_an_impossible_audio_item` |
| Save to gallery | **SHIP** | `completed_video_can_be_published_and_read_from_gallery` |
| GIF / HEVC / HDR / transparent export | **GAP** | None of these codecs/containers are wired |
| Custom cover/thumbnail | **GAP** | Not found |
| Project list with real thumbnails | **PARTIAL** | List renders; thumbnail generation for projects not verified |
| Project duplicate/delete | **VERIFY** | No dedicated test found for either action |
| Archive export/import | **SHIP** | `backup-service.test.ts`, `backup-cleanup.test.ts` |
| Missing-source repair / relink UI | **SHIP** (relink) | Edit panel relabels to "Relink media" when a clip's media is missing and `ReplaceClipMediaCommand` re-points it; EDL goes unresolved→clean. |
| Non-destructive migrations | **SHIP** | 30 migration test files (v0→v31) + `persistence.test.ts` |
| Android 10–16 coverage | **BLOCKED** | Only an API-35 CI emulator is available |
| 16 KB page-size ELF | **SHIP** | `-Wl,-z,max-page-size=16384` on the only shipped `.so` |
| Crash-free / ANR / memory on device | **BLOCKED** | Needs a device |

## 6. Play & privacy

| Item | State | Evidence |
| --- | --- | --- |
| Closed test with 12+ testers | **BLOCKED** | Console state is owner-side; not inspected here, and uploading is not authorized |
| DEX/R8 optimisation | **PARTIAL** | `minifyEnabled false` explains the 1% warning; keep-rule worklist in `release-quality-audit.md`, not enabled |
| Edge-to-edge on Android 15+ | **PARTIAL** | CSS-only insets + a new API-35 instrumentation guard; other OEMs unverified |
| System PiP | **GAP (not planned)** | Product-fit assessment in `release-quality-audit.md` |
| No telemetry / ads / payments | **SHIP** | Offline-audit gate green; no such dependency in `app/build.gradle` |
| No outbound network use | **SHIP** | Offline-audit gate green (source + built bundle) |
| Manifest vs Data Safety wording | **PARTIAL** | `INTERNET` and `CAMERA` are declared; CAMERA is documented as unreachable, INTERNET is unused — align the Console wording |
| Accessibility (TalkBack, targets) | **BLOCKED** | Needs a device and a screen reader |
| Support contact / policy pages | **PARTIAL** | Present in `docs/`; the Play listing values were not re-checked here |

---

## What would move the most rows fastest

1. **#54 filmstrip** — turns the first row from PARTIAL to SHIP for every user, every session.
2. **#55 media-reference pre-flight** — closes the only known way a project becomes unexportable.
3. **~~Sound-library export~~** — done: #63's materialization fix and its export test closed this row.
4. **Undo/redo and project duplicate/delete tests** — cheap rows that are currently PARTIAL only for lack of an assertion.
5. **A device session (or an API-29 + API-36 CI matrix)** — unblocks 9 BLOCKED rows at once.

---

## 2026-11-09 rebaseline note (PR #66, `feat/22-canvas-fit-fill`, head `1c351be`+docs)

- **#22 canvas fit/fill (focused slice):** PR #66 adds per-clip `fit` (default, preserve whole frame) / `fill` (cover+crop) across preview geometry/bounds, renderer effect sizing, EDL (additive `framing` field; schema/golden updated), and native Media3 export (`Presentation` layout crop for fill). UI exposes Fit/Fill for main-track video/image clips. Deterministic tests added: `packages/editor-core/src/rendering/__tests__/framing.test.ts`, EDL framing propagation/golden; instrumented `ExportFramingInstrumentedTest` added. **Evidence status:** code/tests committed; PASS requires green CI on the exact final head SHA and device preview↔export parity (owner-blocked).
- **#48 (not in scope, no unrelated closure):** Filters/Adjust are exposed as export-safe per current toolbar/source (color-grade mapping in `EdlToComposition`); Effects remains hidden. Full #48 scope (blur feasibility, all params, pixel-level active/inactive checks across required cases, every unsupported param visibly refuses, 6/6 head+main CI) remains open.
- **#50 (not implemented in this slice):** reverse/freeze/crop-rotate-flip/timeline productivity scope remains open; framing UI clarity is the only adjacent usability change here.

## 2026-11-09 merged-main qualification recovery (`8a76c8ae`, corrective branch)

- **Merged-main CI:** Bun CI 42672196713 attempt 3 (3/3 invariants jobs) and Mobile CI 42672197042 attempt 3 (4/4 jobs, 46 tests 0 failures normal + 46 R8 instrumentation) are **green** on `8a76c8aeb31241bf0e650721c2039bc14877d216`. Earlier attempts 1–2 showed GitHub Actions scheduling/execution anomalies (zero/partial jobs; no workflow files changed by merge; PR-head `66f1eb5` had been fully green). Root cause classified as likely GitHub-side scheduling anomaly, not code regression (proven by recovery on rerun).
- **QA inventory reconciliation:** `docs/qa/beta-case-inventory.json` summary now computed from rows (56 cases: 26 PASS, 0 FAIL, 17 VERIFY, 13 BLOCKED); integrity test added. Historical 2026-11-03 FAIL evidence preserved in `historical_baseline`/per-case baselines. Export-22 automated export geometry is PASS (Mobile CI 42669153296 on PR head + 42672197042 on merged main, both 46/46 normal+R8 incl. framing export test); physical preview↔export parity remains BLOCKED (`export-22b`). Former FAILs (filmstrip, bundled audio export, lost media reference, R8 release readiness) reassessed as VERIFY with build-specific evidence/gaps — not silently closed.

## 2026-11-10 evidence update on `main@8b3b878` (PR #69 merged, rotate/flip)

Verified build: `8b3b8786b8d54f8b6cef60944783690ec91bd769` (merge of PR #69). This note corrects two stale rows and records what the run did and did not prove. Rows above already carry the corrected text; this section is the evidence trail.

### Stale claims corrected

- **Rotate/flip was listed as `PARTIAL` with no rotate UI and no export coverage.** It now has shipped UI (Edit panel Transform: Rotate L, Rotate R, Flip H, Flip V plus a live degree readout), an action per control, and real exported-pixel assertions. Row split into a `SHIP` rotate/flip row and a separate `GAP` row for per-clip crop-with-ratio, which still does not exist (`RATIO_PRESETS` is the canvas ratio list).
- **"Bundled sound-library audio cannot be exported" was `GAP (defect)`.** #63 is closed: library sounds are materialized into a real asset before the EDL is built, and `ExportLibraryAudioInstrumentedTest` decodes the exported MP4 and finds the synthesized library tone. Row is now `SHIP` with that test named as the evidence.

### PR #69 / merged-main evidence

- **What ships:** rotate ±90°, 180° (as two ±90 steps), horizontal flip, vertical flip, and combined rotate+flip, for video and image clips on the timeline. Each control is one `UpdateElementsCommand` parameter patch, so it is one undo step; flip preserves magnitude and toggles the sign rather than zeroing the transform.
- **Fit/Fill interaction is tested:** fit on a 9:16 canvas presents 1080x1920 with letterbox bars top/bottom and no pillarbox; fill covers the canvas. Rotation re-frames pixels inside the project canvas — it never reshapes the canvas.
- **Image and video both covered:** the parity suite includes a 90°-rotated image clip exported through the real native pipeline, not just video.
- **PR-head CI (`df17b61`):** Mobile CI run 42810540771 success, all 4 jobs — instrumentation API 35 `Tests 58/58 completed. (0 skipped) (0 failed)`, instrumentation R8 `Tests 58/58 completed. (0 skipped) (0 failed)`; Bun CI run 42810541409 success.
- **Merged-main CI (`8b3b878`):** Bun CI run 42813555378 success (3/3 invariants: ubuntu, macos, windows); Mobile CI run 42813555396 success (4/4: Android debug APK, iOS simulator, instrumentation API 35 `Starting 58 tests` → `Finished 58 tests` → BUILD SUCCESSFUL, instrumentation R8 `Tests 58/58 completed. (0 skipped) (0 failed)`).

### What this evidence does NOT establish

- **No physical-device proof.** CI is an API-35 x86_64 emulator with a software encoder. The owner's POCO M4 Pro 5G has not run this build; preview↔export transform parity on that device stays `BLOCKED` (`export-23b` in the inventory).
- **Non-zero `positionX`/`positionY` in export is untested.** `EdlTransformEffect` applies `postScale` → `postRotate` → `postTranslate`; the parity suite only ever exports centred clips, so the translate term is exercised only as translation-to-centre. `export-24` records this as `VERIFY`.
- **Animated/keyframed transform time base in native export is untested.** The effect accepts a `presentationTimeUs`-driven animation path, but no export test drives a keyframed transform.
- **Source-metadata edge cases stay open.** One case is covered (a source carrying rotation metadata with an identity clip transform exports without crashing); odd dimensions, anamorphic pixel aspect and HDR/10-bit sources are not.
- **The coded-vs-presented distinction is real, not cosmetic.** Media3 1.11.0 `VideoEncoderWrapper.getSurfaceInfo` always prefers a landscape encode and records a clockwise display rotation, so a correct 9:16 export is stored 1920x1080 with `rotation=90` and *presents* 1080x1920. Any future "portrait output must be coded portrait" assertion would be wrong; assert presented geometry.

### Still absent from this feature area

- Reverse: engine param + hidden action only, native export has no implementation. #50 stays open.
- Freeze frame: engine handling exists, no toolbar/panel entry point.
- Speed ramps, new transition types, crop-with-ratio: unchanged, out of scope for #69.

## 2026-11-10 evidence update (PR #72, `feat/replace-clip-reliability`)

- **Durability coordinator:** `ReplaceClipMediaCommand` now tracks per-asset generation/intent/durable-generation/failed-generation and serializes save/delete intents per `projectId:assetId`. `ProjectManager.saveCurrentProject()` awaits pending media writes and aborts the save (with a visible toast) when a replacement's required media persistence failed; `buildExportRecipe()` awaits pending writes and throws `BackupError` on failure so a backup can never silently omit referenced media.
- **UI truthfulness:** Replace Clip success toast now reads "Clip media replaced — saving media…" (provisional) instead of claiming durable success; the command's existing failure toast surfaces "Couldn't save the replacement" when persistence fails. Single-step Undo/Redo preserved.
- **Tests:** focused replace-clip suite 31 pass / 0 fail (115 expect); full invariants green (lint 131, 773 pass / 0 fail). Native proxy cleanup remains an explicitly unresolved limitation (no verified safe delete API; no unsafe recursive/guessed-path deletion added). Physical POCO acceptance and real process-crash recovery remain BLOCKED.
- **Lint:** aggregate 131 errors (baseline preserved, no rule/baseline weakening).
