import json, copy
from pathlib import Path
from collections import Counter

p = Path('docs/qa/beta-case-inventory.json')
d = json.loads(p.read_text(encoding='utf-8'))

# Preserve historical baseline metadata
d['historical_baseline'] = {
    'generated': d.get('generated'),
    'build': copy.deepcopy(d.get('build')),
    'summary_as_recorded_2026_11_03': copy.deepcopy(d.get('summary')),
    'note': 'Preserved as historical 2026-11-03 main@1027a28 baseline evidence. Current assessments below are build-specific and must cite proof for current status changes; historical FAIL rows are not silently rewritten as if they never happened.',
}

# Refresh rebaseline_pr66 with actual passing CI on final tested PR SHA
d['rebaseline_pr66'] = {
    'date': '2026-11-09',
    'branch': 'feat/22-canvas-fit-fill',
    'final_tested_pr_head_sha': '66f1eb5cd7594f10b86a42a8dfa64e5c732c23bd',
    'merged_main_commit': '8a76c8aeb31241bf0e650721c2039bc14877d216',
    'pr': 'https://github.com/Pavithran-R-A/Cutlyra/pull/66',
    'ci_runs_pr_head_green': [
        {'workflow': 'Bun CI', 'run_id': 42669154309, 'url': 'https://github.com/Pavithran-R-A/Cutlyra/actions/runs/42669154309', 'conclusion': 'success', 'jobs': ['invariants (ubuntu-latest)', 'invariants (macos-latest)', 'invariants (windows-latest)']},
        {'workflow': 'Mobile CI', 'run_id': 42669153296, 'url': 'https://github.com/Pavithran-R-A/Cutlyra/actions/runs/42669153296', 'conclusion': 'success', 'jobs': ['Android (debug APK)', 'iOS (simulator, unsigned)', 'Android instrumentation (API 35 emulator)', 'Android instrumentation (R8 test variant)'], 'instrumentation': {'normal': '46 tests, 0 failures (emulator-5554)', 'r8_variant': '46 tests, 0 failures (emulator-5554)'}},
    ],
    'merged_main_ci_status': 'NOT VERIFIED GREEN at time of this rebaseline: Bun CI run 42672196713 and Mobile CI run 42672197042 on 8a76c8ae had scheduling/execution anomalies (zero/partial jobs across attempts; reruns attempted). No workflow files changed by merge. Treat as external/scheduling blocker unless disproven; do not infer code regression from these attempts alone.',
    'note': 'PR-head evidence is validated. Merged-main qualification requires successful full-workflow reruns on 8a76c8ae (all 7 expected jobs).',
}

valid_statuses = {'PASS', 'FAIL', 'VERIFY', 'BLOCKED'}

by_id = {c['id']: c for c in d['cases']}

# --- Reassess historical FAIL cases (preserve 2026-11-03 baseline evidence) ---
# timeline-01: filmstrip
c = by_id['timeline-01']
c['baseline_2026_11_03'] = {'status': 'FAIL', 'evidence': c['evidence']}
c['status'] = 'VERIFY'
c['evidence'] = 'Current assessment (build-specific, merged main 8a76c8ae includes #60/#64): real filmstrip frames/contact-sheet instrumentation was merged per PR chain; however this row is not marked PASS here without direct CI run/log evidence for the rendering/frame-distinctness criterion on the assessed build. Requires appropriate rendering evidence (instrumentation log/artifact or equivalent) before PASS.'
c['blocker'] = 'needs direct rendering/contact-sheet evidence tied to assessed build; merged-main CI not yet verified green'

# export-08: bundled library audio
c = by_id['export-08']
c['baseline_2026_11_03'] = {'status': 'FAIL', 'evidence': c['evidence']}
c['status'] = 'VERIFY'
c['evidence'] = 'Current assessment (merged main 8a76c8ae includes #64 fix): ExportLibraryAudioInstrumentedTest exists and covers decoded audible output for bundled library sounds (standalone/muted cases). Mobile CI run 42669153296 on PR head 66f1eb5 passed 46/46 normal and 46/46 R8 instrumentation tests including export/library-audio coverage in that suite context; promote to PASS only when suite composition/log explicitly confirms ExportLibraryAudioInstrumentedTest executed on the exact assessed SHA and merged-main CI is verified.'
c['blocker'] = 'awaiting merged-main full CI verification and explicit test-log confirmation for ExportLibraryAudioInstrumentedTest on assessed SHA'

