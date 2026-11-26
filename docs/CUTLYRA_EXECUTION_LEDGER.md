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
| 2 | Chroma key + masks | TODO | |
| 3 | Advanced transitions | TODO | |
| 4 | Real subtitle files + transcript editor | TODO | |

## Verification log

- `bun test` (root): **1055 pass / 0 fail** (126 files).
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
