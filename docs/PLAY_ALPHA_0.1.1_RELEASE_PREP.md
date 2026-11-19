# Closed testing — Alpha: v0.1.1 (versionCode 2) release preparation

**Status: PREPARED, NOT UPLOADED.** Nothing in this document has been executed in Play
Console. No AAB was uploaded, no track was created or modified, no rollout was started,
and no tester was added or removed.

Prepared 2026-11-18 against `main` at `c4d1a4f136a3ed2b57f3f89d0b7114ac4fdbfea4`.
Rebuilt 2026-11-19 against qualified `main` at `aa11372b371d7df5346c78e119e68270f3a008ca` so the
candidate contains PR #89. §7 records the supersession of the earlier `8ca9683` bundle.

---

## 1. Release identity

| Field | Value |
|---|---|
| App | Cutlyra — `app.cutlyra.editor` (existing app, do not recreate) |
| Track | **Closed testing – Alpha** (existing track, preserve as-is) |
| versionName | `0.1.1` |
| versionCode | `2` (Play's highest accepted versionCode is 1; vc2 is strictly greater) |
| minSdk / targetSdk | 29 / 36 |
| Artifact | `play-artifacts-dl/run-44530879487/cutlyra-play-aa11372b371d7df5346c78e119e68270f3a008ca.aab` |
| Size | 91,331,377 bytes |
| SHA-256 | `c42c2e056dc282fb959afd797afaf903d56442d2e24c72e31a93cbd26dfd51a2` (verified after download with `sha256sum -c SHA256SUMS.txt`) |
| Source commit | `aa11372b371d7df5346c78e119e68270f3a008ca` |
| Build run | `play-bundle.yml` [44530879487](https://github.com/Pavithran-R-A/Cutlyra/actions/runs/44530879487) — invariants gate (3/3) + Android Play bundle green; canonical-main assertion logged `Play source OK` |
| Superseded candidate | `cutlyra-play-8ca96836….aab` (91,331,262 bytes, SHA-256 `2a368798…5c72`) — predates PR #89, must not be uploaded |
| Signer | `CN=Cutlyra Play Upload, O=Cutlyra` — SHA-256 `90:01:71:5E:20:CF:33:03:F1:4A:4A:50:F2:B3:AB:11:55:0B:65:43:F2:BE:E3:15:87:13:B8:8B:F5:E6:BC:DA` |

The signer matches the Play Console registered upload certificate exactly. The upload
key was not rotated, regenerated, or re-enrolled. Play App Signing stays in effect.

**This is now the build to upload.** It was rebuilt from `aa11372` on 2026-11-19 and its
signature was independently re-verified locally (`keytool -printcert -jarfile`) against the
registered upload certificate: `CN=Cutlyra Play Upload, O=Cutlyra`,
SHA-256 `90:01:71:5E:20:CF:33:03:F1:4A:4A:50:F2:B3:AB:11:55:0B:65:43:F2:BE:E3:15:87:13:B8:8B:F5:E6:BC:DA`
— identical to the certificate recorded for the `8ca9683` bundle, so the upload key was not
rotated. The web payload differs from that earlier bundle (`editor-shell-BvUqJTpu.js` →
`editor-shell-jxxTaH7c.js`, `app-root-CqCuf8fL.js` → `app-root-QV17qwqh.js`), which is the
PR #89 change travelling inside the shipped assets.

## 2. What changed since the versionCode-1 build

- Timeline lane ordering corrected (PR #81).
- Touch drag/resize gesture stability improved (PR #82).
- Restore no longer overwrites an existing project — it creates a new project with a fresh ID.
- Rotation / Fit / Fill export parity improvements.
- QA3 signing-environment and production-readiness hardening (no user-facing behaviour).
- Preview drag no longer banks movement that was never displayed, so the first move after a
  second finger joins does not jump (PR #89).

Everything above is inside the current AAB: everything but #89 merged before `8ca9683`, and
#89 is a commit on `aa11372`, the commit this bundle was built from (§7).

No permission changes, no new SDKs, no account, no ads, no analytics, no network
collection. `allowBackup=false` is unchanged, so the update cannot disturb existing
on-device projects.

## 3. Play Console release notes (paste-ready, 449 characters)

```
Cutlyra 0.1.1 (versionCode 2)

• Timeline lanes stay in the correct order
• Dragging on the preview no longer jumps when a second finger touches
• Timeline drag and resize are steadier
• Restore no longer overwrites a project — a backup opens as a new project
• Preview and export match for portrait and landscape clips
• Real filmstrip thumbnails on the video track
• MP4 export keeps its audio
• Save and reopen are more reliable

Still offline: no account, no ads, no watermark.
```

Re-measured on 2026-11-19 with Python `len()` on the flattened text: **479 characters**,
including the eight `•` bullets and the em dash. Play limits release notes to 500 characters
per language. The first draft that added the #89 bullet came to 512 and was trimmed rather
than shipped over the limit — the wording above is the measured one. If the Console strips the
bullet character, the same text works with `-`.

What these notes do and do not claim: the drag bullet is #89, which is verified by unit and
instrumented tests but **not** by a physical two-finger pass — §4a marks that distinction, and
the tester checklist asks the group to exercise it. No bullet here is credited to a device
result that does not exist.

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

## 4a. What is proven, by what method

Use this table when writing anything public about 0.1.1. "Automated" means unit or
instrumented tests — it is not a device result.

| Claim in the release | In this AAB | Evidence | Physical device |
|---|---|---|---|
| Timeline lane ordering correct (#81) | yes | unit tests + QA3 row 1 | **PASS** (2026-11-18) |
| Duplicate makes exactly one copy (#91 tests) | yes | 9 command-level tests + QA3 row 1 | **PASS** |
| Preview drag no longer jumps on second-finger join (#89) | **yes** | `preview-gesture.test.ts` (bank/slop cases) + 61 Android instrumentation tests on API-35 and R8, all green on `aa11372` | **not device-verified** — the two-finger lift step is still open (§8) |
| Touch drag/resize steadier (#82) | yes | unit + instrumentation tests | **PARTIAL** — drag works; trim handle and pinch not automatable |
| Restore creates a new project (#77) | yes | unit tests + QA3 row 8 | **PASS** |
| Rotation / Fit / Fill export parity (#78) | yes | unit + actual-media export tests | **PARTIAL** — fit and geometry pass; full Fit/Fill visual confirmation open |
| Real filmstrip thumbnails | yes | QA3 row 5 | **PASS** |
| MP4 export keeps audio | yes | QA3 row 6 + ffprobe of the exported file | **PASS** |
| Save and reopen reliable | yes | QA3 row 7 + OS-kill survival observation | **PASS** |
| Instagram-style music browsing | **no — not implemented** | none | not attempted |

Emulator and synthetic-input results never upgrade a device row. The three PARTIAL rows in
`qa3-evidence-poco-20261118/RESULTS.md` stay PARTIAL until a human runs
`docs/qa/qa3-manual-acceptance-4-steps.md`.

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

## 7. Supersession status — resolved 2026-11-19

| | |
|---|---|
| Current candidate source commit | `aa11372b371d7df5346c78e119e68270f3a008ca` (qualified `main`) |
| App-code commits between the old and new candidate | PR #89 `6f84c6e` (preview gesture banking) and PR #91 (tests only, 9 cases) |
| Earlier candidate | `8ca9683…` — **do not upload** |

`git log 40ce2bf..aa11372 -- packages apps` returns exactly those three commits; nothing else
in application code changed. So the new bundle's difference from the previously installed QA3
build, and from the earlier Play candidate, is PR #89 plus test-only work.

The earlier plan offered a rebuild or an as-is upload. **The rebuild was taken.** The `8ca9683`
bundle is superseded: it must not be uploaded, and no document may credit it with #89. Upload
the `aa11372` bundle recorded in §1, with the SHA-256 in §1, and never mix the two hashes.

## 7a. QA3 candidate built from the same source

| | |
|---|---|
| Artifact | `cutlyra-qa3-apk` from run [44530886713](https://github.com/Pavithran-R-A/Cutlyra/actions/runs/44530886713) (`app-qa3.apk`, 127,971,968 bytes) |
| SHA-256 | `be1622ceac078f4b6c4ee50d9f584a48ea758612c6b8793fa627b9512f31e52f` |
| Package / version | `app.cutlyra.editor.qa3`, versionName `0.1.1`, versionCode `2` (aapt2), minSdk 29 / targetSdk 36 |
| Signer | `CN=Cutlyra QA3, O=Cutlyra, C=IN`, SHA-256 `13457361f9f405147c8ada63de9c4ee876816383f403ffab9afd29324ce2f7cf` — matches the pinned QA3 fingerprint and `vars.CUTLYRA_QA3_CERT_SHA256` |
| Source | `aa11372`; workflow asserted `QA3_SOURCE_SHA=aa11372…`, both prerequisites (Bun CI, Mobile CI) `completed/success` on that SHA |
| Emulator smoke | API-35: `installed / package present / independent storage (uid=10209) / launched / process alive / no fatal crash / resumed / QA3 emulator smoke passed` |
| Difference vs installed QA3 (`40ce2bf`) | PR #89 gesture fix only (plus tests); installed build's own fixes remain |

**Installed 2026-11-19 as an in-place update** of the existing `app.cutlyra.editor.qa3` on the
POCO M4 Pro 5G (`CIUWEMJBPBDUWC7D`), with the owner's device authorization. The installed
`base.apk` was pulled back and hashed to `be1622ce…e52f`, byte-identical to the artifact, under
the pinned QA3 certificate; `firstInstallTime` was preserved and `lastUpdateTime` moved, which
is the platform's own proof that this was an update over existing data. The verification log is
`qa3-evidence-poco-20261119/PREFLIGHT-INSTALL.txt`, the results matrix is
`qa3-evidence-poco-20261119/RESULTS.md`, and the release verdict is
`docs/PLAY_ALPHA_GO_NO_GO_2026-11-19.md`.

## 8. Preconditions still open

- [ ] Owner authorization to upload (explicitly withheld so far).
- [ ] Support email in Play Console — currently `HUMAN INPUT` in
      `docs/PLAY_STORE_LISTING.md`; the listing contact must be a real verified address. This
      is a Play Console listing field, not a manifest value, and no address is invented here.
- [ ] versionCode 2 still unused — not confirmable without Play Console or API access. The
      documentary evidence (highest accepted vc is 1, no upload ever authorized) says it is
      free; treat that as expected, not proven.
- [ ] Physical acceptance on the installed alpha candidate: **6 of 9 rows PASS, 1 PARTIAL,
      0 FAIL, 2 BLOCKED** — computed from the case rows in
      `qa3-evidence-poco-20261119/QA_SUMMARY.json`, hashed file list in
      `qa3-evidence-poco-20261119/EVIDENCE_INDEX.md`. Trim-handle resize (PARTIAL), the
      two-finger pinch/finger-lift behind PR #89 (BLOCKED) and Fill-vs-Fit (BLOCKED) still
      need a human pass; synthetic single-pointer input cannot stand in for them, and this
      build exposes no Fill control in the panels inspected.
- [ ] Play-delivered smoke test — only possible after the upload is approved and Google
      delivers the build.

## 9. Verdict

See `docs/PLAY_ALPHA_GO_NO_GO_2026-11-19.md`: **GO on technical grounds, NO-GO on
authorization** for the Alpha upload; production stays NO-GO until the 14-day closed-testing
window from the 2026-11-16 rejection has elapsed (earliest reapplication ≈ 2026-11-30).