# export-17: lost media reference
c = by_id['export-17']
c['baseline_2026_11_03'] = {'status': 'FAIL', 'evidence': c['evidence']}
c['status'] = 'VERIFY'
c['evidence'] = 'Current assessment (merged main 8a76c8ae includes #61/#64): EdlToComposition now reports missing assetId/asset with the clip named and instructs replace/delete before export; insert-time rejection/export pre-flight landed per PR chain. Repair of existing already-damaged projects remains a separate gap and is not claimed fixed. Mark PASS only with targeted regression evidence on assessed build.'
c['blocker'] = 'needs targeted regression evidence (named-clip error/preflight) on assessed build; existing-damaged-project repair remains separate'

# privacy-04: R8 readiness
c = by_id['privacy-04']
c['baseline_2026_11_03'] = {'status': 'FAIL', 'evidence': c['evidence']}
c['status'] = 'VERIFY'
c['evidence'] = 'Current assessment (merged main 8a76c8ae includes #64): CI-only optimized `r8test` variant exists and passed Android instrumentation (R8 test variant) 46/46 in Mobile CI run 42669153296 on PR head 66f1eb5. Signed Play release remains not minified (release build still ships with minification disabled per build config/release process) — DEX optimisation/R8 readiness for the actual Play release is not fully satisfied.'
c['blocker'] = 'signed Play release minification/R8 enablement and release verification remain outstanding; no versionCode/AAB/upload changes made'

# export-22: automated export geometry satisfied; physical preview/export parity separate
c = by_id['export-22']
c['baseline_2026_11_03'] = None
c['case'] = 'Per-clip Fit/Fill export geometry for mismatched aspect: automated exported-frame edge/bar check (#22)'
c['status'] = 'PASS'
c['evidence'] = 'Mobile CI run 42669153296 (success) on PR head 66f1eb5cd7594f10b86a42a8dfa64e5c732c23bd, merged as 8a76c8ae: Android instrumentation (API 35 emulator) and Android instrumentation (R8 test variant) both ran 46 tests with 0 failures (emulator-5554). Suite includes ExportFramingInstrumentedTest.fitLetterboxesMismatchedSource_and_fillCoversCanvas, which exports a 4:3 source to a 9:16 canvas via Media3Exporter/EDL and asserts fit produces substantial letterbox bars while fill covers without letterbox bars. Physical preview↔export parity is tracked separately (export-22b).'
c.pop('blocker', None)

# Add separate physical/device case
if not any(x['id'] == 'export-22b' for x in d['cases']):
    d['cases'].append({
        'id': 'export-22b',
        'area': 'Preview vs export',
        'case': 'Per-clip Fit/Fill physical preview↔export parity, edge-to-edge/system bars, save/reopen/undo acceptance on device (#22)',
        'status': 'BLOCKED',
        'evidence': 'No physical POCO M4 Pro 5G / Android 15-16 device verification executed in this environment. Automated export geometry is PASS (export-22). See docs/qa/physical-device-acceptance-poco-m4-pro-5g.md.',
        'blocker': 'owner device/Play Console access required',
    })

# Fix summary from rows
counts = Counter(c['status'] for c in d['cases'])
for s in counts:
    if s not in valid_statuses:
        raise SystemExit(f'invalid status {s}')
d['summary'] = {
    'total': len(d['cases']),
    'pass': counts.get('PASS', 0),
    'fail': counts.get('FAIL', 0),
    'verify': counts.get('VERIFY', 0),
    'blocked': counts.get('BLOCKED', 0),
    'note': 'Computed from cases. PASS means the named suite/gate executed on the assessed build with cited evidence. VERIFY means code path exists/relevant fix merged but direct criterion evidence on assessed build is incomplete. BLOCKED means required device/hardware/account/access unavailable. Historical 2026-11-03 FAIL evidence preserved in case baseline fields/historical_baseline.',
}

# Integrity checks
ids = [c['id'] for c in d['cases']]
if len(ids) != len(set(ids)):
    raise SystemExit('duplicate ids')
for c in d['cases']:
    if c.get('status') not in valid_statuses:
        raise SystemExit(f"bad status {c.get('id')}")
    for k in ('id','area','case','status','evidence'):
        if k not in c:
            raise SystemExit(f"missing {k} in {c.get('id')}")

p.write_text(json.dumps(d, indent='\t', ensure_ascii=False) + '\n', encoding='utf-8')
print('ok', d['summary'])
