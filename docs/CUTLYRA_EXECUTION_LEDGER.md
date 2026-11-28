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
| 2b | Chroma key (key colour, eyedropper, similarity, softness, spill) | DONE | `effects/chroma-key.ts` + `chroma_key.wgsl` (preview), `ChromaKeyMath.kt` + `EdlChromaKeyEffect.kt` (export), `chroma-key-panel.tsx` with preview eyedropper; `ChromaKeyMathTest`, `ExportChromaKeyInstrumentedTest`, preview harness case |
| 3 | Advanced transitions | DONE | `timeline/transition-definitions.ts` (one registry for kind/duration/direction/audio/layer order/channels); `fade`+`slide`+`push`+`zoom` in preview, EDL and Media3 export; wipe/dip/blur dropped with reasons (docs/EDL.md §8); `ExportMotionTransitionInstrumentedTest` 4/4 + cross-fade gates unchanged; preview harness `transition-*` 32/32 |
| 4 | Real subtitle files + transcript editor | TODO | |

## Verification log

- Advanced transitions (Phase 3, 2026-11-27) — **merged PR #110 @ `197f74c75de4279313c3deafcb3024c7b51deb15` (squash)**. All 7 PR checks green (Android instrumentation API 35 + R8, Android debug APK, iOS unsigned, invariants ubuntu/macos/windows).

- Advanced transitions (Phase 3, 2026-11-27):
  - `bun test packages/editor-core/src/edl`: **63 pass / 0 fail** (kind
    canonicality, `direction`, `incomingAnimations`).
  - `bun test` (root): **1060 pass / 0 fail** (127 files), including
    `transition-definitions.test.ts` (14) and a save -> JSON clone -> reopen
    case that keeps kind/duration/direction.
  - Payload rebuilt and synced before the device runs: `bun run build &&
    bunx cap sync android` (the `incomingAnimations` / `slide` strings are in
    `apps/mobile/www/assets/editor-shell-*.js`), so the APKs under test carry
    the current code.
  - On `emulator-5554`: `ExportMotionTransitionInstrumentedTest` **4/4** from
    DECODED MP4 frames -- slide/left and slide/right advance the incoming
    clip's coverage 0.20 -> 0.53 -> 0.86 with the correct anchor side, push
    shows the same motion with the outgoing layer leaving, zoom blends
    1.25 -> 1 behind the base's alpha ramp, and every output is 1.50 s.
  - Cross-fade regression unchanged on the same build:
    `ExportCrossfadeBlendInstrumentedTest` **2/2**,
    `ExportCrossfadeLuminanceInstrumentedTest` 1/1,
    `ExportCrossfadeGeometryProbeInstrumentedTest`, `ExportGoldenFrameInstrumentedTest`
    and `ExportAudioFadeInstrumentedTest` green.
  - Preview harness (`vite.preview-parity.config.ts`): **32/32**, the four new
    `transition-*` cases built from `deriveTransitionIncomingChannels` at
    p = 0.2 / 0.5 / 0.9 (slide coverage 0.20/0.50/0.90, zoom scale
    1.200/1.125/1.025 with the matching alpha), i.e. the same frame positions
    the decoded gate samples.
  - Decisions: motion heads are registered ABOVE the base, which makes them
    media3's primary sequence -- so they are padded with gaps to the project
    end (otherwise a 1.5 s timeline exported as 1.0 s) and their compositor
    alpha is 0 outside the window (gaps composite black). Audio policy is
    `cut` for every kind: media3 1.11.0 has no per-input gain ramp.


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
- Chroma key (2026-11-27): `bun test` **1072 pass / 0 fail** (128 files),
  including `chroma-key.test.ts` (10) and the new `validateEdl` chroma cases;
  `ChromaKeyMathTest` 7/7 on the JVM (values generated by the TS
  implementation); `cargo test -p effects` 3/3 (the new WGSL shader parses and
  validates); `:app:assembleDebug` + `:app:assembleDebugAndroidTest` green.
  On `emulator-5554`: `ExportChromaKeyInstrumentedTest` **3/3**, decoded MP4s —
  the keyed green screen reveals the blue base (`rgb` blue at two corners), the
  red subject survives at the centre, the unkeyed control still shows the
  green screen, and a blue key leaves that green screen intact. Preview parity
  harness rebuilt with the new `opencut-wasm` binary: **28/28**, including
  `chroma-key-removes-the-screen-over-a-lower-layer` (blue/red/blue).
