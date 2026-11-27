# Cutlyra — Remaining Feature Mission Execution Ledger

Mission: `docs/CUTLYRA_REMAINING_FEATURE_MISSION.md`
Base main: `05c0ba69a895b99ec76208e40be3d747ae1e7b08`

Status legend: `TODO` · `IN PROGRESS` · `DONE` · `BLOCKED` (with reason)

| Phase | Item | Status | Evidence / branch |
| --- | --- | --- | --- |
| 1.1 | Voiceover foreground-only lifecycle | DONE | `voiceover-recorder.ts` visibility cancel + vanished-recorder handling; `NativeBridgePlugin.handleOnStop()`; docs updated |
| 1.2 | Adjust/Filter processing-order parity | DONE | `ColorGrade.passesFor` per-effect order; `ColorGradeMatrixTest` 13/13 |
| 1.3 | Generated-media cleanup audit + undo/redo/projects | DONE | `referencedCustodyPaths`, `Command.referencedMediaPaths`; `voiceover.test.ts` 12/12 |
| 1.4 | GIF timing/loop/transparency/memory audit | DONE | Existing `GifFrameTimelineTest`, `GifDecoderBudgetTest`, `gif-decoder.test.ts` cover all four |
| 1.5 | Stale docs / issue checklists | DONE | Master plan Phase 11, native-export-blockers, feature-coverage-matrix corrected |
| 2a | Masks: preview + EDL + Android export parity | DONE | `edl/validate.ts` real mask validation (no warning); `EdlMaskEffect`/`MaskMath`; decoded-MP4 `ExportMaskInstrumentedTest` 6/6; `MaskMathTest` 16/16; preview harness `mask-*` 6/6 (27/27 overall) |
| 2b | Chroma key (key colour, eyedropper, similarity, softness, spill) | TODO | |
| 3 | Advanced transitions | TODO | |
| 4 | Real subtitle files + transcript editor | TODO | |

## Verification log

- `bun test` (root): **1062 pass / 0 fail** (127 files).
- Masks (2026-11-27): `:app:testDebugUnitTest --tests MaskMathTest` green;
  `:app:assembleDebug` +
  `:app:assembleDebugAndroidTest` pass; on `emulator-5554` (swiftshader)
  `ExportMaskInstrumentedTest` **6/6 pass** — rectangle, ellipse, circle,
  linear half-plane, rotated+feathered+inverted rectangle, centre-Y below the
  frame centre, and mask + crop + 0.5x scale + opacity 0.7 + keyframed
  position, all read from decoded MP4 pixels (bright overlay 251 over dark
  base 0, feather midpoint 132).
- Preview harness (`vite.preview-parity.config.ts`, WebGL2): **27/27 pass**,
  including `mask-rectangle`, `mask-ellipse`, `mask-linear`,
  `mask-travels-with-the-element`, `mask-is-relative-to-the-cropped-element`,
  `mask-rotated-feathered-inverted` (centre blue, corner red, edge rgb(128,0,127)).
- `editor-core`, `mobile-ui`, `native-bridge` `tsc --noEmit`: clean.
- `:app:testDebugUnitTest --tests ColorGradeMatrixTest`: 13 tests, 0 failures.
- `:app:assembleDebug` + `:app:assembleDebugAndroidTest`: pass.
- `scripts/invariants.sh`: see run log.

## Notes

- Mission prompt was truncated mid-Phase 4; `END_OF_COMPLETE_MISSION` absent.
  Phases after the truncation point are not yet known.
- Play Store candidate must not change (applicationId, versionCode/name, signing,
  release build config, store assets).
- No AI attribution in commits/PRs/release notes per `AGENTS.md`.
- Cross-project sweeping now reads every saved project's media rows; that is
  the fix for custody being app-global while a sweep targets one project.
