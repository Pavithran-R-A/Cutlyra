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
- Insertion via `insertStickerElement` → graphic track. **Correction (2026-11-22):** the earlier claim that export was "covered by overlay/crossfade instrumented tests" was wrong — those tests only proved the overlay COMPOSITOR, and stickers were never drawn into an overlay at all. Worse, on Android a sticker clip reached `requireAsset` with no `assetId` and the whole export failed with `ExportUnsupportedException`. Both halves are fixed in Phase 6.
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
- iOS export crop mapper added (EdlCrop in EdlModel, crop threaded through SourcePlacement and applied in TransitionCompositor.place before orientation/fit). Not yet compiled/verified — no Xcode on this machine; verify-export-pipeline harness is the gate.

### 1C Other panels
- Transcript intentionally shows the "not in Cutlyra yet" sheet (per `docs/DECISIONS.md`). Template is now a real library — see Phase 2.
- Filters/Adjust exposed and export-safe (#48 scoped slice).
- Background panel offers color swatches; blur background exists in engine/web but native Android export does not honor it, so not exposed on mobile (consistent with "no preview-only tools").

## Open gaps (NOT PLANNED unless noted)

| Feature | State | Blocker / owner |
| --- | --- | --- |
| Reverse | PARTIAL (param only) | native reverse-media generation + UI — Phase 1 of the 2026-11-25 qualification program |
| Freeze frame | IMPLEMENTED + DECODED-MP4 VERIFIED (2026-11-25) | source-frame capture at the trim/retime-mapped instant, persisted provenance, ripple insert, hold/remove UI; see Phase 7 |
| GIF import (media type + timing) | IMPLEMENTED + DECODED-MP4 VERIFIED (2026-11-25) | real per-frame decode with per-frame delays + loop count, EDL frame feed, decode-based export preflight; see Phase 7 |
| Per-clip crop | IMPLEMENTED; preview pixels + Android native export verified; iOS mapper implemented (unverified build) | physical-device fingertip check pending; iOS build verification pending (no Xcode) |
| Background blur (mobile) | GAP (engine exists) | native Android export support — Phase 2 of the 2026-11-25 qualification program |
| Voiceover recording | GAP | RECORD_AUDIO permission + recorder |
| SRT/VTT import/export | EXPORT + PASTE IMPORT (mobile); no file picker | native document picker for `.srt`/`.vtt` files |
| Text shadow | IMPLEMENTED for text elements AND captions (preview + native export by construction) | caption shadow shipped 2026-11-22; no exported frame sampled |
| Audio fades | IMPLEMENTED (params + EDL envelope + Android ramp + panel; decoded-audio test in CI) | iOS export ignores the envelope; no per-clip fade on library sounds until re-materialised as uploads |
| Sticker/graphic export | IMPLEMENTED (prerendered overlay + native skip) | no emulator run of the full app journey yet |
| Animated stickers (procedural graphics) | IMPLEMENTED + TESTED (6 animated graphic definitions; time-aware GraphicNode; preview+export via existing overlay pipeline; 21 unit tests pin time-dependence, determinism, static invariance and loop boundaries) | device/native export verification pending | |
| Templates | IMPLEMENTED (12 offline templates + schema/planner/apply engine, UI wired) | No on-device Android UI-automation or exported-MP4 parity run yet |
| Emoji / non-shape sticker categories | IMPLEMENTED (procedural data-URL SVG provider, 20 emoji tiles) | device/UI verification pending; no bundled binary assets (offline by construction) |
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

## Phase 3 — Subtitle import (implemented 2026-11-22)

The Captions panel could already export SRT; importing subtitles existed only in
`apps/web`'s dev harness, whose parser reaches into DOM text measurement and is
not in the mobile bundle. Import is now a shared, DOM-free engine feature:

- **Parser** (`packages/editor-core/src/captions/subtitles.ts`,
  `parseSubtitleText`): SRT and WebVTT, format detected from the `WEBVTT`
  header. Handles BOM/CRLF, cue identifiers, VTT cue settings after the end
  timestamp, VTT `NOTE`/`STYLE`/`REGION` blocks, SRT position data, VTT's short
  `MM:SS.mmm` timestamps, ASS override tags (`{\an8}`), HTML-ish inline tags and
  the entities subtitle files actually carry. Malformed blocks are counted
  (`skippedCueCount`) instead of failing the whole file; a cue-less document
  returns a warning, never a throw.
- **Builder** (`buildCaptionElementsFromCues`): one caption element per cue with
  the cue's own start and duration — deliberately NOT run through
  `chunkTranscriptSegments`, which would retime imported subtitles. Words get
  synthetic per-word times spread proportionally to word length, because
  `CaptionElement` (karaoke rendering, per-word editing, split, EDL
  `captionWords`) requires them while a subtitle file only carries cue timing.
- **Phone wiring** (`importCaptionsFromText` in
  `packages/mobile-ui/src/editor/captions-actions.ts`): parse -> build -> inherit
  existing caption layout/highlight params -> `insertGeneratedCaptions`, i.e. the
  same undoable `AddTrackCommand` + `InsertElementCommand` batch "Generate"
  uses. Nothing else in preview or native export changed; imported captions ride
  the burn-in path already verified for generated captions.
- **UI** (`captions-panel.tsx`): an "Import SRT / VTT" textarea and button,
  reporting how many cues were imported and how many blocks were skipped. Paste
  is used instead of a file picker because neither shell has a native text-file
  bridge yet (the backup/restore SAF path returns archives, not arbitrary
  files); the paste path behaves identically in the Android WebView and the dev
  harness with no new permission surface.

Verified locally: `bun test packages` -> 826 pass / 0 fail (13 new tests in
`captions/__tests__/subtitles.test.ts`, covering parser edge cases, cue->element
timing/word invariants, the import->export SRT round trip, and an imported cue
reaching the real `buildEdl` descriptor as a schema-valid caption overlay with
per-word timings); clean `tsc --noEmit` for `editor-core`, `mobile-ui` and
`apps/mobile`; zero ESLint errors on the touched files.

Not yet verified: the panel itself has not been driven on a device or in a
browser (the import data path is tested, the button wiring is typechecked and
linted only), and there is still no `.srt`/`.vtt` file picker.

## Phase 4 — Text drop shadow (implemented 2026-11-22)

Text was the one overlay kind where preview and native export already share a
single rasterizer: `renderTextToContext` draws into the preview's canvas, and
`export/overlay-frames.ts` calls the SAME function at export resolution and
hands the PNGs to the native `PrerenderedOverlay`. So the shadow needed one
draw path, not a Swift/Kotlin twin, and preview/export parity holds by
construction (the same argument that closed text/caption drift in round 37).

- **Params** (`params/registry.ts`, `timeline/defaults.ts`): `shadowEnabled`,
  `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY`. Blur and
  offsets are PERCENT OF FONT SIZE — the same unit as `strokeWidth` — so the
  shadow keeps its proportion to the glyphs at any canvas size or export
  resolution. Off by default; existing projects keep their exact look because
  the toggle defaults to `false`.
- **Drawing** (`text/primitives.ts`): `drawTextShadow` is its own pass, drawn
  BEFORE the border and fill so it sits behind both, and it saves/restores the
  context so `shadow*` state never leaks into the border, the glyph fill or a
  text background pill. Zero blur + zero offsets draws nothing.
- **Resolve/render** (`services/renderer/resolve.ts`, `nodes/text-node.ts`):
  the resolver reads the params (defaults applied), `renderTextToContext`
  converts percent -> pixels exactly like the border does, and the existing
  params-based texture cache key means a shadow change re-rasterizes the text
  layer.
- **UI** (`text-panel.tsx`, `editor/actions.ts`): a "Shadow" toggle plus a
  "Shadow blur" slider, writing through the ordinary undoable
  `UpdateElementsCommand`. `setTextShadowEnabled` seeds any missing shadow
  params in the SAME history step, so text created before this feature gets a
  visible default rather than an invisible zero-blur shadow.

Verified locally: 4 new tests (`text/__tests__/text-shadow.test.ts`) using a
recording Canvas2D double that honours `save`/`restore` — they assert paint
order (shadow, then border, then glyphs), the percent -> pixel conversion at a
known font/canvas size, per-line placement, no shadow-state leak, and the off
switch. `bun test packages` -> 830 pass / 0 fail; clean `tsc --noEmit` for
`editor-core`, `mobile-ui`, `apps/mobile`; zero ESLint errors on touched files.

Not verified: no exported frame or screenshot was sampled for the shadow — the
tests exercise the real render function with a recording context, not real
pixels. Captions do not get a shadow yet (caption word drawing is a separate
path in `caption-node.ts`).

## Phase 5 — Per-clip audio fades (implemented 2026-11-22)

Fade in / fade out on audio AND video clips, end to end:

- **Params** (`params/registry.ts`, used by `audio` and `video` elements):
  `fadeIn` / `fadeOut` in SECONDS (the unit transition lengths are authored in).
  Non-keyframable; absent means 0, so every existing project is untouched.
- **Clamp + envelope** (`timeline/audio-fades.ts`): `clampAudioFades` clamps
  each side to the clip length and, when the two together exceed the clip,
  scales both proportionally (a 1s + 1s fade on a 1s clip becomes 0.5 + 0.5).
  `buildAudioFadeParamsPatch` is the panel's write (same rule, rounded to
  milliseconds); `buildAudioFadeEnvelope` converts seconds to TICKS and returns
  `null` when there is no fade; `audioFadeGainAt` is the linear ramp (min of
  the two ramps where they overlap).
