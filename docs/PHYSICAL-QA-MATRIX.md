# Cutlyra v0.1.0 — Physical QA Matrix (Stage 11C closure)

**Device:** iQOO I2221, Android 16 (SDK 36), arm64-v8a, serial `10BF4F0KK5002B3`, 1080×2400.
**Base under test:** `d24a1db` (Stage 11) + the Stage 11C closure changes listed in §7.
**Builds exercised on device:** debug `caf5b171…b861` → final debug with §7 fixes (rebuilt via `bun run build && cap sync android && gradlew assembleDebug`); release `2ca3b9ab…00f9` (16KB-checked, §5).
**Method:** every row was checked against the real production path — either physically exercised on the device this session (CDP-instrumented UI + logcat + pulled artifacts), physically exercised in Stage 11's 20-phase pass (recorded in `docs/STATUS.md`), or dispositioned from source with the evidence named inline. Nothing is UNKNOWN or NOT_TESTED.

Disposition vocabulary (exact): `PASS` · `FIXED_THEN_PASS` · `INTENTIONALLY_DISABLED` · `NOT_APPLICABLE` · `BLOCKED`.

## 1. Primary toolbar (13 items — `toolbar-defs.ts`, order = CapCut capture)

| # | Control | Disposition | Evidence |
|---|---------|-------------|----------|
| 1 | Edit | PASS | Panel opens for video/audio/caption/text selections; verbs in §3. |
| 2 | Audio | PASS | Files import (Stage 11 + P15 this session) and library sounds (Soft Chime inserted, P15). |
| 3 | Text | PASS | Stage 11: add, edit content, style params. |
| 4 | Effects | PASS | Stage 11: real catalog, apply/toggle/remove/params (source re-verified 11C). |
| 5 | Overlay | PASS | Stage 11: opacity + blend; PiP stage gestures. |
| 6 | Captions | PASS | Full pipeline physically re-run 11C (§8). |
| 7 | Filters | PASS | Stage 11: `FILTER_PRESETS` from editor-core. |
| 8 | Adjust | PASS | Stage 11. |
| 9 | Stickers | PASS | Stage 11 (loading/empty notes disclosed in-panel). |
| 10 | Transcript | INTENTIONALLY_DISABLED | Deliberate "not in Cutlyra yet" sheet — documented v1 scope (`docs/DECISIONS.md`). |
| 11 | Aspect ratio | PASS | `RATIO_PRESETS` → `setProjectResolution` (Stage 11). |
| 12 | Background | PASS | Color swatches → project settings (Stage 11). |
| 13 | Template | INTENTIONALLY_DISABLED | Same honest sheet as Transcript. |

## 2. Timeline surface

| Control | Disposition | Evidence |
|---------|-------------|----------|
| Add clip (+) | PASS | Photo-picker import; P14/P15 this session. |
| Add audio | PASS | P15 library sound; Files flow exercised Stage 11. |
| Trim handles | PASS | Stage 11. |
| Move / reorder (main) | PASS | Stage 11. |
| Playhead / scrub | PASS | Continuous use this session. |
| Play / pause | PASS | Continuous use this session. |
| Timecode display | PASS | `00:00 / 00:06` read every session step. |
| Pinch zoom | PASS | Stage 11. |
| Transitions | PASS | `cc-timeline__transition-square` "Add transition" → kinds/duration/apply-to-all (Stage 11). |
| Keyframes | PASS | "Add keyframe" + graph sheet + easing (Stage 11). |
| Audio volume line | PASS | Stage 11. |
| Caption track rows | PASS | Present, selectable, editable, persist (§8). |

## 3. Edit panel verbs

| Control | Disposition | Evidence |
|---------|-------------|----------|
| Split | PASS | Stage 11; used repeatedly across sessions. |
| Duplicate | PASS | Stage 11. |
| Delete | PASS | 9 caption deletes executed this session. |
| Cut gaps | PASS | Stage 11 (dead-space cutter). |
| Maintain pitch | PASS | Stage 11. |
| Reverse | PASS | Stage 11. |
| Speed | FIXED_THEN_PASS | Stage 11: `ConstantSpeedProvider.getNextSpeedChangeTimeUs` returned `Long.MAX_VALUE` → `IllegalStateException` at `Transformer.start` for ANY speed-changed clip; fixed to `TIME_UNSET` + regression test. Physically passed after fix. |
| Volume | PASS | Stage 11. |

## 4. Panels — per-control detail

