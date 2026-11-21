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
- Shapes category expanded from the four bare primitives to a curated 14-tile library (`curated presets` in `stickers/providers/shapes.ts`): rectangle, square, rounded square, pill, ellipse, circle, triangle, diamond, pentagon, hexagon, octagon, star, plus two new locally drawn graphics — heart and arrow (with a rotation parameter). Every tile is the same locally rendered graphic with different parameters, so the library grows with no new downloaded assets and no licence surface. Original graphic ids (shapes:rectangle/ellipse/polygon/star) still resolve, so old projects open unchanged.
- Insertion via `insertStickerElement` → graphic track; export covered by overlay/crossfade instrumented tests.
- Library invariants are now tests, not claims: `stickers/__tests__/sticker-library.test.ts` walks `STICKER_CATEGORIES` (the same source of truth the panel builds its chips from) and requires every advertised category to return items, ids to be unique/provider-prefixed, and each item's resolved URL to equal its thumbnail URL. `apps/mobile/src/__tests__/sticker-assets.test.ts` checks every flag sticker against the real `apps/mobile/public` file: exists, has an `<svg>` root, is sized, has drawable geometry, and references no remote URL (offline guarantee).
- Failed thumbnails no longer render as blank tiles: `ThumbnailGrid` shows the item name in place of an image that errors, so a broken asset cannot be mistaken for an empty category. This is the failure mode a wrong MIME type produces (a host serving `.svg` as `application/octet-stream` makes every flag tile blank while all the data is correct) — observed directly in the parity harness before its static server learned `image/svg+xml`.
- Browser evidence: the parity harness browses each category, loads every shape tile and a spread of flag tiles, and counts the pixels each one paints — shapes 14/14 painted. Flag tile re-check after the MIME fix was cut short when the browser panel stopped attaching; the file-level SVG checks above cover the same assets in CI.

### 1B Captions
- Added SRT export (`buildSrtFromCaptions`) and a "Export captions as SRT" button in the Captions panel (clipboard with textarea fallback).

