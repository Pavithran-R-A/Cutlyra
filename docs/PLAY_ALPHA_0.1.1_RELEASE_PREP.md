# Closed testing — Alpha: v0.1.1 (versionCode 2) release preparation

**Status: PREPARED, NOT UPLOADED.** Nothing in this document has been executed in Play
Console. No AAB was uploaded, no track was created or modified, no rollout was started,
and no tester was added or removed.

Prepared 2026-11-18 against `main` at `c4d1a4f136a3ed2b57f3f89d0b7114ac4fdbfea4`.

Read §7 before uploading: the built AAB predates one app-code change now on `main`
(PR #89), and §7 states exactly what that does and does not mean.

---

## 1. Release identity

| Field | Value |
|---|---|
| App | Cutlyra — `app.cutlyra.editor` (existing app, do not recreate) |
| Track | **Closed testing – Alpha** (existing track, preserve as-is) |
| versionName | `0.1.1` |
| versionCode | `2` (Play's highest accepted versionCode is 1; vc2 is strictly greater) |
| minSdk / targetSdk | 29 / 36 |
| Artifact | `play-artifacts-dl/cutlyra-play-8ca9683648e5b80cd985afc9bfaa86ba89d90fe9.aab` |
| Size | 91,331,262 bytes |
| SHA-256 | `2a368798d54ab55235ece04fa8c5916209be2d0498b6a009d253c7c47fac5c72` (recomputed 2026-11-18, matches `SHA256SUMS.txt`) |
| Source commit | `8ca9683648e5b80cd985afc9bfaa86ba89d90fe9` |
| Build run | `play-bundle.yml` 43696665795, 4/4 jobs green (build only) |
| Signer | `CN=Cutlyra Play Upload, O=Cutlyra` — SHA-256 `90:01:71:5E:20:CF:33:03:F1:4A:4A:50:F2:B3:AB:11:55:0B:65:43:F2:BE:E3:15:87:13:B8:8B:F5:E6:BC:DA` |

The signer matches the Play Console registered upload certificate exactly. The upload
key was not rotated, regenerated, or re-enrolled. Play App Signing stays in effect.

**Do not rebuild this bundle for the Alpha upload.** It is the verified artifact; a new
build would need its own signer re-verification.

## 2. What changed since the versionCode-1 build

- Timeline lane ordering corrected (PR #81).
- Touch drag/resize gesture stability improved (PR #82).
- Restore no longer overwrites an existing project — it creates a new project with a fresh ID.
- Rotation / Fit / Fill export parity improvements.
- QA3 signing-environment and production-readiness hardening (no user-facing behaviour).

Everything above is inside the AAB, because all of it merged before its source
commit `8ca9683`. What merged afterwards is listed in §7.

No permission changes, no new SDKs, no account, no ads, no analytics, no network
collection. `allowBackup=false` is unchanged, so the update cannot disturb existing
on-device projects.

## 3. Play Console release notes (paste-ready, 449 characters)

```
Cutlyra 0.1.1 (versionCode 2)

• Timeline lanes now stay in the correct order
• Drag and resize on the timeline are steadier
• Restore no longer overwrites an existing project — a backup opens as a new project
• Preview and export now match for portrait and landscape clips
• Real filmstrip thumbnails on the video track
• MP4 export keeps its audio
• Project save and reopen are more reliable

Still offline: no account, no ads, no watermark.
```

Re-measured this session with `wc -m` after stripping the line breaks: **449
characters**, including the seven `•` bullets. Play limits release notes to 500
characters per language, so it fits with margin. If the Console strips the bullet
character, the same text works with `-`.

## 4. Tester validation checklist

Give this to the closed-test group with the 0.1.1 update. Every item is observable
without developer tooling.

**Before updating**
- [ ] Note the version shown by the app / Play ("0.1.0" → should become "0.1.1").
- [ ] Open one existing project and note its clip count and total duration.

**After updating**
- [ ] The app opens without a crash or "app not installed" error.
- [ ] The project opened before the update still opens, with the same clips and duration,
      and its media still plays.
- [ ] Create a project with two clips of different orientation (one portrait, one landscape):
      lanes sit video on top, overlays in the middle, audio at the bottom, and nothing is
      duplicated on its own.
- [ ] Drag a clip's edge to trim it; the edge follows the finger without jumping, and no gap
      is left behind.
- [ ] Two-finger pinch the timeline to zoom; it zooms smoothly and does not jump.
- [ ] Scrub across the portrait→landscape boundary; the preview reframes without stretching.
- [ ] Use Replace Clip on a clip, then undo, then redo; the correct clip comes back each time.
- [ ] Filmstrip shows real frames (not grey tiles) for every video clip.
- [ ] Export at 720p; the MP4 plays with sound and the picture is the right way up.
- [ ] Close the project, reopen it: everything is still there.
- [ ] Back up a project, then restore the archive: you get a **new** project and the original
      is untouched.

Report per tester: device model, Android version, which steps passed, and a screenshot of
any failure.

## 5. Guardrails for the upload step (when authorized)

- Upload **only** to the existing **Closed testing – Alpha** track. Do not create a new
  track, a new app, or an internal-testing replacement.
- Do **not** touch the tester list. The same testers must stay continuously opted in.
- Do **not** start a production rollout, do not promote to production, do not apply for
  production access again from this step.
- Keep the existing 14-day window intact. Google rejected the production-access
  application on 2026-11-16 and requires **14 additional days of closed testing from the
  review date**; earliest reapplication is around **2026-11-30**. An Alpha upload does not
  reset that clock, but pausing the track or dropping below the tester floor would.
- Reject, do not ignore, any Play warning about the versionCode or the upload key: vc2 and
  the registered upload key are both already correct.
- Confirm the Console's "Release notes" field shows the text from §3 before submitting for
  review, and keep the release in the closed track only.

## 6. Tester feedback template

One copy per tester. Keep it short enough that people actually fill it in; the goal is
triage, not a survey.

```
Cutlyra closed test — v0.1.1 (versionCode 2) feedback

Device model + Android version:
Version shown in Play before updating:      0.1.0 / other:
Did the update install and open cleanly?    yes / no  (if no: what happened?)

What did you try?  (tick anything you did)
  [ ] trimmed a clip      [ ] dragged a clip on the timeline   [ ] pinch-zoomed
  [ ] rotated/flipped a clip   [ ] used Replace Clip     [ ] exported a video
  [ ] saved and reopened       [ ] backed up and restored

What worked:

What went wrong  (one line per problem, plus device model if it is not above):
  1.
  2.

For each problem: was it a crash, a wrong result, a freezes/stutter, or cosmetic?

Optional: a screen recording or screenshot of the problem.

Anything you expected to find and did not:
```

Triage rules for whoever collects these:
- A crash, an export that will not play, or lost project work is a **P0/P1** — capture the
  project name, device, and the exact steps before the next build replaces it.
- "It moved by itself" reports need the element and the gesture that preceded it; the
  banking rule behind that class of report is tested in
  `packages/mobile-ui/src/components/editor/preview-gesture.test.ts`.
- Do not ask testers to clear app data, uninstall, or reset their phone to reproduce.
- Never reword a report into a pass. Unreproduced stays unreproduced.

## 7. Supersession status of the built AAB

| | |
|---|---|
| AAB source commit | `8ca9683648e5b80cd985afc9bfaa86ba89d90fe9` |
| Merged after it, app code | **PR #89** — preview gesture banking (`fix(preview): stop banking drag movement that was never shown`) |
| Merged after it, no app code | PR #87 (docs), PR #88 + #90 (CI only) |

**The AAB does not contain PR #89.** It is otherwise complete: #81 (lane order), #82
(pointer re-anchoring), #77 (restore collision), #78 (rotation geometry) and #86
(production candidate) all predate `8ca9683`.

Two honest options, in order of preference:

1. **Rebuild, then upload.** After #89 is green on main, dispatch `Play Store AAB` on
   that main commit, record the new SHA-256 and re-verify the signer with
   `keytool -printcert -jarfile` against the registered upload certificate, then upload
   the new bundle. The release notes in §3 still apply (add nothing about #89 unless a
   tester-visible behaviour actually changed on device).
2. **Upload the verified AAB as-is.** Permitted, but then the upload must be described as
   "the `8ca9683` build" and no document may credit it with the #89 fix. Do not silently
   attribute later merges to an older binary.

Either way: do not reuse the `8ca9683` file after a rebuild, and never mix the two under
one hash.

## 8. Preconditions still open

- [ ] Owner authorization to upload (explicitly withheld so far).
- [ ] Support email in Play Console — currently `HUMAN INPUT` in
      `docs/PLAY_STORE_LISTING.md`; the listing contact must be a real verified address.
- [ ] Physical acceptance: **5 of 8 matrix rows PASS, 3 PARTIAL, 0 FAIL** — computed from
      the case rows in `qa3-evidence-poco-20261118/QA_SUMMARY.json`, hashed file list in
      `qa3-evidence-poco-20261118/EVIDENCE_INDEX.md`. Trim-handle resize, pinch zoom,
      Replace Clip through the physical UI and device rotation still need a human-finger
      pass; emulator and synthetic input cannot stand in for them.
- [ ] Play-delivered smoke test — only possible after the upload is approved and Google
      delivers the build.