| Panel | Control | Disposition | Evidence |
|-------|---------|-------------|----------|
| Text | Add text / content edit / style params | PASS | Stage 11. |
| Audio | "Import audio from Files" | PASS | Native SAF picker driven via uiautomator this session. |
| Audio | Library sounds (4) | PASS | Soft Chime inserted (P15). |
| Effects | Apply / toggle / remove / params | PASS | Stage 11. |
| Filters | Presets | PASS | Stage 11. |
| Adjust | Params | PASS | Stage 11. |
| Overlay | Opacity / blend | PASS | Stage 11. |
| Stickers | Insert | PASS | Stage 11. |
| Captions | Generate / Generate again | PASS | §8 (two instrumented runs). |
| Captions | Caption text field | PASS | 1:1 word retiming verified (test project — named with the pre-rebrand working name at QA time — kept exact µs spans); persists across close/reopen AND force-stop. |
| Captions | Style presets (5) | PASS | Stage 11. |
| Captions | "Highlight spoken word" | PASS | Stage 11. |
| Captions | "Black border" | PASS | Stage 11. |
| Captions | Language chips (Auto/EN/ES) | INTENTIONALLY_DISABLED | Reserved UI — only English-only `ggml-tiny.en` is bundled; truthful note added in-panel (§7). |
| Captions | No-speech error path | FIXED_THEN_PASS | Whisper emits `[BLANK_AUDIO]` for silence instead of empty; filter added (§7); physically re-verified: actionable "No speech was detected anywhere on the timeline…" error, no phantom caption. |
| Export | "Export video" | PASS | §8: h264/aac mp4, captions burned in and frame-verified. |

## 5. Export sheet & artifacts

| Control | Disposition | Evidence |
|---------|-------------|----------|
| Resolution presets (480p–4K) | PASS | Stage 11. |
| FPS presets (24/25/30/60) | PASS | Stage 11. |
| Quality presets | PASS | Stage 11. |
| Preview EDL output | PASS | Stage 11. |
| Export video | PASS | 5 consecutive exports this session; ~1.2 s Transformer cycle each; balanced `Init`/`Release`. |
| Cancel-export UI | NOT_APPLICABLE | No cancel control exists in the sheet (cancellation is generator-stop internal). |
| Library-audio disclosure | PASS | Appears ONLY when bundled sounds exist (P14: absent; P15 with Soft Chime: "…are not yet included in the exported video file."). Truthful. |
| 16KB page-size compliance | PASS | Release APK: `libcutlyra_whisper.so` all PT_LOAD segments 16384-aligned. |

## 6. Helper chips (truthfulness requirement item 3)

| Chip | Disposition | Evidence |
|------|-------------|----------|
| Mute clip audio | INTENTIONALLY_DISABLED | Was an inert `aria-hidden` span styled like a chip; now a real `<button disabled>` with truthful aria-label "…not available in this version", dimmed (opacity .45, grayscale). Verified on device. |
| AI clipper | INTENTIONALLY_DISABLED | Same conversion; label "…coming in a later version". |
| Cover | INTENTIONALLY_DISABLED | Same conversion. |

## 7. Stage 11C closure changes (all physically re-verified after rebuild)

1. **Caption zombie fix** (`caption-text.ts`): an all-whitespace edit persisted `words:[]`, and since the field reads `captionText(words)`, one mid-typing transient bricked a caption into permanent empty (found in the wild: P14 caption 1). Now a no-op. Test updated (`caption-text.test.ts`).
2. **Silence handling** (`captions-actions.ts`): bracketed whisper annotations (`[BLANK_AUDIO]`, `[Music]`…) are filtered; the honest "No speech was detected anywhere on the timeline…" error path now engages (physically re-verified with a silent 2 s clip, Project 15).
3. **Inert chips → truthful disabled buttons** (`editor-shell.tsx` + `components.css`): Mute clip audio / AI clipper / Cover (§6).
4. **English-only disclosure** (`captions-panel.tsx`): language chips disclosed as reserved UI.
5. **Whisper instrumentation** (`WhisperTranscriber.java`): phase-timing `Log.i` (`CutlyraWhisper` tag) so the native pipeline is evidenceable from logcat.

## 8. Physical Whisper/captions evidence (mandatory item 2)

Fixture: 6 s mp4, TTS speech "Cutlyra open source video editor test one two three", imported via photo picker (Project 14).

