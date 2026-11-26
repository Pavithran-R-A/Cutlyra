# CUTLYRA — Remaining Feature Completion Master Goal

Repository: `Pavithran-R-A/Cutlyra`

Verified main at mission receipt: `05c0ba69a895b99ec76208e40be3d747ae1e7b08`

> Persistence note: the mission prompt delivered to the agent was truncated
> mid-Phase 4 (at "Export real SRT/VTT files through system save/sha") and the
> promised final marker `END_OF_COMPLETE_MISSION` was **not** present. Everything
> received is recorded verbatim below. Phases beyond the truncation point must
> be requested explicitly before they are treated as scope.

## OBJECTIVE

Complete all remaining practical Android video-editor features, repair existing
limitations, and qualify Cutlyra as a polished, reliable, fully functional
application.

PRs #102–#106 are already merged. All seven merged-main CI checks are green.

Do not repeat completed GIF, Freeze Frame, Reverse, Background Blur, Sharpen,
Vignette or Voiceover implementations.

## MISSION PERSISTENCE

The previous mission was truncated.

Immediately save this complete mission to
`docs/CUTLYRA_REMAINING_FEATURE_MISSION.md` and maintain a persistent execution
ledger.

The final marker of this prompt is `END_OF_COMPLETE_MISSION`.

If that marker is present, the entire mission was received. You have
authorization to execute every phase without asking which ordinary engineering
task to tackle next.

Use the existing master plan, feature coverage matrix and GitHub issues #22,
#47–#52 and #56–#58 as additional execution sources.

Continue automatically between phases.

## PHASE 1 — REPAIR EXISTING LIMITATIONS

1. Voiceover lifecycle: inspect PR #106. Recording reportedly continues when the
   application backgrounds. Make foreground-only recording the default, safely
   finalizing or cancelling on lifecycle interruption. Handle microphone
   permission revocation, screen lock, process death and low storage. Verify no
   hidden recording continues.
2. Fix stacked Adjust/Filter processing-order discrepancies disclosed in PR #105.
   Preview and Android export must apply identical effect ordering.
3. Audit generated-media cleanup for Reverse, GIF, Freeze Frame and Voiceover.
   Preserve assets needed by Undo/Redo, saved projects and backups.
4. Verify GIF timing, finite/infinite loop behaviour, transparency and bounded
   memory.
5. Correct stale documentation and issue checklists.

Add regression tests and merge a focused PR with green CI. Continue immediately.

## PHASE 2 — CHROMA KEY AND MASKS

Implement complete green-screen removal and masking.

Chroma key:

- User-selectable key colour.
- Colour picker/eyedropper.
- Tolerance and similarity.
- Edge softness.
- Spill reduction where practical.
- Transparent composition over lower video/image layers.

Masks:

- Rectangle, circle, ellipse and linear.
- Position, size, rotation.
- Feathering and inversion.
- Editable visual handles.
- Compatibility with crop, transforms, opacity and keyframes.

Use shared parameter semantics across TypeScript, WASM/WGSL, EDL and Android
Media3 custom GL effects.

Investigate the existing compositor and alpha-preservation path. A custom shader
is authorized. Do not abandon the feature merely because several rendering
layers require modification.

Verify real preview pixels and decoded Android MP4 output using deterministic
foreground/background fixtures.

Include transparent overlays, combined masks and chroma key, rotated/cropped
media and persistence.

Do not expose controls that only affect preview.

## PHASE 3 — ADVANCED TRANSITIONS

Expand the current cut/crossfade architecture with:

- Slide.
- Push.
- Wipe.
- Zoom.
- Dip to black/white.
- Blur transition where practical.

Implement reusable transition definitions rather than unrelated special cases.

Support duration, direction, preview, timeline overlap, undo/redo, save/reopen
and native export.

Define audio behaviour explicitly.

Decode exported frames at the start, midpoint and end of every transition.
Verify duration, frame continuity, layer order and audio synchronization.

Preserve existing crossfade behaviour.

## PHASE 4 — REAL SUBTITLE FILES AND TRANSCRIPT EDITOR

Complete the Captions experience.

- Native Android SAF selection of `.srt` and `.vtt` files.
- Actual file reading with sensible size and encoding limits.
- Reuse the existing shared subtitle parser.
- Preserve cue timing and report malformed entries.
- Export real SRT/VTT files through system save/sha[REMAINDER NOT RECEIVED — prompt truncated here.]
