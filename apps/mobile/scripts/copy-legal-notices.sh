#!/usr/bin/env bash
# Copy release-facing license/notice material into the generated mobile web
# bundle. This runs AFTER vite build and BEFORE Capacitor sync, so the files
# land inside Android/iOS app assets without duplicating tracked legal text.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
OUT="$MOBILE_DIR/www/legal"

rm -rf "$OUT"
mkdir -p "$OUT"

cp "$REPO_ROOT/LICENSE" "$OUT/CUTLYRA-LICENSE.txt"
cp "$REPO_ROOT/NOTICE" "$OUT/CUTLYRA-NOTICE.txt"
cp "$REPO_ROOT/docs/THIRD_PARTY_NOTICES.md" "$OUT/THIRD_PARTY_NOTICES.md"

# soundtouchjs is a runtime dependency used by the mobile editor's
# pitch-preserving preview path. Its package declares LGPL-2.1, so preserve
# the package's own license text inside every binary distribution rather than
# relying on a network link.
SOUNDTOUCH_LICENSE=""
for candidate in   "$REPO_ROOT/node_modules/soundtouchjs/LICENSE"   "$REPO_ROOT/node_modules/soundtouchjs/LICENSE.md"   "$REPO_ROOT/node_modules/soundtouchjs/LICENSE.txt"; do
  if [ -s "$candidate" ]; then
    SOUNDTOUCH_LICENSE="$candidate"
    break
  fi
done
if [ -z "$SOUNDTOUCH_LICENSE" ]; then
  echo "ERROR: soundtouchjs license file not found after dependency install." >&2
  exit 1
fi
cp "$SOUNDTOUCH_LICENSE" "$OUT/SOUNDTOUCHJS-LICENSE.txt"

# whisper.cpp is a build-time fetch. When present (release/Android CI), ship
# its upstream MIT license verbatim too. Plain web/dev builds that have not
# fetched the native source remain valid because THIRD_PARTY_NOTICES.md still
# records its provenance and license.
WHISPER_LICENSE="$MOBILE_DIR/android/app/src/main/cpp/whisper.cpp/LICENSE"
if [ -s "$WHISPER_LICENSE" ]; then
  cp "$WHISPER_LICENSE" "$OUT/WHISPERCPP-LICENSE.txt"
fi

echo "==> Legal notices staged in $OUT"