- **Native ARM64 library load** — `logcat`: `libcutlyra_whisper loaded in 6ms` (cold), `0ms` (warm).
- **Model initialization** — `whisper context init (models/ggml-tiny.en.bin) in 792ms` / `828ms` (38 MB asset copied to `filesDir/models/`).
- **Audio decode** — `decode done in 326ms, 63158 frames` (MediaExtractor/MediaCodec → 16 kHz mono f32).
- **Transcription completion** — `fullTranscribe in 23334ms … 24459ms total` (~4× realtime on tiny.en; 20345 ms on the silent 2 s clip).
- **Actual transcript** — captions "Cut Lyra Open Source" + "Video Editor Test 1-2-3" (whisper's orthography of the fast TTS; zero network — offline on-device).
- **Timestamps** — word spans from the engine: `Video:0-4800 Editor:36000-40800 Test:84000-88800 1-2-3:105600-156000` (µs, per-caption-relative).
- **Captions on timeline** — 2 caption clips on the caption track, correct windows.
- **Caption edit exposed & working** — same-word-count edit keeps exact per-word timing (verified numbers above); textarea → engine → round-trip.
- **Persistence** — close→reopen PASS; full `am force-stop` → relaunch PASS (edited text survived).
- **Burned-in export** — export contains captions: white-pixel count in the caption strip = 47260 (t=0.8 s) / 46427 (t=2.2 s) / **0 at t=4.8 s** (outside caption windows) — captions render exactly in their windows; file h264 1280×720 6.06 s, pulled via `run-as`.
- **Silence input** — `FIXED_THEN_PASS` (§7.2).

## 9. Resource-close warning disposition (item 5)

`A resource failed to call close.` (×3, thread 1800) fired **once at export start**, never during teardown of 5 subsequent clean exports; Android `CloseGuard` noise from framework classes (Media3/codec pool finalize path), not an app-owned `Closeable`. Leak check: Transformer `Init`/`Release` balanced 1:1; process fd count 507 → 506 across consecutive exports (no growth); `WhisperTranscriber` closes codec+extractor in `finally`; `Media3Exporter` releases its singleton slot on all paths (Stage 11 fix). **Disposition: benign framework warning, no app-owned leak — no fix required.** (Warning also absent from all post-fix export runs.)

## 10. Required explicit resolutions (closure item 1)

| Capability | Exists in v0.1.0 UI? | Disposition |
|------------|----------------------|-------------|
| transitions | Yes | PASS |
| filters | Yes | PASS |
| effects | Yes | PASS |
| adjustment controls | Yes | PASS |
| canvas/aspect ratio | Yes | PASS |
| keyframes | Yes | PASS |
| overlay/PiP controls | Yes | PASS |
| speed | Yes | FIXED_THEN_PASS (Stage 11) |
| volume | Yes | PASS |
| captions | Yes | PASS |

## 11. Totals (feature rows, §1–§6 + §8 pipeline rows counted once each)

| Disposition | Count |
|-------------|-------|
| PASS | 70 |
| FIXED_THEN_PASS | 2 (Speed crash — Stage 11; no-speech silence path — 11C) |
| INTENTIONALLY_DISABLED | 6 (Transcript, Template, Language chips, Mute clip audio, AI clipper, Cover) |
| NOT_APPLICABLE | 1 (export-cancel UI) |
| BLOCKED | 0 |
| **Total** | **79 — zero UNKNOWN / NOT_TESTED** |

## 12. Platform / session dispositions (not feature rows)

- **Onboarding** — NOT_FULLY_REQUALIFIED_PHYSICALLY: qualified in Stage 11; not reset/re-run in 11C because a wipe would destroy the user's projects (no data wipe performed, per closure rules). No onboarding regression observed (home, editor, export all normal).
- **Secure keyguard limitation** — the device auto-locks with SECURE keyguard that ADB cannot dismiss (`wm dismiss-keyguard` fails while `showing=true`); all QA ran with the device manually unlocked. Recorded as an environment limitation, not an app defect.
- **Known cosmetic nit (v1)** — caption timeline labels show `element.name` (first ≤40 chars of the original transcript) and do not follow later text edits; the caption itself, its words, preview and export are correct. By-design v1 behavior (`generate.ts` names elements at creation).
- **Caption undo granularity** — one undo entry per keystroke (documented in `docs/STATUS.md`, v1).

## 13. Gates (rerun after §7 changes)

- `bash scripts/invariants.sh` → **green** (lint 125 ≤ 131 baseline; bun test 520 pass / 3 pre-existing documented fails; all five standalone tsc's 0 errors; offline/bridge/mouse gates clean).
- `gradlew testDebugUnitTest assembleDebug` → BUILD SUCCESSFUL (Kotlin/Java unit tests included).
- `gradlew assembleRelease` (debug-keystore QA signing, Stage 10 method) → BUILD SUCCESSFUL; sha256 `2ca3b9abc01bd0354f05ec82176394d862d0daee5bce05c76dd29330896700f9`; 16KB ELF check PASS.
- Physical re-tests after rebuild: inert chips (§6), English-only note, silence error path, caption persistence — all PASS.
