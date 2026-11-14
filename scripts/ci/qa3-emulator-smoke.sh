#!/usr/bin/env bash
# QA3 emulator smoke test.
#
# Run as a single command by the emulator runner (which pipes each script LINE
# through its own shell, so variables and `set -e` do not survive between
# lines — hence this file rather than an inline script).
#
# Proves the artifact that will be handed to the owner actually starts:
#   1. finds the QA3 APK, 2. installs it, 3. checks the package identity,
#   4. checks its own app-private storage, 5. launches FirstRunActivity,
#   6. checks the process survives, 7. checks for startup exceptions,
#   8. checks the activity is resumed, 9. fails on any broken assertion.
#
# Never prints key material. Invoked from apps/mobile/android.
set -euo pipefail

PACKAGE="app.cutlyra.editor.qa3"
ACTIVITY="$PACKAGE/app.cutlyra.editor.FirstRunActivity"
APK_DIR="app/build/outputs/apk/qa3"

fail() {
	echo "::error::QA3 smoke: $*" >&2
	exit 1
}

command -v adb >/dev/null || fail "adb not on PATH"

# CI runners hand the device over the moment the emulator reports booted;
# package-manager work can still fail for a few seconds, so wait and retry
# rather than reporting a false failure.
adb wait-for-device || fail "no adb device"

APK=$(find "$APK_DIR" -maxdepth 1 -name '*.apk' | sort | head -1)
[ -n "$APK" ] && [ -s "$APK" ] || fail "no QA3 APK in $APK_DIR"
echo "SMOKE: apk=$APK"

# 2. install
install_output=""
installed=0
for attempt in 1 2 3; do
	if install_output=$(adb install -r "$APK" 2>&1); then
		installed=1
		break
	fi
	echo "SMOKE: install attempt $attempt failed: $install_output" >&2
	sleep 10
done
[ "$installed" = 1 ] || fail "adb install failed: $install_output"
echo 'SMOKE: installed'

# 3. package identity
adb shell pm list packages | grep -qx "package:$PACKAGE" || fail "package $PACKAGE is not installed"
echo "SMOKE: package $PACKAGE present"

# 4. own app-private storage (and a provider authority that is QA3's own)
adb shell run-as "$PACKAGE" ls >/dev/null 2>&1 || fail "$PACKAGE has no readable app-private data dir"
adb shell dumpsys package "$PACKAGE" | grep -q "$PACKAGE.fileprovider" || fail "FileProvider authority is not $PACKAGE.fileprovider"
qa3_uid=$(adb shell cmd package list packages -U | grep "^package:$PACKAGE " | sed 's/.*uid://' | tr -d '\r')
[ -n "$qa3_uid" ] || fail "could not read the QA3 uid"
echo "SMOKE: independent storage (uid=$qa3_uid)"
if adb shell pm list packages | grep -qx "package:app.cutlyra.editor"; then
	prod_uid=$(adb shell cmd package list packages -U | grep '^package:app.cutlyra.editor ' | sed 's/.*uid://' | tr -d '\r')
	[ -n "$prod_uid" ] && [ "$qa3_uid" != "$prod_uid" ] || fail "QA3 shares a uid with production ($qa3_uid)"
	echo "SMOKE: distinct uid from production ($qa3_uid/$prod_uid)"
fi

# 5. launch
adb logcat -c || fail "could not clear logcat"
adb shell am start -W -n "$ACTIVITY" >/dev/null || fail "FirstRunActivity did not start"
echo 'SMOKE: launched'

# 6. process alive after it has had time to initialise native plugins
sleep 20
adb shell pidof "$PACKAGE" >/dev/null || fail "$PACKAGE is not running 20s after launch"
echo 'SMOKE: process alive'

# 7. startup exceptions for this package only
fatal=$(adb logcat -d -s AndroidRuntime:E | grep 'FATAL EXCEPTION' | grep "$PACKAGE" || true)
[ -z "$fatal" ] || fail "startup crash: $fatal"
echo 'SMOKE: no fatal crash'

# 8. the expected activity is the resumed one
adb shell dumpsys activity activities | grep -q "ResumedActivity.*$PACKAGE" || fail "$PACKAGE is not the resumed activity"
echo 'SMOKE: resumed'

echo 'SMOKE: QA3 emulator smoke passed'