- The committed `rust/wasm/pkg/opencut_wasm_bg.wasm` was rebuilt (wasm-bindgen
  0.2.116) so the preview actually contains the `chroma-key` shader.
- `editor-core`, `mobile-ui`, `native-bridge` `tsc --noEmit`: clean.
- `:app:testDebugUnitTest --tests ColorGradeMatrixTest`: 13 tests, 0 failures.
- `:app:assembleDebug` + `:app:assembleDebugAndroidTest`: pass.
- `scripts/invariants.sh`: see run log.

### 2b follow-up — the editor crashed on open (found by CI, fixed)

The chroma eyedropper's `useState` sat *below* the editor's `if (!ready)`
bootstrap return, so the second render (project loaded) ran one more hook than
the first and React threw error #310 the moment a project opened. The app
painted its own `Cutlyra crashed` boundary instead of the editor. Local runs
missed it because the installed APK still carried a stale web payload from
before the feature (`apps/mobile/www` had no `chroma-key` string), so the
editor under test never included the new code; rebuilding the payload with
`bun run build && bunx cap sync android` reproduced the crash locally in one
run. The state is now declared with the other editor state, above the early
return, and the EdgeToEdge UI test — the only instrumented test that actually
opens the editor — passes on a fresh install with the current payload.

## Notes

- Mission prompt was truncated mid-Phase 4; `END_OF_COMPLETE_MISSION` absent.
  Phases after the truncation point are not yet known.
- Play Store candidate must not change (applicationId, versionCode/name, signing,
  release build config, store assets).
- No AI attribution in commits/PRs/release notes per `AGENTS.md`.
- Cross-project sweeping now reads every saved project's media rows; that is
  the fix for custody being app-global while a sweep targets one project.

## Mission V2 — Phase A (subtitle completion)

Baseline `b8b6868`. Subtitle handling is now qualified end to end rather than
only wired:

- **SAF import hardening** — subtitle decoding/validation moved to a plain-JVM
  `SubtitleFileCodec`: strict UTF-8 (with or without BOM) or UTF-16 with a BOM,
  malformed sequences refused instead of silently replaced with U+FFFD, 2 MB
  cap, `.srt/.vtt/.txt` extension check, and a `-->` content check so a picked
  non-subtitle never imports zero cues. Format is detected from content, not
  the extension. `SubtitleFileCodecTest` 10/10 on the JVM.
- **Empty VTT export** — the panel now checks the CAPTIONS before serializing;
  a header-only `WEBVTT` document can no longer be saved as if it held cues,
  and the native save path refuses cue-less text.
- **Transcript editor** — new `TranscriptEditor` in the Captions sheet: cue
  list in timeline order, tap-to-seek + select, editable cue text, cue start/end
  timing, per-word text editing, split at the playhead and merge with next.
  Every mutation is an engine command (`UpdateElementsCommand`,
  `UpdateCaptionWordCommand`, `SplitCaptionCommand`, `MergeCaptionsCommand`),
  so undo/redo, persistence and the native caption export stay in one path.
- **New commands** — `SplitCaptionCommand` divides a cue's WORDS (not just its
  duration) and rebases the right half; `MergeCaptionsCommand` concatenates
  words at the right offset and spans the gap. Both refuse cuts/merges that
  would lose words, and both restore the exact prior scene on undo.
- **Tests** — `caption-edit-commands.test.ts` 7/7; expanded `srt.test.ts` with
  VTT output, SRT and VTT round trips, BOM/CRLF tolerance and the header-only
  VTT case. Root Bun suite 1076 pass / 0 fail.
- **Checks actually run** — `editor-core`/`mobile-ui`/`native-bridge`/`apps/mobile`
  tsc clean; `apps/mobile` build + `cap sync android` clean;
  `:app:testDebugUnitTest --tests SubtitleFileCodecTest` and
  `:app:assembleDebug` green; `scripts/invariants.sh` green, lint 130 errors
  (baseline 131).
- **Not verified here** — the system SAF picker UI was not driven on a device
  in this pass (the codec rules are unit-tested; the picker flow needs the
  emulator/instrumented harness), and the new captions buttons were typechecked
  and bundled but not visually inspected. Stated as a limitation, not a pass.