- **EDL** (`edl/types.ts`, `edl/build.ts`, `schema/edl-v1.json`,
  `edl/validate.ts`): optional `clip.audioFade = { inTicks, outTicks }` in
  ticks of the clip's TIMELINE span. OMITTED for unfaded clips, so those
  descriptors are unchanged; `validateEdl` rejects negative or over-long
  envelopes; the schema entry makes the shape part of the frozen v1 contract.
- **Android export** (`Edl.kt`, `EdlParser.kt`, `AudioFadeMath.kt`,
  `AudioGainProcessors.kt`, `EdlToComposition.kt`): `ClipGainAudioProcessor`
  (already the per-clip volume stage) now also applies the envelope per PCM
  frame, after converting the timeline fade window to SOURCE frames through
  the clip's speed rational. Media3 1.11's own `GainProcessor` is a constant
  gain (its documented range 0..1, built for one-shot fades), so a
  time-varying ramp has to live in the existing `BaseAudioProcessor` — which
  it does, in the same pass as the volume gain and the look-ahead limiter.
  When there is no envelope the processor takes its original constant-gain
  path (and is inactive at 0 dB), so unfaded output is unchanged.
- **UI** (`edit-panel.tsx`, `editor/actions.ts`, `editor-shell.tsx`): "Fade in"
  and "Fade out" sliders on every audio/video clip, each capped at the clip
  length minus the other side, written as ONE undoable `UpdateElementsCommand`
  patch through `setAudioFades`.

