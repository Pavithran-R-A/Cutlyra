# QA3 — owner setup gap, isolated build plan, and physical acceptance

**Base:** `main` @ `8ca9683648e5b80cd985afc9bfaa86ba89d90fe9`
**Production candidate:** `app.cutlyra.editor` 0.1.1 / versionCode 2 (verified AAB, not uploaded)
**QA3 package:** `app.cutlyra.editor.qa3` (independent signer, independent storage)
**Status:** signing NOT configured; no QA3 build or install performed.

---

## 1. Verified owner-controlled settings gap

Checked against the repository's GitHub configuration on 2026-11-15:

- Environments: **none exist** (`total_count: 0`), so `qa3-signing` is missing.
- Repository secrets: only `PLAY_UPLOAD_KEYSTORE_BASE64`,
  `PLAY_UPLOAD_KEYSTORE_PASSWORD`, `PLAY_UPLOAD_KEY_ALIAS`,
  `PLAY_UPLOAD_KEY_PASSWORD` exist.
- Repository variables: **none**.
- Therefore the QA3 job's signing gate would fail with missing
  `CUTLYRA_QA3_*` values (it fails closed; no debug fallback).

### Exactly what the owner must create (Settings → Environments → `qa3-signing`)

1. Create environment **`qa3-signing`**.
2. **Deployment branches:** restrict to `main` only.
3. **Required reviewers:** add a reviewer. If only one account exists, leave
   "Prevent self-review" off or arrange a second approver — never assume
   self-approval works.
4. Environment **secrets** (4):
   - `CUTLYRA_QA3_KEYSTORE_BASE64`
   - `CUTLYRA_QA3_KEYSTORE_PASSWORD`
   - `CUTLYRA_QA3_KEY_ALIAS`
   - `CUTLYRA_QA3_KEY_PASSWORD`
5. Environment **variable** (1, public metadata):
   - `CUTLYRA_QA3_CERT_SHA256`
6. Generate the QA3 keystore once, outside any agent session, per
   `docs/qa/qa3-distribution.md`; back it up offline and record the signer
   SHA-256 in that document.

No credential value may be pasted into chat, committed, or written to a log.

---

## 2. Isolated QA3 build plan (no install yet)

1. Confirm Mobile CI and Bun CI are green on the exact `main` SHA to sign.
2. Dispatch **QA3 signed APK** on `main` (workflow refuses any other ref and
   re-checks provenance). Environment protection pauses for approval.
3. Build **twice** (two dispatches from the same SHA) to prove signing
   stability.
4. For each artifact verify:
   - `sha256sum cutlyra-qa3.apk` equals `qa3-apk.sha256`.
   - `apksigner verify --print-certs` equals `CUTLYRA_QA3_CERT_SHA256`.
   - Package is `app.cutlyra.editor.qa3`; production/QA/QA2 IDs unchanged.
   - Both builds print the **same** signer certificate SHA-256.
5. Stop and request explicit installation approval. Do not install.

### Install safety (only after approval)

```bash
adb devices
adb shell pm list packages | grep cutlyra   # record 4 existing packages first
adb install -r cutlyra-qa3.apk              # updates QA3 only
adb shell pm list packages | grep cutlyra   # all four still present
```

Never uninstall or clear data for `app.cutlyra.editor`, `.qa`, or `.qa2`.
Never use `adb install` without `-r` for an existing package.

---

## 3. Physical acceptance matrix (QA3 only)

Record device model, Android version, build SHA, APK SHA-256, signer digest,
and timestamp for every row. Attach screenshots, project files, and exported
MP4s. CI results do not count as physical PASS.

| # | Test | Evidence to capture | Result |
|---|---|---|---|
| 1 | Timeline lane ordering | Screenshot of multi-lane timeline; expected order noted | PENDING |
| 2 | Touch drag/resize stability | Screen recording or before/after frames; no jump | PENDING |
| 3 | Restore without overwriting | Original project intact; restored copy has fresh ID | PENDING |
| 4 | Non-square rotation + Fit/Fill | Preview vs exported frame comparison | PENDING |
| 5 | Video + audio export | Exported MP4 plays with audio; file hash/size | PENDING |
| 6 | Replace Clip durability | Save, reopen, play; undo/redo behavior | PENDING |
| 7 | Real filmstrip thumbnails | Screenshot showing real frames, not placeholders | PENDING |
| 8 | Save/reopen + backup/restore | Reopen project; export/restore round-trip | PENDING |

A row is PASS only with physical evidence. Otherwise FAIL or BLOCKED.

---

## 4. Play-delivered smoke-test plan (`app.cutlyra.editor`)

To run only after the owner uploads the verified AAB to the existing closed
test and Google delivers it. No track changes or uploads by this plan.

1. Record the Play-delivered versionCode/versionName from the phone
   (`adb shell dumpsys package app.cutlyra.editor | grep version`).
2. Confirm 0.1.1 / versionCode 2 and that the install signature is the
   Play-managed app-signing certificate (not the upload key).
3. Preserve existing projects: open one pre-existing project before and after
   the update; confirm media and edits survive.
4. Smoke: launch, create project, import video+photo+audio, trim, caption,
   transform, export with audio, reopen.
5. Confirm the 12-tester closed test remains intact; do not remove testers or
   restart the track.
6. Record screenshots and device details; report PASS/FAIL.

Any Play Console action (upload, track change, rollout) needs separate
explicit owner approval.

---

## 5. Approval gates

- [ ] Owner creates `qa3-signing` environment and QA3 credentials.
- [ ] Owner authorizes QA3 dispatch (build only).
- [ ] Owner authorizes QA3 installation.
- [ ] Owner authorizes Play-delivered smoke test.
- [ ] Owner approves production rollout after Google review.
