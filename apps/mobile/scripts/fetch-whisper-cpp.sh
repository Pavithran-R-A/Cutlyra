#!/usr/bin/env bash
# Cutlyra — build-step fetch of the whisper.cpp C/C++ sources that
# `libcutlyra_whisper.so` is compiled from (Android captions).
#
# Same policy as the sibling `download-whisper-model.sh`: fetched at BUILD
# time, pinned to an exact tag, never committed to this repo (whisper.cpp is
# ~40MB of MIT-licensed third-party source with its own history — see
# THIRD_PARTY_NOTICES). Vendoring it as files would bury a dependency this
# project does not own inside its own diff history; a git submodule was
# ruled out by the plan (risk #6, "own the dependency tree"), so a pinned,
# shallow, verifiable clone into a gitignored directory is what is left.
#
# The checkout lands where app/src/main/cpp/CMakeLists.txt expects it. The
# NDK build is a no-op without it: CMake skips the native library and the
# app still builds, it just cannot transcribe (WhisperJNI throws
# UnsatisfiedLinkError, surfaced to the user as a caption error).
#
# Usage: scripts/fetch-whisper-cpp.sh [--force]
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$MOBILE_DIR/android/app/src/main/cpp/whisper.cpp"

# Pinned tag. Bumping this is a deliberate act: the JNI glue in
# cutlyra_whisper_jni.cpp is written against this version's whisper.h
# (notably `dtw_token_timestamps`, `dtw_aheads_preset`, and
# `whisper_full_get_token_data`'s `t_dtw` field, all of which are
# comparatively recent additions).
WHISPER_TAG="v1.9.2"
# Immutable commit behind v1.9.2. The tag is retained for readability, while
# this SHA prevents a moved/retagged ref from silently changing release input.
WHISPER_COMMIT="306c88f4d1286aec1bf96e544632897886af5501"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"

if [ "${1:-}" = "--force" ]; then
	rm -rf "$DEST"
fi

if [ -f "$DEST/include/whisper.h" ]; then
	echo "==> whisper.cpp already present at $DEST (use --force to re-fetch)"
	exit 0
fi

echo "==> Cloning whisper.cpp $WHISPER_TAG"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
git clone --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$DEST"
actual_commit="$(git -C "$DEST" rev-parse HEAD)"
if [ "$actual_commit" != "$WHISPER_COMMIT" ]; then
	echo "ERROR: whisper.cpp $WHISPER_TAG resolved to unexpected commit" >&2
	echo "  expected: $WHISPER_COMMIT" >&2
	echo "  actual:   $actual_commit" >&2
	rm -rf "$DEST"
	exit 1
fi
echo "    commit OK ($actual_commit)"

# The clone's own .git is dead weight (and would confuse the outer repo's
# status); the pinned tag above is the provenance record.
rm -rf "$DEST/.git"

# The addon.node example ships a *.spec.js that the outer repo's `bun test`
# would otherwise discover and fail on (it needs a prebuilt native addon
# that only exists inside whisper.cpp's own CI). Nothing under examples/
# is referenced by app/src/main/cpp/CMakeLists.txt, so the whole directory
# is safe to prune; it also trims a few MB from the working tree.
rm -rf "$DEST/examples"

echo "==> Done: $DEST"