Verified locally: TS — 20 new assertions across
`timeline/__tests__/audio-fades.test.ts` (ramp shape both sides, overlap takes
min, proportional clamp, zero/absent = flat unity, schema-validated EDL,
unfaded descriptor has no `audioFade` key, video clips too),
`timeline/__tests__/audio-fades-undo.test.ts` (real `EditorCore`:
execute -> params -> undo -> absent -> redo -> same envelope), and a
save/reopen test in `scene-serialization.test.ts` (params survive a structured
clone). Kotlin: `AudioFadeMathTest` (JVM ramp shape + tick->source-frame
conversion) and two `EdlParserTest` cases (absent = null, envelope parsed).
`bun test packages` -> 849 pass / 0 fail; `tsc --noEmit` clean for
`editor-core`, `mobile-ui`, `apps/mobile`; ESLint clean on touched files.

Decoded-audio verification: `ExportAudioFadeInstrumentedTest` exports a
tone-only WAV clip twice (with and without an envelope), decodes the MP4's
audio track and compares RMS windows (early ramp, quarter point, middle, late
ramp, tail) plus a control that an unfaded clip stays level at both edges. It
runs in the existing Android instrumentation job. **Local execution of that
test and of the Kotlin unit tests is blocked on this machine**: there is no
`adb`/emulator, and `./gradlew testDebugUnitTest` fails at
`:capacitor-android:compileDebugJavaWithJavac` with `invalid source release:
21` (the installed JDK is older than the project's toolchain). Both are run by
CI (`mobile-ci.yml` `gradlew testDebugUnitTest` and the API-35 instrumentation
job); their results are the sample-level evidence, not this machine.

Not covered: iOS audio export does not read `audioFade` yet; fades on bundled
library sounds apply once the sound is materialised as a file-backed upload
(the existing library-audio path).

## Phase 6 — Stickers and graphics actually export (2026-11-22)

Two independent defects made a sticker-bearing project unusable outside the
preview:

1. **Android export failed outright.** Sticker/graphic clips live on a
   `GRAPHIC` overlay track, and `EdlToComposition` built every overlay clip as
   a PiP media item. A sticker has no `assetId` (it is generated content), so
   `requireAsset` threw `ExportUnsupportedException` and no export was
   produced. Fix: `EdlToComposition.isPrerenderedOverlayClip` skips sticker,
   graphic, text and caption clips that carry no asset. A VIDEO/IMAGE clip with
   a missing asset still throws — that is a real broken project and must be
   surfaced.
2. **Nothing drew the sticker into the exported pixels.** `renderOverlayFrames`
   only included text and caption tracks, so even after the crash was fixed a
   sticker would simply be absent. Fix: graphic tracks are now part of the
   overlay pass, and the new `export/visual-overlay.ts` builds each sticker's
   draw plan from the SAME `computeVisualTransform` the preview compositor
   uses — framing (fit/fill), crop source rect, position, scale, rotation,
   flip and opacity — then draws the source into the existing full-canvas
   overlay PNG. Export and preview therefore share one geometry
   implementation, and stickers ride the overlay compositor that already has
   decoded-frame instrumentation coverage.

Safety: a missing sticker asset now degrades to "that sticker is not drawn"
instead of rejecting the render tree, and the failed load is evicted from the
sticker cache so a later attempt can succeed. This also removes a preview
crash for projects whose sticker asset disappeared.

Tests: 9 headless geometry tests in `export/__tests__/visual-overlay.test.ts`
(fit/fill, crop sampling, intrinsic-vs-decoded size, flip/rotation, opacity,
missing/degenerate source, which tracks are rasterized) and 2 regression tests
in `renderer/__tests__/missing-sticker.test.ts`; a JVM test
`PrerenderedOverlayClipTest` pins the native skip predicate. `bun test
packages` → 860 pass / 0 fail (851 before this change).

**Not yet proven:** no decoded-frame run exists for a sticker inserted through
this machine's Android app (there is no local `adb`/emulator here, and the
repository has no CI-driven job that drives the app's WebView to export a
project with stickers). The geometry and the native skip are unit-verified;
the end-to-end app journey (insert → move → save → reopen → export → decode)
and the template journeys remain device-unverified.

