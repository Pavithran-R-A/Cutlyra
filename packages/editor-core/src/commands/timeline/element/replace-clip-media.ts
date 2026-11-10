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
import { generateUUID } from "@/utils/id";

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
 * **Persistence is asynchronous and must not clobber newer work.** The
 * command changes in-memory state synchronously (the `Command.execute()`
 * contract) and persists the new media row afterwards. A naive
 * "restore the pre-execute snapshot on failure" is UNSAFE: by the time the
 * save rejects, the user may have made further edits, undone, redone, or run
 * a second replacement, and restoring a stale snapshot would silently delete
 * their work. Instead:
 *
 *  - every execution gets a unique `operationId`. Async callbacks are gated on
 *    it (and on a per-clip "latest operation" registry), so a stale callback
 *    from a superseded or undone operation can never mutate state.
 *  - on a failed save, the command compensates NARROWLY: it reverts the clip
 *    to its previous media identity ONLY if that clip still points at the
 *    replacement's asset (so a newer replacement is never overwritten), and
 *    it removes the orphan asset row only when nothing else references it.
 *    Full scene snapshots are never restored.
 *  - Undo invalidates the pending operation. If the save later resolves
 *    (success or failure), the callback removes the now-unwanted row instead
 *    of resurrecting metadata. Redo re-runs `execute()` with a fresh id.
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

	/** Unique id for the CURRENT execution. Null between executions. */
	private operationId: string | null = null;
	/** Operation ids this instance has invalidated (undo / supersession). */
	private readonly invalidatedOps = new Set<string>();

	/** Per-clip latest operation id, shared across command instances. */
	private static readonly activeOps = new Map<string, string>();

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

	private clipKey(): string {
		return `${this.projectId}:${this.ref.trackId}:${this.ref.elementId}`;
	}

	private isActive(opId: string): boolean {
		if (this.operationId !== opId) return false;
		if (this.invalidatedOps.has(opId)) return false;
		return ReplaceClipMediaCommand.activeOps.get(this.clipKey()) === opId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();

		// Invalidate any operation still pending from a previous execution of
		// THIS instance (e.g. a redo that follows an undo).
		if (this.operationId) {
			this.invalidatedOps.add(this.operationId);
		}
		const opId = generateUUID();
		this.operationId = opId;
		ReplaceClipMediaCommand.activeOps.set(this.clipKey(), opId);

		this.savedTracks = editor.scenes.getActiveScene().tracks;
		this.savedAssets = [...editor.media.getAssets()];
		this.addedAsset = false;
		this.appliedPlan = null;
		this.previousName = null;

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

		// 3. Persist the new media row. On failure compensate NARROWLY (never
		// restore a stale full-scene snapshot) so newer edits survive.
		if (this.addedAsset) {
			const capturedOpId = opId;
			storageService
				.saveMediaAsset({
					projectId: this.projectId,
					mediaAsset: this.asset,
				})
				.then(() => {
					if (!this.isActive(capturedOpId)) {
						// Undone or superseded after the save started: the row is
						// no longer wanted. Remove it (best-effort, idempotent).
						storageService
							.deleteMediaAsset({
								projectId: this.projectId,
								id: this.asset.id,
							})
							.catch((error) => {
								console.error("Failed to clean up superseded replacement media:", error);
							});
						return;
					}
					// Committed; nothing to do — the row is durable.
				})
				.catch((error) => {
					if (!this.isActive(capturedOpId)) {
						// Already undone/superseded: make sure no orphan row
						// survives (best-effort, idempotent).
						storageService
							.deleteMediaAsset({
								projectId: this.projectId,
								id: this.asset.id,
							})
							.catch((cleanupError) => {
								console.error("Failed to clean up replacement media on undo:", cleanupError);
							});
						return;
					}
					this.compensateFailedSave(capturedOpId, error);
				});
		}

		return undefined;
	}

	undo(): void {
		const editor = EditorCore.getInstance();

		// Invalidate the pending operation so a late save/delete callback
		// cannot resurrect or clobber state.
		if (this.operationId) {
			this.invalidatedOps.add(this.operationId);
			if (ReplaceClipMediaCommand.activeOps.get(this.clipKey()) === this.operationId) {
				ReplaceClipMediaCommand.activeOps.delete(this.clipKey());
			}
		}

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

	redo(): CommandResult | undefined {
		// Default base redo() calls execute(); re-running with a fresh id is
		// what we want, so delegate explicitly.
		return this.execute();
	}

	getAppliedPlan(): ReplaceMediaPlanOk | null {
		return this.appliedPlan;
	}

	getPreviousName(): string | null {
		return this.previousName;
	}

	/**
	 * Narrow compensation for a failed durable save. Reverts the clip's media
	 * identity ONLY if it still points at this replacement's asset, and removes
	 * the orphan asset row only when nothing else references it. Never restores
	 * a stale full-scene snapshot, so intervening edits survive.
	 */
	private compensateFailedSave(opId: string, error: unknown): void {
		if (!this.isActive(opId)) return;

		const editor = EditorCore.getInstance();
		const currentTracks = editor.scenes.getActiveScene().tracks;

		// Revert the clip only if it still references this replacement's asset.
		const currentTrack = findTrackInSceneTracks({
			tracks: currentTracks,
			trackId: this.ref.trackId,
		});
		const currentElement = currentTrack?.elements.find(
			(candidate) => candidate.id === this.ref.elementId,
		);
		const oldTrack = this.savedTracks
			? findTrackInSceneTracks({ tracks: this.savedTracks, trackId: this.ref.trackId })
			: null;
		const oldElement = oldTrack?.elements.find(
			(candidate) => candidate.id === this.ref.elementId,
		);

		if (
			currentElement &&
			oldElement &&
			(currentElement as { mediaId?: string }).mediaId === this.asset.id
		) {
			const revertPatch: Record<string, unknown> = {
				mediaId: (oldElement as { mediaId?: string }).mediaId,
				name: oldElement.name,
			};
			// Only revert timing fields the plan actually changed.
			if (this.appliedPlan?.clamped) {
				revertPatch.trimStart = oldElement.trimStart;
				revertPatch.duration = oldElement.duration;
				revertPatch.trimEnd = oldElement.trimEnd;
			}
			if ((oldElement as { sourceDuration?: unknown }).sourceDuration !== undefined) {
				revertPatch.sourceDuration = (oldElement as { sourceDuration?: unknown }).sourceDuration;
			}
			const patchedTracks = updateElementInSceneTracks({
				tracks: currentTracks,
				trackId: this.ref.trackId,
				elementId: this.ref.elementId,
				update: (current) =>
					current.type === "video" || current.type === "image"
						? { ...current, ...revertPatch }
						: current,
			});
			editor.timeline.updateTracks(patchedTracks);
		}

		// Remove the orphan asset row only if nothing else references it.
		if (this.addedAsset) {
			const postTracks = editor.scenes.getActiveScene().tracks;
			const stillReferenced = [postTracks.main, ...postTracks.overlay, ...postTracks.audio]
				.flatMap((t) => t.elements as Array<{ mediaId?: string }>)
				.some((el) => el.mediaId === this.asset.id);
			if (!stillReferenced) {
				const currentAssets = editor.media.getAssets();
				editor.media.setAssets({
					assets: currentAssets.filter((a) => a.id !== this.asset.id),
				});
				videoCache.clearVideo({ mediaId: this.asset.id });
				storageService
					.deleteMediaAsset({ projectId: this.projectId, id: this.asset.id })
					.catch((cleanupError) => {
						console.error("Failed to clean up replacement media after failed save:", cleanupError);
					});
			}
		}
		this.addedAsset = false;

		toast.error({
			message: "Couldn't save the replacement",
			description:
				storageService.isQuotaExceededError({ error }) && error instanceof Error
					? `${error.message} — the clip was left unchanged`
					: "The clip was left unchanged",
		});
	}

	/** Test-only: clear the shared pending-operation registry. */
	static resetPendingOperations(): void {
		ReplaceClipMediaCommand.activeOps.clear();
	}
}
