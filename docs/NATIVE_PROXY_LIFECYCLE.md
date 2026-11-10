# Native proxy lifecycle (Replace Clip / import) — unresolved cleanup limitation

Status: **documented limitation, no safe cleanup implemented in PR #72.**

## Ownership

- **Source media (full-resolution original):** owned by native custody under the app container
  (`Media/native/<id>-source…` style relative paths; see `MediaAsset.sourceNativeRelativePath`).
  Never deleted by the editor; it is the durable identity for export quality.
- **Proxy (preview/transcode):** produced by native transcode into app-controlled **cache**
  locations:
  - Android: `cacheDir/proxies/<assetId>-<uuid>.mp4` (`ProxyTranscoder.kt`).
  - iOS: native sandbox proxy path exposed via `MediaSandbox.proxyURL` / native transcode result.
  - Web fallback: proxy URI equals the source URI (no separate file).
- **Thumbnail:** native-relative thumbnail path (`thumbnailNativeRelativePath`) or a custody URL;
  owned alongside the asset metadata.
- **Editor-side asset row:** `MediaAsset` (in-memory) + `MediaAssetData` (IndexedDB/OPFS) is the
  web-side record; native paths are stored relative so container-UUID rotation re-anchors.

## Proxy generation vs. Replace Clip

Replace Clip (`ReplaceClipMediaCommand`) repoints an existing timeline clip at an
**already-imported/registered** `MediaAsset`. It does not invoke native proxy
generation or cancellation itself; proxy/source/thumbnail custody is established
during import (`importMediaFromNative`), not during clip repointing. Export quality
never depends on the 540p proxy — `buildNativeEdlAssetResolver` prefers the
full-resolution source and only falls back to the proxy.

## Cancellation / temp-file behaviour

- Native transcode/export paths contain cancellation handling (`Transformer.cancel()`,
  `EdlExportError.cancelled` cleanup in places).
- The Capacitor/native bridge exposes **no** verified safe proxy-deletion or
  cleanup operation (`deleteProxy`/`cleanupProxy` not present in `packages/native-bridge`
  types or bridge surface).
- Proxy files live in platform-managed cache locations with UUID names; on cancelled or
  abandoned import flows they may be orphaned until platform cache eviction.

## Why no cleanup is implemented here

Safe deletion requires proving an artifact is unreferenced by every project/media handle,
including concurrent in-flight operations, undo/redo history, and other projects sharing
custody paths. That reference contract is not defined anywhere in the current native
bridge, and there is no API to enumerate or delete proxies. Implementing deletion by
guessing filesystem paths or recursively cleaning cache directories would risk deleting
user source media or in-use proxies.

## Future cleanup requirements (not in scope of PR #72)

1. A native-owned, reference-checked cleanup API that accepts an asset id (not a path)
   and deletes only proxies/thumbnails proven unreferenced.
2. Reference checks across all projects and in-flight operations before any deletion.
3. Explicit cache-retention/GC policy (size/time based) as a fallback for orphans.
4. Never delete user-selected source media; source custody is never auto-cleaned.

## Constraints preserved

- No large JavaScript in-memory copies of imported video files.
- No unsafe recursive cleanup or guessed-path deletion.
- User-selected source media is never deleted.
EOF
echo done