import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { toast } from "@/core/notifications";
import type { MediaAsset } from "@/media/types";
import { generateUUID } from "@/utils/id";
import { storageService } from "@/services/storage/service";
import type { FrameRate } from "opencut-wasm";
import { hasMediaId } from "@/timeline/element-utils";
import { frameRatesEqual, getHighestImportedVideoFps } from "@/fps/utils";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import type { TCanvasSize } from "@/project/types";

export class AddMediaAssetCommand extends Command {
	private assetId: string;
	private savedAssets: MediaAsset[] | null = null;
	private createdAsset: MediaAsset | null = null;
	private previousProjectFps: FrameRate | null = null;
	private appliedProjectFps: FrameRate | null = null;
	private previousCanvasSize: TCanvasSize | null = null;
	private appliedCanvasSize: TCanvasSize | null = null;

	constructor({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}) {
		super();
		this.projectId = projectId;
		this.asset = asset;
		this.assetId = generateUUID();
	}

	private projectId: string;
	private asset: Omit<MediaAsset, "id">;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedAssets = [...editor.media.getAssets()];

		this.createdAsset = {
			...this.asset,
			id: this.assetId,
		};

		editor.media.setAssets({
			assets: [...this.savedAssets, this.createdAsset],
		});
		this.previousProjectFps = editor.project.getActiveOrNull()?.settings.fps ?? null;
		this.appliedProjectFps = editor.project.ratchetFpsForImportedMedia({
			importedAssets: [this.createdAsset],
		});
		// Canvas-aspect adoption, same seam as the fps ratchet above. The
		// NATIVE (mobile) import path funnels through this command, while the
		// web path goes through `MediaManager.addMediaAsset` — before this
		// line the two diverged, and on device a portrait clip imported into
		// a factory-default project left the canvas at 1920x1080, so the
		// export cropped the portrait footage to landscape (Stage-4 D-NEW-4).
		// Reusing the project-manager method means the exact same guards apply
		// (first visual asset only; untouched factory-default canvas; user
		// choice always wins), so existing projects are never silently
		// re-shaped — only a brand-new default project adopting the aspect of
		// its very first visual import.
		this.previousCanvasSize = editor.project.getActiveOrNull()?.settings.canvasSize ?? null;
		this.appliedCanvasSize = editor.project.adoptCanvasAspectForImportedMedia({
			importedAssets: [this.createdAsset],
			hadVisualMediaBefore: this.savedAssets.some(
				(existing) => existing.type === "video" || existing.type === "image",
			),
		});

		storageService
			.saveMediaAsset({
				projectId: this.projectId,
				mediaAsset: this.createdAsset,
			})
			.catch((error) => {
				console.error("Failed to save media item:", error);

				const currentAssets = editor.media.getAssets();
				editor.media.setAssets({
					assets: currentAssets.filter((asset) => asset.id !== this.assetId),
				});

				const currentTracks = editor.scenes.getActiveScene().tracks;
				const orphanedElements: Array<{ trackId: string; elementId: string }> =
					[];

				for (const track of [
					...currentTracks.overlay,
					currentTracks.main,
					...currentTracks.audio,
				]) {
					for (const element of track.elements) {
						if (hasMediaId(element) && element.mediaId === this.assetId) {
							orphanedElements.push({
								trackId: track.id,
								elementId: element.id,
							});
						}
					}
				}

				if (orphanedElements.length > 0) {
					editor.timeline.deleteElements({ elements: orphanedElements });
				}

				this.restoreProjectFpsAfterFailedSave({ editor });
				this.restoreCanvasAfterFailedSave({ editor });

				if (storageService.isQuotaExceededError({ error })) {
					toast.error({
						message: "Not enough browser storage",
						description: error instanceof Error ? error.message : undefined,
					});
				}
			});

		return undefined;
	}

	undo(): void {
		if (this.savedAssets) {
			const editor = EditorCore.getInstance();
			editor.media.setAssets({ assets: this.savedAssets });

			if (this.createdAsset) {
				storageService
					.deleteMediaAsset({ projectId: this.projectId, id: this.assetId })
					.catch((error) => {
						console.error("Failed to delete media item on undo:", error);
					});
			}
		}
	}

	getAssetId(): string {
		return this.assetId;
	}

	private restoreProjectFpsAfterFailedSave({
		editor,
	}: {
		editor: EditorCore;
	}): void {
		if (this.previousProjectFps === null || this.appliedProjectFps === null) return;

		const activeProject = editor.project.getActiveOrNull();
		if (!activeProject) return;
		if (
			!this.appliedProjectFps ||
			!frameRatesEqual({
				a: activeProject.settings.fps,
				b: this.appliedProjectFps,
			})
		)
			return;

		const highestRemainingVideoFps = getHighestImportedVideoFps({
			mediaAssets: editor.media.getAssets(),
		});
		const appliedFpsFloat = this.appliedProjectFps.numerator / this.appliedProjectFps.denominator;
		if (
			highestRemainingVideoFps !== null &&
			highestRemainingVideoFps >= appliedFpsFloat
		) {
			return;
		}

		new UpdateProjectSettingsCommand({ fps: this.previousProjectFps }).execute();
	}

	private restoreCanvasAfterFailedSave({
		editor,
	}: {
		editor: EditorCore;
	}): void {
		if (this.previousCanvasSize === null || this.appliedCanvasSize === null) return;

		const activeProject = editor.project.getActiveOrNull();
		if (!activeProject) return;

		// Only roll back if the canvas is still exactly what we set — if the
		// user has since changed it themselves, their intent wins (same rule
		// as the fps restore above).
		if (
			activeProject.settings.canvasSize.width !== this.appliedCanvasSize.width ||
			activeProject.settings.canvasSize.height !== this.appliedCanvasSize.height
		)
			return;

		new UpdateProjectSettingsCommand({ canvasSize: this.previousCanvasSize }).execute();
	}
}