## Phase 7 — GIF and Freeze Frame completed (2026-11-25)

Both features now run from the UI through decoded exported pixels; the earlier
metadata-only bridge methods are gone.

**Freeze Frame**
- Capture decodes the clip's SOURCE frame at the instant the timeline maps to
  (`freezeSourceTimestampMicros`, trim + retime rate), using
  `MediaMetadataRetriever.getFrameAtTime(ts, OPTION_CLOSEST)` — deliberately
  not `OPTION_CLOSEST_SYNC`, so the frame is never substituted with an
  unrelated keyframe. An instant outside the source range is refused with
  `CAPTURE_OUT_OF_RANGE`; there is no clamp and no fallback still.
- Persistence is real: `persistFreezeFrame` does a read-modify-write through
  `storageService` and resolves only after the write, and provenance is part
  of `MediaAssetData.freezeFrame` through save, reopen, backup and restore.
- The insert is a non-destructive main-track split + still interval with
  ripple, adjustable hold, undo/redo, and pruning of captures the project no
  longer references. Audio: silent hold; audio before keeps its pre-split
  portion; audio after starts at the new trim start.

**GIF**
- Import decodes every frame with its own delay and the file's own loop count
  (Netscape count; 0 = endless). Transparency is honoured per frame via the
  graphic-control transparent index with disposal 0/1/2/3 applied between
  frames, so a transparent GIF keeps its transparent pixels rather than
  flattening to black. The Kotlin decoder and the TypeScript fallback apply
  the same disposal/delay rules.
- Memory is bounded by an explicit budget (1500 frames / 512 MB of decoded
  RGBA, identical constants on both decoders). Above it the import refuses
  with a typed error naming the limit instead of risking an OOM; the
  per-frame PNGs are written one at a time, so the writer itself is streaming.
- Export feeds the decoded frame URIs and per-frame delays through
  `EdlGifAsset`/`EdlGifFrame` + `GifFrameTimeline` + `EdlToComposition`, and
  `prepareGifExport` decodes every referenced frame as a preflight before the
  export starts (`GIF_FRAMES_MISSING`, `GIF_FRAME_UNREADABLE`).
- Loop rule: endless GIF → one loop of content inside the clip's authored
  duration (it wraps, then the file ends); finite GIF → `loopCount × loop
duration`, holding the last frame after the final loop.

**Evidence:** instrumented exports decode the MP4 and sample pixels — freeze
holds red at 0.25 s and 1.0–1.4 s, green at 2.0 s, blue at 3.0 s (~4 s total),
and the GIF pipeline test asserts the exported frame order and timings for a
non-uniform-delay GIF. `FreezeFrameCaptureTest` (5), `GifExportPreflightTest`
(4), `GifDecoderBudgetTest` (2) and the TypeScript suite cover the pure logic;
Bun CI and Mobile CI are green on the merge head.

**Remaining limitations:** exotic/malformed GIF variants refuse with
`GIF_DECODE_FAILED` and the reason rather than partially rendering; the picker
interaction itself was not driven by hand on a physical device.

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
- Subtitle import: `bun test packages/editor-core/src/captions` → 59 pass / 0 fail; `bun test packages` → 826 pass / 0 fail.
- Text shadow: `bun test packages/editor-core/src/text` → 4 new tests pass; `bun test packages` → 830 pass / 0 fail.
- Audio fades: `bun test packages` → 849 pass / 0 fail (fade math, undo/redo, save/reopen, schema-valid EDL); Kotlin `AudioFadeMathTest` + `EdlParserTest` fade cases and `ExportAudioFadeInstrumentedTest` run in Mobile CI.
- Sticker export repair: `bun test packages` → 860 pass / 0 fail (9 visual-overlay geometry tests, 2 missing-asset regressions); `PrerenderedOverlayClipTest` added to the JVM suite; typecheck + ESLint + `scripts/invariants.sh` green.