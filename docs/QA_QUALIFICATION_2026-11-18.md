# Cutlyra v0.1.1 — engineering qualification report (2026-11-18)

Autonomous overnight session against the repository at
`C:/Users/Pavithran R A/Downloads/cutlyra`. Everything below is either an executed
command with its output retained, or explicitly marked as not done. No Google Play
upload, rollout, track change, tester message or application re-submission was
performed in this session.

## 1. Headline status

Four separate gates. They are not interchangeable, and none of them is "done".

| Gate | Status | What that means |
|---|---|---|
| **ENGINEERING QUALIFIED** | **YES, with the caveats in §9** | Local unit/typecheck/lint gates pass, three PRs merged with all seven hosted jobs green on every head, merged-main CI re-verified per merge, and the previously red `QA3 signed APK` job is green on main. |
| **DEVICE QUALIFIED** | **NO — PARTIAL** | 5 of 8 physical matrix rows PASS, 3 PARTIAL, 0 FAIL. Four finger-dependent checks were not performed. |
| **ALPHA RELEASE READY** | **PREPARED, NOT UPLOADED** | Release notes, tester checklist, feedback template, guardrails and supersession analysis exist. No Play Console action taken; owner authorization for upload was never given. |
| **PRODUCTION APPROVED** | **NO** | Google rejected production access on 2026-11-16 and requires 14 more days of closed testing (earliest reapplication ≈ 2026-11-30). Not eligible. |

## 2. Commits

