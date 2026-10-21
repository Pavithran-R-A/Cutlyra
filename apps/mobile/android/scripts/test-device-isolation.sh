#!/usr/bin/env bash
# Self-test for apps/mobile/android/app/device-isolation.gradle.
#
# Exercises every guard branch against mocked `adb devices` inventories using
# `--dry-run` Gradle invocations only: no Gradle task ever executes and no
# physical device is ever contacted by anything except the guard's read-only
# `adb devices` (which, in these tests, is a mocked binary).
#
# Exit code 0 = all cases behaved as expected; 1 = at least one mismatch.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GRADLEW="$ANDROID_DIR/gradlew"
MOCK_DIR="$(mktemp -d)"
trap 'rm -rf "$MOCK_DIR"' EXIT

IS_WINDOWS=false
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=true ;;
esac

FAILURES=0

make_mock() { # $1 = mock name, $2 = body (bash) executed as `adb devices`
    local name="$1" body="$2"
    local sh_path="$MOCK_DIR/$name.sh"
    {
        echo '#!/usr/bin/env bash'
        printf '%s\n' "$body"
    } >"$sh_path"
    chmod +x "$sh_path"
    if $IS_WINDOWS; then
        # Gradle launches the path via CreateProcess; a .bat delegating to
        # bash keeps the mock runnable on Windows hosts.
        local bat_path="$MOCK_DIR/$name.bat"
        printf '@echo off\r\nbash "%s"\r\n' "$sh_path" >"$bat_path"
        echo "$bat_path"
    else
        echo "$sh_path"
    fi
}

# run_case <label> <expect: allow|refuse> <reason-pattern|-> <adb-path|-> [extra gradle args...]
run_case() {
    local label="$1" expect="$2" pattern="$3" adb_path="$4"
    shift 4
    local out rc actual
    if [ -n "$adb_path" ]; then
        out="$(cd "$ANDROID_DIR" && CUTLYRA_ADB="$adb_path" "$GRADLEW" :app:connectedDebugAndroidTest --dry-run --console=plain "$@" 2>&1)"
    else
        out="$(cd "$ANDROID_DIR" && "$GRADLEW" :app:connectedDebugAndroidTest --dry-run --console=plain "$@" 2>&1)"
    fi
    rc=$?
    if [ "$expect" = "allow" ]; then
        actual=refuse
        [ $rc -eq 0 ] && echo "$out" | grep -q "Device isolation OK" && actual=allow
    else
        actual=other
        [ $rc -ne 0 ] && echo "$out" | grep -q "DEVICE ISOLATION" && actual=refuse
    fi
    if [ "$actual" = "$expect" ]; then
        if [ "$expect" = "refuse" ] && [ -n "$pattern" ] && ! echo "$out" | grep -q "$pattern"; then
            echo "FAIL  $label (refused, but reason did not match: $pattern)"
            echo "$out" | tail -5 | sed 's/^/      /'
            FAILURES=$((FAILURES + 1))
        else
            echo "PASS  $label"
        fi
    else
        echo "FAIL  $label (expected $expect, got $actual, rc=$rc)"
        echo "$out" | tail -8 | sed 's/^/      /'
        FAILURES=$((FAILURES + 1))
    fi
}

SELFTEST=(-PCUTLYRA_GUARD_SELFTEST=1)

MOCK_EMULATOR="$(make_mock emulator-only $'echo "List of devices attached"\necho -e "emulator-5554\\tdevice"')"
MOCK_TWO_EMULATORS="$(make_mock two-emulators $'echo "List of devices attached"\necho -e "emulator-5554\\tdevice"\necho -e "emulator-5556\\tdevice"')"
MOCK_PHYSICAL="$(make_mock physical-device $'echo "List of devices attached"\necho -e "TESTPHONE0001\\tdevice"')"
MOCK_UNAUTHORIZED="$(make_mock unauthorized $'echo "List of devices attached"\necho -e "TESTPHONE0001\\tunauthorized"')"
MOCK_OFFLINE="$(make_mock offline $'echo "List of devices attached"\necho -e "TESTPHONE0001\\toffline"')"
MOCK_MIXED="$(make_mock mixed $'echo "List of devices attached"\necho -e "emulator-5554\\tdevice"\necho -e "TESTPHONE0001\\tdevice"')"
MOCK_EMPTY="$(make_mock empty $'echo "List of devices attached"')"
MOCK_FAIL="$(make_mock adb-fails $'echo "adb: server-side failure" >&2\nexit 1')"
MOCK_GARBAGE="$(make_mock garbage $'echo "List of devices attached"\necho "????"')"
MOCK_NONEXISTENT="$MOCK_DIR/definitely-not-an-adb-binary"

echo "== device-isolation.gradle self-test (dry-run only) =="
run_case "S1  single emulator -> allow"               allow  "-"                 "$MOCK_EMULATOR"      "${SELFTEST[@]}"
run_case "S2  two emulators -> allow"                 allow  "-"                 "$MOCK_TWO_EMULATORS" "${SELFTEST[@]}"
run_case "S3  physical device -> refuse"              refuse "physical"          "$MOCK_PHYSICAL"      "${SELFTEST[@]}"
run_case "S4  unauthorized physical -> refuse"        refuse "ambiguous"         "$MOCK_UNAUTHORIZED"  "${SELFTEST[@]}"
run_case "S5  offline physical -> refuse"             refuse "ambiguous"         "$MOCK_OFFLINE"       "${SELFTEST[@]}"
run_case "S6  emulator + physical -> refuse"          refuse "physical"          "$MOCK_MIXED"         "${SELFTEST[@]}"
run_case "S7  empty inventory -> allow"               allow  "-"                 "$MOCK_EMPTY"         "${SELFTEST[@]}"
run_case "S8  adb exits non-zero -> refuse"           refuse "could not be read" "$MOCK_FAIL"          "${SELFTEST[@]}"
run_case "S9  unresolvable adb path -> refuse"        refuse "could not be read" "$MOCK_NONEXISTENT"   "${SELFTEST[@]}"
run_case "S10 CUTLYRA_ADB without selftest -> refuse" refuse "injected adb path" "$MOCK_EMULATOR"
run_case "S11 removed override property -> refuse"    refuse "no override"       "$MOCK_EMULATOR"      "${SELFTEST[@]}" -PCUTLYRA_DEVICE_ALLOW=TESTPHONE0001
run_case "S12 malformed inventory -> refuse"          refuse "could not be read" "$MOCK_GARBAGE"       "${SELFTEST[@]}"

# A non-device task graph must stay untouched by the guard even with a
# physical device "attached" (mocked), proving assemble-only CI jobs are safe.
out="$(cd "$ANDROID_DIR" && CUTLYRA_ADB="$MOCK_PHYSICAL" "$GRADLEW" :app:assembleDebug --dry-run --console=plain "${SELFTEST[@]}" 2>&1)"
rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q "BUILD SUCCESSFUL"; then
    echo "PASS  S13 non-device task (assembleDebug) unaffected by physical device"
else
    echo "FAIL  S13 non-device task should succeed regardless of inventory (rc=$rc)"
    echo "$out" | tail -8 | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
fi

echo "== done: $FAILURES failure(s) =="
[ "$FAILURES" -eq 0 ]
