# Cutlyra — Feature Completion Master Plan

Baseline: `main@7788e9fd0692bc881ba97e68746e34ca0f7cf7c6` (v0.1.1 candidate preserved).

This is an execution tracker, not the final deliverable. Rows mirror `docs/qa/feature-coverage-matrix.md` and GitHub issues #22, #47–#52, #56–#58; claims are re-checked against current source.

## Phase 0 — Inventory (completed 2026-11-21)

Source-truth check performed:
- `bun test packages/editor-core/src` → 513 pass / 0 fail
- `bun test packages/mobile-ui/src` → 177 pass / 0 fail
- `bun test apps/web/src` → 9 pass / 0 fail
- root `bun test` within gate (≥250 pass, 0 fail)
- `cargo test --workspace` all pass
- `bun run build` (apps/web) success
- typechecks editor-core/mobile-ui/mobile: 0 errors
- `scripts/offline-audit.sh`: clean (7 known-gap warnings)

## Phase 1 — Empty/nonfunctional tabs

### 1A Stickers
- Reported emptiness reproduced: flags category thumbnails 404 on Android because `apps/mobile/public/flags` was absent (assets lived only under `apps/web/public/flags`). **Fixed**: copied 271 flag SVGs into `apps/mobile/public/flags`.
- `logos` provider returns empty and is not exposed as a category (intentional; no bundled logo assets).
- Shapes category backed by graphics registry (working, canvas-rendered thumbnails).
- Insertion via `insertStickerElement` → graphic track; export covered by overlay/crossfade instrumented tests.

### 1B Captions
- Added SRT export (`buildSrtFromCaptions`) and a "Export captions as SRT" button in the Captions panel (clipboard with textarea fallback).

### 1B Crop (implemented; on-device frame verification pending)
- `crop.x`, `crop.y`, `crop.width`, `crop.height` params (normalised, top-left origin, default = whole frame) on visual elements; persisted/undoable through the standard param system. Crop sliders + Reset in `EditPanel` for video/image clips.
- One shared reader/clamper: `packages/editor-core/src/rendering/crop.ts` (`readCropFromParams`, `croppedSourceSize`, `isFullCrop`). Preview, EDL and native export all use it, so defaults and clamping cannot drift.
- **Preview (WASM):** `LayerDescriptor.sourceRect` is a backwards-compatible optional UV sub-rectangle. `frame-descriptor.ts` computes the quad from the CROPPED source (so fit/fill/transform/rotation act on the kept region) while the texture stays the full decoded frame — no extra CPU copy, no new cache key, and video frames still invalidate by source identity. The layer shader mirrors inside the quad, then maps UVs onto `sourceRect`; the uniform grew 48 -> 64 bytes (16-byte aligned). Uncapped crop emits no `sourceRect`, so uncropped descriptors are byte-identical to before.
- **Android export (Media3 1.11.0):** EDL gains optional `clip.crop`; `EdlCropEffect` converts to `androidx.media3.effect.Crop` NDC bounds (`left,right,bottom,top`, y-up) with the same clamping. The effect is inserted FIRST in the per-item chain, so crop changes the frame before `EdlTransformEffect`, opacity/colour grade and the fit/fill `Presentation` — matching the preview order. Full-frame crops add no effect.
- Tests: TS crop reader (6), preview quad geometry (5), EDL propagation (3), Rust descriptor back-compat/round-trip (2), Kotlin NDC conversion (8), Kotlin EDL parsing (2). `ExportCropInstrumentedTest` exports a four-quadrant fixture through the real `Media3Exporter` and asserts DECODED frame colours for left/right/top/bottom/centre/off-centre crops.
- **Not yet run:** the decoded-frame instrumentation (no device attached in this session). Crop is implemented end-to-end in code but stays PARTIAL until `ExportCropInstrumentedTest` passes on hardware. iOS export has no crop mapper yet.

### 1C Other panels
- Transcript and Template intentionally show "not in Cutlyra yet" sheet (per `docs/DECISIONS.md`, tracked as FUTURE, not a bug).
- Filters/Adjust exposed and export-safe (#48 scoped slice).
- Background panel offers color swatches; blur background exists in engine/web but native Android export does not honor it, so not exposed on mobile (consistent with "no preview-only tools").

## Open gaps (NOT PLANNED unless noted)

| Feature | State | Blocker / owner |
| --- | --- | --- |
| Reverse | PARTIAL (param only) | native export + compositor; no UI |
| Freeze frame | GAP | needs engine + UI + export |
| Per-clip crop | IMPLEMENTED, on-device verification pending | run `ExportCropInstrumentedTest` on a device; iOS mapper not written |
| Background blur (mobile) | GAP (engine exists) | native Android export support |
| Voiceover recording | GAP | RECORD_AUDIO permission + recorder |
| SRT/VTT import/export | GAP | serializer + file I/O |
| Text shadow | GAP | renderer + native parity |
| Audio fades UI | GAP | DSP + UI |
| Animated stickers/GIF | GAP | asset + renderer |
| Templates | FUTURE | product scope |
| Masks/chroma key | GAP | heavy engine work |
| New transition types | GAP | native compositor |
| 4K export verification | BLOCKED | device/encoder |
| Multi-select import | BLOCKED | device Photo Picker |
| Physical-device parity | BLOCKED | owner device session |

## Next moves (owner-controlled)
1. Run fingertip checks per `docs/qa/qa3-manual-acceptance-4-steps.md`.
2. Confirm versionCode 2 availability in Play Console.
3. Authorize upload of `c42c2e05…51a2` to Closed testing – Alpha only.
4. Reapply for production access after ≈ 2026-11-30.

## Evidence
- Stickers fix: `apps/mobile/public/flags` now contains 271 SVGs matching `apps/web/public/flags`.
- No engineering code changes beyond the asset copy; no protected QA packages touched.