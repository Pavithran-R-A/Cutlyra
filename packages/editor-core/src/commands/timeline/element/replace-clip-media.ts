import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { toast } from "@/core/notifications";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { findTrackInSceneTracks, updateElementInSceneTracks } from "@/timeline";
import {
	planClipMediaReplacement,
	type ReplaceMediaPlanOk,
} from "@/timeline/replace-media";
import type { ElementRef, SceneTracks } from "@/timeline";

/**
 * Nondestructive Replace Clip (#74): point an existing timeline clip at a
 * different already-imported media asset, keeping every authored property.
 *
 * **Why this is not `AddMediaAssetCommand` + `UpdateElementsCommand`.**
 * Composing those two would make the replacement TWO undo entries, and
 * `AddMediaAssetCommand` also adopts a canvas aspect and ratchets the project
 * frame rate for an import — both project-setting changes a replacement must
 * never make (replacing media is not a new project setup). So the asset
 * registration and the element patch live in this one command, which owns
 * exactly one undo step and touches no project settings.
 *
 * **Ordering is the safety property.** The asset enters the library first,
 * while nothing references it; only then does the element point at it. The
 * persistence failure handler can therefore always roll back to a consistent
 * state: the old element patch, and an asset list without the new entry. The
 * reverse order (patch first) would let a failed save delete a clip that now
 * references a media row that never landed.
 *
 * **The old asset is never deleted.** It stays in the project's media library
 * because other clips may still reference it and because an undo must not
 * depend on media that has already been thrown away. A replacement that leaves
 * the old asset unreferenced leaves a *library* asset, not an orphan: the
 * library, save/reopen and backup all handle assets with no clips.
 */
export class ReplaceClipMediaCommand extends Command {
	private readonly projectId: string;
	private readonly ref: ElementRef;
	private readonly asset: MediaAsset;
	private readonly allowClamp: boolean;

	private savedTracks: SceneTracks | null = null;
	private savedAssets: MediaAsset[] | null = null;
	private appliedPlan: ReplaceMediaPlanOk | null = null;
	private addedAsset = false;
	private previousName: string | null = null;

	constructor({
		projectId,
		ref,
		asset,
		allowClamp = false,
	}: {
		projectId: string;
		ref: ElementRef;
		asset: MediaAsset;
		allowClamp?: boolean;
	}) {
		super();
		this.projectId = projectId;
		this.ref = ref;
		this.asset = asset;
		this.allowClamp = allowClamp;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedTracks = editor.scenes.getActiveScene().tracks;
		this.savedAssets = [...editor.media.getAssets()];

		const track = findTrackInSceneTracks({
			tracks: this.savedTracks,
			trackId: this.ref.trackId,
		});
		const element = track?.elements.find(
			(candidate) => candidate.id === this.ref.elementId,
		);
		if (!element) return undefined;

		const plan = planClipMediaReplacement({
			element,
			asset: this.asset,
			allowClamp: this.allowClamp,
		});
		if (!plan.ok) {
			// Callers validate with the same planner before executing (so they can
			// show a confirmation instead of an error). Reaching here means a real
			// bug — fail loudly rather than half-apply a replacement.
			throw new Error(`Replace clip refused: ${plan.message}`);
		}

		this.appliedPlan = plan;
		this.previousName = element.name;

		// 1. Register the replacement asset while nothing references it yet.
		const alreadyRegistered = this.savedAssets.some(
			(candidate) => candidate.id === this.asset.id,
		);
		if (alreadyRegistered) {
			// Re-linking a clip to an asset that is already in the library (the
			// missing-media recovery path after a re-import) must not duplicate
			// the row, and must not delete a shared asset on undo.
			this.addedAsset = false;
		} else {
			editor.media.setAssets({
				assets: [...this.savedAssets, this.asset],
			});
			this.addedAsset = true;
		}

		// 2. Point the clip at it, keeping everything the plan did not name.
		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedTracks,
			trackId: this.ref.trackId,
			elementId: this.ref.elementId,
			// The planner already validated that this is a video/image element, and
			// `plan.patch` is the flat video/image field set, so the spread keeps
			// the element's own discriminant without a cast.
			update: (current) =>
				current.type === "video" || current.type === "image"
					? { ...current, ...plan.patch }
					: current,
		});
		editor.timeline.updateTracks(updatedTracks);

		// 3. Persist the new media row. On failure roll BOTH steps back so the
		// project can never reference a media row that failed to land.
		if (this.addedAsset) {
			storageService
				.saveMediaAsset({
					projectId: this.projectId,
					mediaAsset: this.asset,
				})
				.catch((error) => {
					console.error("Failed to persist replacement media:", error);
					this.rollbackAfterFailedSave();
					toast.error({
						message: "Couldn't save the replacement",
						description:
							storageService.isQuotaExceededError({ error }) && error instanceof Error
								? `${error.message} — the clip was left unchanged`
								: "The clip was left unchanged",
					});
				});
		}

		return undefined;
	}

	undo(): void {
		const editor = EditorCore.getInstance();

		if (this.savedTracks) {
			editor.timeline.updateTracks(this.savedTracks);
		}

		if (this.addedAsset && this.savedAssets) {
			editor.media.setAssets({ assets: this.savedAssets });
			videoCache.clearVideo({ mediaId: this.asset.id });
			storageService
				.deleteMediaAsset({ projectId: this.projectId, id: this.asset.id })
				.catch((error) => {
					console.error("Failed to delete replacement media on undo:", error);
				});
		}

		this.addedAsset = false;
	}

	getAppliedPlan(): ReplaceMediaPlanOk | null {
		return this.appliedPlan;
	}

	getPreviousName(): string | null {
		return this.previousName;
	}

	private rollbackAfterFailedSave(): void {
		const editor = EditorCore.getInstance();
		if (this.savedTracks) {
			editor.timeline.updateTracks(this.savedTracks);
		}
		if (this.addedAsset && this.savedAssets) {
			editor.media.setAssets({ assets: this.savedAssets });
			videoCache.clearVideo({ mediaId: this.asset.id });
		}
		this.addedAsset = false;
	}
}
