# CUTLYRA — FINISH THE REMAINING APP (MISSION V2)

Repo: Pavithran-R-A/Cutlyra
Baseline: main@b8b686890656fbd0301352f180bc6fdc3ad81760

MISSION: Continue autonomously through ALL phases below. Do not stop after one phase.
Resume from this file after runner restarts.

PRs #102–#110 are merged. Do not repeat completed work.

## A. Subtitle completion
Qualify b8b6868 with full CI. Test actual Android SAF import/save. Fix invalid encoding
handling, extension/content validation, cancellation, empty VTT exports and failed writes.
Add SRT/VTT round-trip tests. Implement the real Transcript panel: editable words, cue
timing, split/merge, timeline seeking, styling, undo/redo, persistence and exported
caption pixels.

## B. Multi-select import
Implement or verify mixed video/photo selection, stable insertion order, append/overlay
choice, template slot assignment, duplicate handling, cancellation, progress and
persistent custody. Test the actual Android picker.

## C. Remaining editing features
Complete wipe, dip-to-black/white and blur transitions. Add speed ramps, frame stepping,
snapping, ripple/gap removal, multi-selection, blend modes, improved keyframes and
additional native effects. Inspect existing implementations first. Require preview/export
parity and decoded-frame tests.

## D. Advanced audio
Implement volume envelopes, ducking, reversed audio, waveform accuracy, EQ and practical
offline noise reduction. Preserve voiceover privacy and existing limiter behaviour.
Verify decoded AAC samples.

## E. Creator tools
Verify all 12 templates, Emoji/Flags/Shapes, animated stickers and GIFs through actual
Android UI-to-export journeys. Improve template previews and asset variety. Investigate
multilingual offline captions and stabilization. Use original/licensed assets only.

## F. Comprehensive Android QA
Build an emulator-driven UI acceptance harness. Exercise EVERY visible tab, button, slider,
modal and editing operation. Test import, edit, undo/redo, save/reopen, crash recovery,
archive/restore, cancellation, retry and gallery export. Fix confirmed defects. No
unexplained empty panels or nonfunctional controls.

## G. Performance and release
Test long multitrack projects, memory, startup, scrolling, filmstrips, low storage,
720p/1080p/4K, Android 10–16, edge-to-edge, accessibility and R8. Investigate issue #57.
Reduce lint debt without suppressions. Reconcile issues #22, #47–#52, #56–#58.

## Execution contract
For every feature: inspect, implement, test, verify actual exported media, commit, push, PR,
green CI, merge, verify merged main, update ledger, continue.

Use GitHub Actions API-35 emulator and macOS CI when local tooling is unavailable. Skip only
genuinely blocked operations; continue independent work.

Preserve existing Play AAB, signing, tester enrollment, protected POCO packages and user
projects. No uploads, publication or spending. Keep Cutlyra free and offline.

Produce a qualified isolated QA build and evidence report. Never claim physical microphone,
human gestures or 4K verification without actual evidence.

Start with A, then execute B–G automatically. Do not ask which phase comes next.

END_OF_COMPLETE_MISSION