### 1B Crop (implemented; on-device frame verification pending)
- `crop.x`, `crop.y`, `crop.width`, `crop.height` params (normalised, top-left origin, default = whole frame) on visual elements; persisted/undoable through the standard param system. Crop sliders + Reset in `EditPanel` for video/image clips.
- One shared reader/clamper: `packages/editor-core/src/rendering/crop.ts` (`readCropFromParams`, `croppedSourceSize`, `isFullCrop`). Preview, EDL and native export all use it, so defaults and clamping cannot drift.
- **Preview (WASM):** `LayerDescriptor.sourceRect` is a backwards-compatible optional UV sub-rectangle. `frame-descriptor.ts` computes the quad from the CROPPED source (so fit/fill/transform/rotation act on the kept region) while the texture stays the full decoded frame — no extra CPU copy, no new cache key, and video frames still invalidate by source identity. The layer shader mirrors inside the quad, then maps UVs onto `sourceRect`; the uniform grew 48 -> 64 bytes (16-byte aligned). Uncapped crop emits no `sourceRect`, so uncropped descriptors are byte-identical to before.
- **Android export (Media3 1.11.0):** EDL gains optional `clip.crop`; `EdlCropEffect` converts to `androidx.media3.effect.Crop` NDC bounds (`left,right,bottom,top`, y-up) with the same clamping. The effect is inserted FIRST in the per-item chain, so crop changes the frame before `EdlTransformEffect`, opacity/colour grade and the fit/fill `Presentation` — matching the preview order. Full-frame crops add no effect.
- Tests: TS crop reader (6), preview quad geometry (5), frame-descriptor `sourceRect` emission (2), EDL propagation (3), Rust descriptor back-compat/round-trip (2), Kotlin NDC conversion (8), Kotlin EDL parsing (2).
- **Native export verified on decoded frames:** `ExportCropInstrumentedTest` exports a four-quadrant fixture through the real `Media3Exporter` for uncropped, left/right/top/bottom half, centre-quarter and off-centre crops, then decodes the MP4 and samples pixels. Result: `OK (1 test)` on a disposable API 35 emulator (`cutlyra_ci35`) on 2026-11-21, 16.2 s. The protected physical device was never used (the repo's device-isolation guard blocks Gradle there by design; APKs were installed with device-scoped adb onto the emulator only).
- **Preview pixels verified (2026-11-21, supersedes the earlier "not compared" note):** `apps/mobile/src/preview-parity/main.ts` renders real `buildFrameDescriptor` output through the real `wasmCompositor` on a WebGL2 context (the backend Android System WebView uses) and samples the rendered canvas. Same 320x240 four-quadrant fixture and same sample points/classification rules as `ExportCropInstrumentedTest`, so both paths are judged against one ground truth. 19/19 cases pass: uncropped, left/right/top/bottom half, centre-quarter, off-centre, portrait input, landscape input, fit vs fill letterboxing, rotate 90, flip X, two layers (cropped overlay on an uncropped background), a new video frame arriving in the same pooled canvas, and four crop edits applied across successive frames. Build with `apps/mobile/vite.preview-parity.config.ts`; it is deliberately not part of the shipped Capacitor bundle.
- **Uniform layout bug found by that run and fixed:** `layer.wgsl` declared the crop as `vec4f`, which WGSL aligns to 16 bytes — offset 48 and an 80-byte struct, against a 64-byte `#[repr(C)]` buffer that wrote the rectangle at offset 40. Every preview frame therefore failed pipeline validation ("buffer bound with size 64 ... requires at least 80", invalid command buffer) and the canvas rendered black. The shader now declares four `f32` crop components and documents the byte layout; `compositor.rs` has `layer_uniform_layout_matches_the_shader` pinning size and every offset. `rust/wasm/pkg` was rebuilt from the fix.
- **Stale video frames:** mediabunny's `CanvasSink` pools canvases, so a later frame can arrive in the *same* canvas object the texture cache had already uploaded. Video resolutions now carry `sourceRevision` (`mediaId`/source time/frame timestamp), external textures emit it as `contentHash`, and the cache compares it before treating a matching source object as a hit. Verified in the browser harness (new pixels in the same canvas are re-uploaded) and unit-tested (`isExternalTextureCacheHit`).
- iOS export has no crop mapper yet.

### 1C Other panels
- Transcript intentionally shows the "not in Cutlyra yet" sheet (per `docs/DECISIONS.md`). Template is now a real library — see Phase 2.
- Filters/Adjust exposed and export-safe (#48 scoped slice).
- Background panel offers color swatches; blur background exists in engine/web but native Android export does not honor it, so not exposed on mobile (consistent with "no preview-only tools").

## Open gaps (NOT PLANNED unless noted)

| Feature | State | Blocker / owner |
| --- | --- | --- |
| Reverse | PARTIAL (param only) | native export + compositor; no UI |
| Freeze frame | GAP | needs engine + UI + export |
| Per-clip crop | IMPLEMENTED; preview pixels + native export verified | iOS mapper not written; physical-device fingertip check pending |
| Background blur (mobile) | GAP (engine exists) | native Android export support |
| Voiceover recording | GAP | RECORD_AUDIO permission + recorder |
| SRT/VTT import/export | GAP | serializer + file I/O |
| Text shadow | GAP | renderer + native parity |
| Audio fades UI | GAP | DSP + UI |
| Animated stickers/GIF | GAP | asset + renderer |
| Templates | IMPLEMENTED (12 offline templates + schema/planner/apply engine, UI wired) | No on-device Android UI-automation or exported-MP4 parity run yet |
| Emoji / non-shape sticker categories | GAP | no bundled emoji assets; Shapes+Flags are the only offline categories |
| Masks/chroma key | GAP | heavy engine work |
| New transition types | GAP | native compositor |
| 4K export verification | BLOCKED | device/encoder |
| Multi-select import | BLOCKED | device Photo Picker |
| Physical-device parity | BLOCKED | owner device session |

## Phase 2 — Templates (implemented 2026-11-21)

The Templates tab is no longer a placeholder. It is data plus one reusable
execution engine — there is no per-template code:

- **Schema** (`packages/editor-core/src/templates/types.ts`): identity +
  `version`, category, canvas, fps, duration, background, palette, main-track
  `mediaSlots` (kind/label/start/duration/framing/transform/transition/audio),
  `textSlots` (real default content, label, style, transform) and optional
  bundled `graphics` slots. Everything an apply needs is declared.
- **Pure planner** (`plan.ts`): descriptor + user media/text choices →
  `TemplatePlan`. Clamps videos to their source, keeps stills at full slot
  length, never emits a media element for a slot the user skipped, and never
  drops text overrides. No editor, canvas or storage involved, so the whole
  library is testable headlessly.
- **Executor** (`apply.ts`): creates a NEW project (applying never merges into
  and overwrites the current edit), pins `canvasSizeMode: "custom"` so the
  first imported clip cannot re-adopt the canvas aspect (GitHub #30), inserts
  media on the main track, text on text tracks, graphics on graphic tracks, and
  writes `fade` transitions between adjacent clips — all through the ordinary
  `InsertElementCommand` / `UpdateProjectSettingsCommand` /
  `TransitionsSnapshotCommand` path, so the result is undoable, persisted and
  exported by the same native EDL.
- **Native media hook**: `prepareMedia` runs after project creation (before any
  insert) because `createNewProject` clears the media manager — assets picked
  earlier would be lost. `applyTemplateFromDevice` (mobile-ui) walks the slots
  one pick at a time through `importMediaFromNative`; a cancel/failure leaves
  that slot empty and is reported.
- **Library** (`library.ts`): 12 original templates across 7 categories — Reel
  Pop, Short Hook, Birthday Wish, Romantic Memories, Travel Montage, Cinematic
  Intro, Minimal Slideshow, Product Ad, Poetry Quote, Before & After, Daily
  Vlog, Celebration Montage. Original text and palettes, bundled graphics only,
  no music assets, no network.
- **UI** (`packages/mobile-ui/src/components/panels/templates-panel.tsx`):
  category chips, descriptor-derived preview cards (gradient + the template's
  own headline + duration + aspect), a detail view listing the media
  placeholders and editable text fields, and an apply button that reports empty
  slots instead of failing silently.

Verified locally: 17 template tests (14 library/planner invariants, 3
integration tests that drive the REAL `EditorCore` apply path — canvas/fps/
background pinning, main-track order/durations/framing, transition count and
kind, edited text content, graphics, and the skipped-media path) plus clean
typechecks for `editor-core`, `mobile-ui` and `apps/mobile`, zero ESLint errors
on the touched files, and a successful `vite build` of `apps/mobile`.

Not yet verified: on-device Android UI automation of the Templates journey and
exported-MP4 parity for a template project (needs the emulator/device cycle).

## Next moves (owner-controlled)
1. Run fingertip checks per `docs/qa/qa3-manual-acceptance-4-steps.md`.
2. Confirm versionCode 2 availability in Play Console.
3. Authorize upload of `c42c2e05…51a2` to Closed testing – Alpha only.
4. Reapply for production access after ≈ 2026-11-30.

## Evidence
- Stickers fix: `apps/mobile/public/flags` now contains 271 SVGs matching `apps/web/public/flags`.
- No engineering code changes beyond the asset copy; no protected QA packages touched.
- PR #96 (crop end-to-end + sticker library + lint debt) merged as `ac73e53` with every required check green on the PR head and on merged main (Bun CI 44925424430, Mobile CI 44925424390).
- Templates: `bun test packages/editor-core/src/templates` → 17 pass / 0 fail; `bun test packages` → 813 pass / 0 fail.