| | SHA |
|---|---|
| Starting `origin/main` | `c4d1a4f136a3ed2b57f3f89d0b7114ac4fdbfea4` |
| Final `origin/main` measured here | `585569a926b342dbacc8e7d883339847a6d2bfd0` (this report merges afterwards in #92) |

`c4d1a4f` matched the SHA named in the mission statement, so the Phase 0 check
confirmed the stated baseline rather than assuming it.

## 3. Phase 0 — what the repository actually said

Verified with `gh`, not from the historical narrative:

- **Open PRs: none.** Open issues: #22, #47, #48, #49, #50, #51, #52, #56, #57, #58 —
  all pre-existing feature/quality backlogs, none introduced or closed by this session.
- **The merged history does match the mission's list**: #69, #72–#74, #75/#76, #77, #78,
  #81, #82, #83–#85, #86, #87, #88 are all merged as described.
- **Local tree**: branch `docs/play-aab-verified` at `8ca4492`, 29 untracked entries
  (QA evidence directories, previous reports, `play-artifacts-dl/`), 2 stashes.
  All preserved. No force-push, no branch deletion, no cleanup of evidence. One
  `git reset --hard origin/main` was used once, on the local `main` branch while it held
  no local commits, to move it onto verified remote; untracked evidence was untouched
  (29 entries before and after) and every work branch was created from `origin/main`
  rather than from that branch.
- **Merged-main CI was not fully green.** `QA3 signed APK` is red on `c4d1a4f`
  (run 43846948287). Bun CI and Mobile CI are green on the same commit. That red job is
  the subject of §5.

## 4. Work delivered

| PR | Title | Branch | Merge |
|---|---|---|---|
| [#89](https://github.com/Pavithran-R-A/Cutlyra/pull/89) | `fix(preview): stop banking drag movement that was never shown` | `fix/preview-slop-banking` | `6b8830595be2a90544dbe2c2190baa2d9953f12b` |
| [#90](https://github.com/Pavithran-R-A/Cutlyra/pull/90) | `ci(qa3): enable KVM before the emulator smoke` | `fix/qa3-emulator-kvm` | `53ca33a74e173f3728e98b9af58eb7f67c3663fe` |
| [#91](https://github.com/Pavithran-R-A/Cutlyra/pull/91) | `test(timeline): pin one Duplicate action to exactly one copy` | `test/duplicate-one-action` | `585569a926b342dbacc8e7d883339847a6d2bfd0` |
| [#92](https://github.com/Pavithran-R-A/Cutlyra/pull/92) | `docs(qa): QA3 evidence index, Alpha prep and qualification report` | `docs/qa3-qualification-20261118` | open at time of writing (this PR) |

### Files changed

- `packages/mobile-ui/src/components/editor/preview-gesture.ts` — `bank` parameter on
  `applyPointerTopologyChange`; `DRAG_SLOP_PX` and `centroidMovedBeyondSlop` moved here
  so the handlers and the tests share one threshold.
- `packages/mobile-ui/src/components/editor/preview-renderer.tsx` — both pointer
  handlers pass `bank: session.dragging`; the slop check calls the shared predicate.
- `packages/mobile-ui/src/components/editor/preview-gesture.test.ts` — harness mirrors
  the slop gate and the banking rule; +5 regression tests.
- `packages/editor-core/src/commands/timeline/element/__tests__/duplicate-elements.test.ts`
  — new; 9 tests pinning one Duplicate action to exactly one copy (complaint D had no
  command-level coverage at all).
- `.github/workflows/qa3-apk.yml` — `Enable KVM` step before the emulator smoke.
- `scripts/qa/qa3-evidence-index.sh` — new; derives the evidence index and the
  machine-readable QA summary from the RESULTS.md rows.
- `qa3-evidence-poco-20261118/RESULTS.md`, `EVIDENCE_INDEX.md`, `QA_SUMMARY.json` —
  physical acceptance report, hashed file index, computed totals.
- `docs/PLAY_ALPHA_0.1.1_RELEASE_PREP.md` — Alpha preparation, tester feedback
  template, supersession analysis.
- `docs/qa/qa3-distribution.md` — the QA3 signer digest placeholder replaced with the
  verified value.
- `docs/QA_QUALIFICATION_2026-11-18.md` — this report.

## 5. Defects found and fixed

### D1 — Drag movement that was never shown still moved the element (P1, code)

**Reproduced:** by reading the pointer path against the PARTIAL row-2 result, then
recording it numerically in a unit test. Not reproducible with `adb shell input`,
which cannot inject two pointers.

**Root cause:** `usePreviewTransformGesture` withholds the preview below
`DRAG_SLOP_PX` (6 CSS px), so a tap stays a tap. But `applyPointerTopologyChange`
banked `gestureTransform(...)` — computed from the current pointers — whenever a finger
joined or left, regardless of whether that transform had ever been presented. Below the
threshold nothing had been presented, so the *unseen* delta became the new anchor and
the first real move jumped the element by it. PR #82 fixed the same class of bug for the
above-threshold case (it read the transform after mutating the pointer set); this is the
residual sub-threshold half.

**Fix:** `bank` parameter. `bank: true` keeps #82's ordering guarantee (read before
`mutate`). `bank: false` leaves the anchors where the element actually is and only moves
the delta origin. Handlers pass `bank: session.dragging`.

**Evidence:** five tests in `preview-gesture.test.ts`, including the pre-fix value
recorded numerically (a 4 CSS px wobble banks 8 canvas units that were never on screen),
a wobbling two-finger tap that commits nothing, and a duplicate pointer-up that cannot
commit twice. Row 2 of the device matrix stays PARTIAL: this is a source-level fix plus
deterministic tests, not finger testing.

### D2 — QA3 signing workflow red on main, misattributed to the artifact (CI, not product)

**Reproduced:** run 43846948287 on `c4d1a4f`.

**Root cause:** every build/sign/verify step passed. The log then shows
`You're running a Linux VM where hardware acceleration is not available.`, ~16 minutes of
`getprop sys.boot_completed` polling, and `##[error]Timeout waiting for emulator to boot.`
The QA3 workflow was the only emulator job in the repository without the `Enable KVM`
step that `mobile-ci.yml` has on both instrumentation jobs. Without `/dev/kvm` the
x86_64 API-35 image never boots, so a correctly signed artifact was reported as a failed
one.

**Fix:** the same `Enable KVM` step, placed before the emulator, so an unusable runner
fails in seconds naming the real cause. See §8 for how it was verified.

## 6. Tests and checks actually run

### Local

| Check | Result |
|---|---|
| `bun test packages apps/web/src apps/mobile/src` | **790 pass / 0 fail**, 3985 assertions, 96 files (baseline at `c4d1a4f`: 781/0; 786 after the gesture fix, 790 after the duplicate coverage) |
| `tsc --noEmit` (packages/mobile-ui) | 0 errors |
| `eslint` on the three touched mobile-ui files | only the two pre-existing `no-unsafe-type-assertion` errors at `preview-renderer.tsx:95,109` (WebGPU typings, untouched) |

### Hosted CI

Seven jobs are applicable. Every one ran on each exact PR head, and merged main was
re-checked separately per merge commit. All seven ran on every PR head, and Bun CI + Mobile CI
(which contains the other five) were re-checked on each merge commit on `main`:

| Job | #89 head | #90 head | #91 head | merged main |
|---|---|---|---|---|
| invariants (ubuntu-latest) | pass 2m46s | pass 3m18s | pass 2m20s | pass (`6b88305`, `53ca33a`, `585569a`) |
| invariants (windows-latest) | pass 7m27s | pass 6m15s | pass 7m57s | pass (`6b88305`, `53ca33a`, `585569a`) |
| invariants (macos-latest) | pass 7m05s | pass 7m09s | pass 6m51s | pass (`6b88305`, `53ca33a`, `585569a`) |
| iOS (simulator, unsigned) | pass 2m35s | pass 2m02s | pass 2m07s | pass (`6b88305`, `53ca33a`, `585569a`) |
| Android (debug APK) | pass 5m07s | pass 3m35s | pass 5m16s | pass (`6b88305`, `53ca33a`, `585569a`) |
| Android instrumentation (API 35) | pass 12m25s | pass 8m40s | pass 12m04s | pass (`6b88305`, `53ca33a`, `585569a`) |
| Android instrumentation (R8 test variant) | pass 10m08s | pass 12m21s | pass 13m21s | pass (`6b88305`, `53ca33a`, `585569a`) |

No job was skipped, no assertion weakened, no baseline raised, no `paths-ignore`
expanded. The lint/typecheck/test baselines in `scripts/invariants.sh` are unchanged.

`QA3 signed APK` is a separate, dispatch-only workflow on `main`; §8 covers it.

### Android instrumentation

- API 35 emulator job: **61 tests**, 0 failed, 0 skipped — verified in the #89 run's
  log (`Tests 60/61 completed. (0 skipped) (0 failed)`) and reproduced on each head.
- R8 test variant: **61 tests** on the release-like minified variant, `Starting 61
  tests`, 0 failed.

So the gesture fix was exercised on Android through the same instrumented suite that
gates release, not only by the TypeScript tests.

### Not run in this session

- Android instrumentation and iOS builds were **not** run locally — no Linux KVM host, no
  macOS. They were taken from hosted CI only.
- No Play-delivered smoke test: that requires an authorized upload first.
- The new QA3 APK from `53ca33a` was not installed on the phone (needs owner approval), so
  no physical evidence in this session covers the #89 fix.

## 7. Physical device evidence

Device: POCO M4 Pro 5G (`22031116AI`), serial `CIUWEMJBPBDUWC7D`, Android 13 (API 33),
MIUI V816. Package `app.cutlyra.editor.qa3`, versionName `0.1.1`, versionCode `2`,
APK SHA-256 `c68af3bb4baabc4e115ec3d059751468d7e213ad08eddb88eee61cd6d0a3544f`
(the artifact from workflow run 43841922109, re-verified byte-for-byte before installing).

Computed from the case rows by `scripts/qa/qa3-evidence-index.sh`:

| Classification | Rows |
|---|---|
| TOTAL | 8 |
| PASS | 5 |
| PARTIAL | 3 |
| FAIL | 0 |
| BLOCKED | 0 |

PASS: lane ordering + duplication, filmstrip thumbnails, export with audible audio,
save/reopen, non-destructive backup/restore.
PARTIAL: drag/resize/pinch; rotation/Fit-Fill geometry (Fit and export geometry PASS,
device rotation not tested); Replace Clip + undo/redo (undo/redo PASS, Replace Clip
blocked in the WebView by synthetic-tap selection).

**Unplanned data-integrity result.** Mid-session, MIUI's memory cleaner hibernated QA3 and
the platform removed the activity with `app died, no saved state`. The crash buffer has
no Cutlyra entry, so this was the OS reclaiming a backgrounded app, not an app failure.
Relaunching listed **both** projects, both at `0:11`. Work survived an OS-initiated
process death on real hardware — which is still not a deliberate kill-during-write test
(that needs the separate destructive-testing authorization).

Full report: `qa3-evidence-poco-20261118/RESULTS.md`.
Hashed file list: `qa3-evidence-poco-20261118/EVIDENCE_INDEX.md`.
Machine-readable: `qa3-evidence-poco-20261118/QA_SUMMARY.json`.

Raw screenshots (`01`–`53`), screen dumps, the exported MP4 and the ffprobe/ffmpeg
outputs remain **untracked on disk**, matching this repository's existing convention for
`qa-final-*` evidence directories. The index records each file's SHA-256 so the
uncommitted bytes are still auditable.

## 8. The CI fix, verified

The fix was verified the only way this workflow can be verified: dispatched on `main`
after merge.

Run [44364210809](https://github.com/Pavithran-R-A/Cutlyra/actions/runs/44364210809) on
`53ca33a` — **success**, every step green:

| Step | Result |
|---|---|
| Refuse anything but a main dispatch | success |
| Prove the source commit is qualified main | success |
| QA3 signing gate | success |
| `gradlew assembleQa3` (QA3 key) | success |
| Verify QA3 identity, signature and payload | success |
| **Enable KVM** (new) | success |
| **Emulator smoke (API 35)** | **success — 1m59s** |

Smoke output, verbatim: `SMOKE: apk=app/build/outputs/apk/qa3/app-qa3.apk`, `SMOKE:
installed`, `SMOKE: package app.cutlyra.editor.qa3 present`, `SMOKE: independent storage
(uid=10209)`, `SMOKE: launched`, `SMOKE: process alive`, `SMOKE: no fatal crash`,
`SMOKE: resumed`, `SMOKE: QA3 emulator smoke passed`.

The comparison that matters: the emulator step was **16 minutes of boot polling ending in
timeout** on `c4d1a4f`, and is **1m59s of real install/launch/coexistence assertions** on
`53ca33a`. The previously red job is now green for the right reason.

**New QA3 artifact note.** This run produced a fresh QA3 APK from `53ca33a`
(102,920,778 bytes, artifact `cutlyra-qa3-apk`). It is **newer than the build installed
on the phone** (127,971,836 bytes from run 43841922109 on `40ce2bf`), and it contains
PR #89. It was **not** installed: updating a device package needs fresh owner approval,
and the physical matrix in §7 therefore describes the `40ce2bf` build, not this one.

## 9. Performance measurements

Measured on the physical device, non-destructively (`dumpsys gfxinfo` around eight
timeline pans; raw output `_gfxinfo-pan.txt`):

| Metric | Value |
|---|---|
| Frames rendered | 53 |
| Janky frames | 0 (0.00%) |
| p50 / p90 / p95 / p99 frame time | 13 / 13 / 13 / 13 ms |
| Missed vsync | 0 |
| Slow UI thread | 0 |
| Slow issue draw commands | 0 |

Limits on that number, stated rather than glossed: the preview loop skips rendering when
neither the frame index nor the render tree changed, so this is rendered work rather than
a sustained-fps figure, and it covers **panning only**. Trim-drag responsiveness, seek
latency and thumbnail-generation overhead were not measured, so the "lag" complaint is
neither confirmed nor refuted for those paths. No optimisation was attempted, because
there was no measurement showing a bottleneck to fix.

## 10. Exported media (from the same device session)

`Movies/Cutlyra/Cutlyra-67b581cf-….mp4`, 5,891,471 bytes, SHA-256
`ee799fd92a5947d489800181a49fec18431fd1af9346ee85220c942074c4b453`:

- H.264, 1280×720 stored, `rotation=-90` (presents as 720×1280 portrait), 30 fps,
  330 frames, 11.000 s
- AAC 44.1 kHz mono, 11.016 s, mean −16.1 dB / max −3.0 dB (audio genuinely present)
- Frame at 7 s and frame at 1 s both match the preview's letterboxing

**Known risk, unresolved:** portrait output is landscape pixels plus a rotation matrix.
Media3 reads it correctly. A player or uploader that ignores the matrix would show the
video sideways. There is no reproducible failure yet, so no fix was invented; the risk is
recorded for the store audience.

## 11. Known unresolved items

| Item | Class | Note |
|---|---|---|
| Trim-handle resize | NEEDS HUMAN | Handles render; synthetic single-pointer input does not engage them. Procedure is in RESULTS.md §2. |
| Two-finger pinch on the timeline | NEEDS HUMAN | `adb shell input` cannot inject two pointers. |
| Replace Clip through the physical UI | NEEDS HUMAN | WebView exposes no clip to accessibility; tap selection did not register. Logic is covered by 31 command/race/durability tests. |
| Device rotation / inset layout | NEEDS HUMAN | Changing rotation is a phone-setting change, not authorized. |
| "Black dot" report | NEEDS EVIDENCE | No sticker or selection-handle art is bundled — the renderer draws overlays — so it cannot be blamed on a transparent sticker asset. The only images in the mobile payload are font-atlas chunks (`apps/mobile/public/fonts/font-chunk-*.png`), which makes a missing-glyph fallback one hypothesis worth testing if it recurs. No reproduction exists, so no cause is asserted and nothing was changed. |
| Filmstrip for exotic asset types | PARTIAL | PASS on the two video assets used; unavailable/failed thumbnail sources not exercised on device. |
| Music browsing | NOT IMPLEMENTED | The library is a flat list of generated local sounds (`sounds/local-sounds.ts`, each with a `category`) plus local import; there is no search/filter/genre UI, and the panel states "no network, no CapCut library clone". Grouping by the existing `category` field is the obvious small next step; it was **not** done, because it changes shipping UI days before an Alpha and could not be device-verified without an authorized update. |
| Support email in Play listing | OWNER | Still `HUMAN INPUT` in `docs/PLAY_STORE_LISTING.md`. |
| Two projects named `Project 1` after restore | COSMETIC | Observed; a `(restored)` suffix would help. Not changed. |
| Play-icon placeholder on project cards | COSMETIC | Observed; real thumbnail appears after first open. |
| Portrait export = landscape pixels + rotation | RISK | See §10. |

## 12. Release artifact status

| | |
|---|---|
| AAB | `play-artifacts-dl/cutlyra-play-8ca9683648e5b80cd985afc9bfaa86ba89d90fe9.aab` |
| Size | 91,331,262 bytes |
| SHA-256 | `2a368798d54ab55235ece04fa8c5916209be2d0498b6a009d253c7c47fac5c72` — recomputed this session, matches `SHA256SUMS.txt` |
| Upload signer | `CN=Cutlyra Play Upload, O=Cutlyra`, SHA-256 `90:01:71:5E:20:CF:33:03:F1:4A:4A:50:F2:B3:AB:11:55:0B:65:43:F2:BE:E3:15:87:13:B8:8B:F5:E6:BC:DA` — re-verified this session with `keytool -printcert -jarfile` |
| Source commit | `8ca9683648e5b80cd985afc9bfaa86ba89d90fe9` |

**Superseded for one change.** The bundle predates PR #89 (the gesture-banking fix),
which is app code. Everything else already shipped in it. `docs/PLAY_ALPHA_0.1.1_RELEASE_PREP.md`
§7 states the two honest options: rebuild from qualified main and re-verify hash + signer
(preferred), or upload this exact file and never credit it with #89.

## 13. Google Play readiness

- No upload, no rollout, no track change, no tester change, no production-access
  application in this session.
- Production access was rejected 2026-11-16; **14 additional closed-testing days** are
  required from the review date, so the earliest reapplication is ≈ **2026-11-30**.
  Nothing in this session resets or shortens that clock, and closing the track or
  dropping testers would.
- Existing testers and the existing Closed testing – Alpha track must stay as they are.

## 14. Remaining owner-only actions

1. Install the QA3 APK from run 44364210809 (`53ca33a`, artifact `cutlyra-qa3-apk`) if
   the finger checks should cover PR #89 — the build on the phone is `40ce2bf` and does
   not contain that fix. Installing it is an approval you have not given, so the existing
   build was left untouched.
2. Perform the four finger-dependent checks in RESULTS.md (trim resize, pinch, Replace
   Clip via UI, rotation), or explicitly accept them as unverified for this Alpha.
3. Decide rebuild-vs-upload for the AAB (§12) and authorize one of them.
4. Provide the support email for the Play listing.
5. Do not reapply for production access before ≈ 2026-11-30.
