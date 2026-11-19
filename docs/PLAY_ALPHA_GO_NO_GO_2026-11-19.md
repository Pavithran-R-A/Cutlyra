# Closed testing — Alpha: GO / NO-GO for v0.1.1 (versionCode 2)

**Written 2026-11-19 after the physical session on `aa11372`.** Nothing here authorises an
upload. No Play Console or Play API action was taken, and none is proposed below without the
owner's explicit approval.

Two artifacts are in scope and they are not interchangeable:

| | Play bundle | QA3 test build |
|---|---|---|
| File | `cutlyra-play-aa11372b371d7df5346c78e119e68270f3a008ca.aab` | `app-qa3.apk` |
| Bytes | 91,331,377 | 127,971,968 |
| SHA-256 | `c42c2e056dc282fb959afd797afaf903d56442d2e24c72e31a93cbd26dfd51a2` | `be1622ceac078f4b6c4ee50d9f584a48ea758612c6b8793fa627b9512f31e52f` |
| Signer | `CN=Cutlyra Play Upload, O=Cutlyra` / `90:01:71:5E:…:BC:DA` | `CN=Cutlyra QA3, O=Cutlyra, C=IN` / `13457361…f7cf` |
| Source | `aa11372b371d7df5346c78e119e68270f3a008ca` | same commit |
| Physical evidence | none — an AAB cannot be installed | `qa3-evidence-poco-20261119/` |

The phone tested the QA3 package, not the Play bundle. The two are built from the same commit
and contain the same application code, so device results transfer to the bundle as
*code-level* evidence; they are not a test of the signed AAB itself.

## Gate 1 — build integrity: GO

- Play bundle rebuilt from qualified `main` `aa11372`, so PR #89 is inside it (`6b88305` is an
  ancestor of `aa11372`; `git log 40ce2bf..aa11372 -- packages apps` shows only #89 and the
  #91 tests). Its web payload differs from the superseded `8ca9683` bundle, which must never
  be uploaded.
- Signer matches the registered upload certificate exactly; the upload key was not rotated and
  Play App Signing is unchanged. 16 KB ELF alignment, the `ggml-tiny.en.bin` model hash and the
  legal notices were all re-checked on the artifact.
- The QA3 build was verified the same way and then **verified again on the device**: the
  installed `base.apk` pulled back hashes to `be1622ce…e52f`, byte-identical to the artifact,
  under the pinned QA3 certificate.

## Gate 2 — physical acceptance on real hardware: PARTIAL, no FAIL

Nine cases were run on the POCO M4 Pro 5G from `qa3-evidence-poco-20261119/RESULTS.md`:
**6 PASS, 1 PARTIAL, 0 FAIL, 2 BLOCKED.**

| Case | Result |
|---|---|
| In-place update, existing projects preserved and accessible | PASS |
| Trim-handle resize with stable release geometry | PARTIAL — handle does not accept synthetic single-pointer drags |
| Two-finger pinch / drag / finger-lift (PR #89) | BLOCKED — needs two real fingers |
| Replace Clip → Undo → Redo | PASS |
| Clip rotation ±90 and flips | PASS |
| Fit geometry and preview/export parity | PASS |
| Fill (crop) distinct from Fit | BLOCKED — no Fill control found in the shipped panels |
| 720p export with audio | PASS (330 frames, 11.016 s, AAC −16.1 dB mean) |
| Save and reopen after edits | PASS |

What that means concretely:

- **The update itself is proven.** The build installed over the existing QA3 without touching
  its data, the installed bytes were confirmed, and both pre-existing projects opened intact
  with their clips, audio lane and duration.
- **Nothing failed.** No crash attributable to Cutlyra, no lost project, no export that would
  not play, no signature or version problem.
- **Three claims are still not device-verified**: the trim-handle drag, the two-finger gesture
  that PR #89 fixed, and Fill-vs-Fit. Synthetic input cannot reach the first two, and this
  build exposes no Fill control in the panels inspected. They stay PARTIAL/BLOCKED, not PASS.
- The release notes are written so that none of these three is claimed as device-verified
  (`docs/PLAY_ALPHA_0.1.1_RELEASE_PREP.md` §3 and §4a).

The three open items are a five-minute job with a human finger on this same phone, and the
exact steps are in `docs/qa/qa3-manual-acceptance-4-steps.md` and repeated in the RESULTS file.
They are worth doing before the Alpha upload only if the owner wants those specific claims in
the testers' checklist to be backed by hardware; they are not a reason to withhold a build that
has no failures.

## Gate 3 — Play Console state: NO-GO, three unverified preconditions

This environment has **no Play Console access and no Play Developer API credentials**. Every
statement below is therefore a blocker to be checked by the owner in the Console, not a
conclusion:

1. **Is versionCode 2 still unused?** Not confirmable from here. The documentary evidence is
   that the highest accepted versionCode is 1 and that no upload was ever authorised, so vc2
   is *expected* to be free. If the Console turns out to have vc2 already, do not force the
   upload: bump to versionCode 3, update the gate in `.github/workflows/play-bundle.yml` and
   `docs/PLAY_STORE_LISTING.md`, rebuild via `play-bundle.yml` and re-verify the signer.
2. **Support email.** Still `HUMAN INPUT` in `docs/PLAY_STORE_LISTING.md`. It is a Console
   listing field; no address was invented here, and it cannot be read or set from this
   environment.
3. **Upload authorisation.** Never granted. "Build only" was authorised; uploading was not.

## Gate 4 — track integrity: GO (untouched)

- Closed testing – Alpha, its tester list and their opt-in history were not modified in any
  way. No track was created, paused or promoted, and no internal-testing replacement exists.
- Google rejected production access on 2026-11-16 and requires 14 additional days of closed
  testing from the review date; earliest reapplication is around **2026-11-30**. An Alpha
  upload does not reset that window, but pausing the track or dropping below the tester floor
  would.

## Verdict

| Question | Verdict |
|---|---|
| Is the signed Play bundle the right artifact, built from the right source, with the right key? | **GO** |
| Did the build survive an in-place update on real hardware without losing user projects? | **GO** (proven) |
| Are all advertised fixes device-verified? | **PARTIAL — no**: trim handle, two-finger #89 and Fill remain open; no failures recorded |
| Upload to Closed testing – Alpha now? | **NO-GO until** the owner sets the support email, confirms vc2 is unused and explicitly authorises the upload |
| Promote to production / reapply for production access? | **NO-GO** — access was rejected on 2026-11-16; earliest reapplication ≈ 2026-11-30 |

So: the Alpha upload is a **GO on technical grounds and a NO-GO on authorisation**, with three
fingertip checks still outstanding that do not block the upload but must not be described as
device-verified until they are run.

## If the upload is authorised, the exact scope

- Upload `c42c2e05…51a2` (91,331,377 bytes) to the existing **Closed testing – Alpha** track
  only. Keep the release in the closed track.
- Do not touch the tester list, do not create a track, do not start a production rollout, do
  not reapply for production access from this step.
- Release notes: use §3 of `docs/PLAY_ALPHA_0.1.1_RELEASE_PREP.md` verbatim (479 characters,
  measured).
- Reject, do not ignore, any warning about versionCode or the upload key: both are already
  correct.
