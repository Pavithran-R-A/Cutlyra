import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";

/** The custody paths one media row points at (proxy and original). */
export function referencedAssetPaths(asset: MediaAsset): string[] {
	const paths: string[] = [];
	if (asset.nativeRelativePath) paths.push(asset.nativeRelativePath);
	if (asset.sourceNativeRelativePath) paths.push(asset.sourceNativeRelativePath);
	return paths;
}

/** Union of [referencedAssetPaths] over a set of assets. */
export function referencedAssetPathsOf(assets: MediaAsset[]): string[] {
	const paths = new Set<string>();
	for (const asset of assets) {
		for (const path of referencedAssetPaths(asset)) paths.add(path);
	}
	return [...paths];
}

/**
 * Every custody path a generated-media sweep must preserve.
 *
 * Three sources, because a generated file can outlive the media row that
 * currently points at it:
 *  - the ACTIVE project's media rows;
 *  - every command in the active project's undo/redo history — undoing an
 *    insert deletes its media row but keeps the command, so the file must
 *    survive for redo;
 *  - every OTHER saved project's media rows, because custody is app-global
 *    (`noBackupFilesDir`) while a sweep runs against one project at a time.
 *
 * `includeAsset` narrows which asset kinds contribute paths (a voiceover
 * sweep only needs voiceover assets, for example). Undo/redo paths are always
 * included: they are already narrow and cheap, and missing one reintroduces
 * the broken-redo bug this helper exists to prevent.
 *
 * Storage failures are non-fatal: returning fewer paths can only make the
 * caller MORE conservative, never delete something it should have kept.
 */
export async function referencedCustodyPaths({
	editor,
	includeAsset,
}: {
	editor: EditorCore;
	includeAsset?: (asset: MediaAsset) => boolean;
}): Promise<string[]> {
	const matches = (asset: MediaAsset) => includeAsset?.(asset) ?? true;
	const paths = new Set<string>();

	for (const asset of editor.media.getAssets()) {
		if (!matches(asset)) continue;
		for (const path of referencedAssetPaths(asset)) paths.add(path);
	}

	for (const path of editor.command.referencedMediaPaths()) {
		paths.add(path);
	}

	try {
		const activeId = editor.project.getActiveOrNull()?.metadata.id;
		const projects = await storageService.loadAllProjectsMetadata();
		for (const project of projects) {
			if (project.id === activeId) continue;
			const assets = await storageService.loadAllMediaAssets({ projectId: project.id });
			for (const asset of assets) {
				if (!matches(asset)) continue;
				for (const path of referencedAssetPaths(asset)) paths.add(path);
			}
		}
	} catch {
		// Best effort: see the doc comment above.
	}

	return [...paths];
}
