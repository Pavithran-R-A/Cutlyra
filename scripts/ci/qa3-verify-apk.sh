#!/usr/bin/env bash
# QA3 APK identity/signature/payload verification.
#
# Shared by PR CI (which has no QA3 keystore, so the APK must be UNSIGNED) and
# by the trusted signing workflow (which requires the QA3 certificate to match
# the pinned digest). One implementation, two expectations — the identity and
# payload checks cannot drift between the two gates.
#
# Usage (from apps/mobile/android):
#   scripts/ci/qa3-verify-apk.sh --expect unsigned
#   scripts/ci/qa3-verify-apk.sh --expect signed
#
# Never prints key material: only public digests of the built artifact.
set -euo pipefail

fail() {
	echo "::error::$*" >&2
	exit 1
}

mode=""
while [ $# -gt 0 ]; do
	case "$1" in
		--expect)
			mode="${2:-}"
			shift 2
			;;
		*)
			fail "unknown argument: $1 (usage: --expect signed|unsigned)"
			;;
	esac
done
[ "$mode" = "signed" ] || [ "$mode" = "unsigned" ] || fail "usage: $0 --expect signed|unsigned"

APK_DIR="app/build/outputs/apk/qa3"
APK="${QA3_APK:-}"
if [ -z "$APK" ]; then
	APK=$(find "$APK_DIR" -maxdepth 1 -name '*.apk' | sort | head -1)
fi
[ -n "$APK" ] && [ -s "$APK" ] || fail "no QA3 APK found in $APK_DIR"

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
[ -n "$SDK_ROOT" ] || fail "ANDROID_SDK_ROOT/ANDROID_HOME is not set"

# Newest build-tools that actually has BOTH binaries (Windows ships
# `apksigner.bat`; some installed build-tools revisions omit tools entirely, so
# a plain "highest version" pick can point at an unusable directory).
AAPT=""
APKSIGNER=""
while IFS= read -r dir; do
	[ -n "$dir" ] || continue
	aapt_candidate=""
	for aapt in "$dir/aapt2" "$dir/aapt2.exe"; do
		[ -f "$aapt" ] && aapt_candidate="$aapt"
	done
	signer_candidate=""
	for candidate in "$dir/apksigner" "$dir/apksigner.bat"; do
		[ -f "$candidate" ] && signer_candidate="$candidate"
	done
	if [ -n "$aapt_candidate" ] && [ -n "$signer_candidate" ]; then
		AAPT="$aapt_candidate"
		APKSIGNER="$signer_candidate"
		break
	fi
done <<EOF
$(ls -d "$SDK_ROOT"/build-tools/* | sort -Vr)
EOF
[ -n "$AAPT" ] || fail "aapt2 not found in any $SDK_ROOT/build-tools revision"
[ -n "$APKSIGNER" ] || fail "apksigner not found in any $SDK_ROOT/build-tools revision"

echo "verifying $APK (mode: $mode)"

# Capture tool output once and match in-shell: piping a large listing into
# `grep -q` under `pipefail` can fail with SIGPIPE (141) as soon as grep exits.
contains() {
	case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

BADGING=$("$AAPT" dump badging "$APK")
contains "$BADGING" "package: name='app.cutlyra.editor.qa3'" \
	|| fail "QA3 APK has the wrong package id"
contains "$BADGING" "application-label:'Cutlyra QA3'" \
	|| fail "QA3 APK has the wrong application label"
contains "$BADGING" "launchable-activity: name='app.cutlyra.editor.FirstRunActivity'  label='Cutlyra QA3'" \
	|| fail "QA3 APK has the wrong launchable activity/label"
XMLTREE=$("$AAPT" dump xmltree --file AndroidManifest.xml "$APK")
contains "$XMLTREE" 'app.cutlyra.editor.qa3.fileprovider' \
	|| fail "QA3 APK is missing its own FileProvider authority"

# Never the production, historical or QA2 identity: matching one of those
# means QA3 could not coexist (differently signed) or would hijack an install.
for wrong in app.cutlyra.editor app.cutlyra.editor.qa app.cutlyra.editor.qa2; do
	if contains "$BADGING" "package: name='$wrong'"; then
		fail "QA3 APK must be app.cutlyra.editor.qa3, not $wrong"
	fi
done

unzip -t "$APK" >/dev/null || fail "QA3 APK is not a valid zip"
LISTING=$(unzip -l "$APK")
for entry in \
	"assets/public/index.html" \
	"assets/models/ggml-tiny.en.bin" \
	"lib/arm64-v8a/libcutlyra_whisper.so" \
	"lib/x86_64/libcutlyra_whisper.so"; do
	contains "$LISTING" "$entry" || fail "QA3 APK is missing $entry"
done

echo "$APKSIGNER" >/dev/null
APK_SHA256=$(sha256sum "$APK" | cut -d' ' -f1)
echo "$APK_SHA256  $APK" > "$APK_DIR/qa3-apk.sha256"

if [ "$mode" = "unsigned" ]; then
	# No keystore in PR CI means no signature at all. A debug signature here
	# would silently reintroduce the un-updatable-install problem QA3 exists
	# to remove.
	if "$APKSIGNER" verify "$APK" >/dev/null 2>&1; then
		"$APKSIGNER" verify --print-certs "$APK" >&2 || true
		fail "QA3 APK is signed; without the QA3 keystore it must be unsigned"
	fi
	SIGNER_LINE="- signing: none (no QA3 keystore in PR CI, by design)"
else
	"$APKSIGNER" verify "$APK" >/dev/null || fail "QA3 APK does not verify"
	CERTS=$("$APKSIGNER" verify --print-certs "$APK")
	echo "$CERTS" > "$APK_DIR/qa3-signer.txt"
	if echo "$CERTS" | grep -q "CN=Android Debug"; then
		fail "QA3 APK is debug-signed; it must use the dedicated QA3 key"
	fi
	SIGNER_SHA256=$(echo "$CERTS" | grep -o 'certificate SHA-256 digest: [0-9a-f]*' | head -1 | sed 's/.*: //')
	[ -n "$SIGNER_SHA256" ] || fail "could not read the QA3 signer certificate digest"
	pinned=$(printf '%s' "${INTERNAL_QA3_CERT_SHA256:-}" | tr -d '[:space:]:' | tr 'A-F' 'a-f')
	[ -n "$pinned" ] || fail "vars.CUTLYRA_QA3_CERT_SHA256 is not configured"
	[ "$SIGNER_SHA256" = "$pinned" ] \
		|| fail "QA3 signer certificate mismatch: built=$SIGNER_SHA256 pinned=$pinned"
	SIGNER_LINE="- signer cert sha256: \`$SIGNER_SHA256\`"
fi

echo "QA3 APK ok: package app.cutlyra.editor.qa3, sha256 $APK_SHA256"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo "### QA3 APK (${mode})"
		echo ""
		echo "- source commit: \`${QA3_SOURCE_SHA:-${GITHUB_SHA:-unknown}}\`"
		echo "- package: \`app.cutlyra.editor.qa3\`"
		echo "- label: \`Cutlyra QA3\`"
		echo "- provider: \`app.cutlyra.editor.qa3.fileprovider\`"
		echo "- apk sha256: \`$APK_SHA256\`"
		echo "$SIGNER_LINE"
	} >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$mode" = "signed" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo ""
		echo "Install only after confirming both digests:"
		echo ""
		echo '```'
		echo "adb install -r $APK"
		echo '```'
	} >> "$GITHUB_STEP_SUMMARY"
fi
