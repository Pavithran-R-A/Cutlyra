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

# soundtouchjs 0.3.0 is a runtime dependency used by the mobile editor's
# pitch-preserving preview path. Bun's isolated install layout does not
# guarantee a root node_modules/soundtouchjs/LICENSE path, so the exact
# upstream v0.3.0 LGPL-2.1 text is tracked in legal/ and copied from there.
# Provenance: cutterbl/SoundTouchJS v0.3.0 commit
# 36b161bb7d69d801b6a81674ad0fc0c42082729f.
SOUNDTOUCH_LICENSE="$REPO_ROOT/legal/SOUNDTOUCHJS-LGPL-2.1.txt"
if [ ! -s "$SOUNDTOUCH_LICENSE" ]; then
  echo "ERROR: tracked SoundTouchJS LGPL-2.1 license is missing." >&2
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
