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
import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";

type AssetIntent = "present" | "absent";

interface AssetCoordinationState {
	generation: number;
	intent: AssetIntent;
	durableGeneration: number;
	/** Generation that last failed to persist (0 if none for current gen). */
	failedGeneration: number;
	/** Last persistence error for the current generation, if any. */
	lastError: unknown;
	queue: Promise<void>;
}

const assetCoordination = new Map<string, AssetCoordinationState>();

function assetKey({
	projectId,
	assetId,
}: {
	projectId: string;
	assetId: string;
}): string {
	return `${projectId}:${assetId}`;
}

function getAssetState(key: string): AssetCoordinationState {
	let state = assetCoordination.get(key);
	if (!state) {
		state = {
			generation: 0,
			intent: "absent",
			durableGeneration: 0,
			failedGeneration: 0,
			lastError: null,
			queue: Promise.resolve(),
		};
		assetCoordination.set(key, state);
	}
	return state;
}

function enqueueAssetOperation({
	key,
	operation,
}: {
	key: string;
	operation: () => Promise<void>;
}): void {
	const state = getAssetState(key);
	const run = state.queue.then(operation, operation).catch((error) => {
		console.error("Replace Clip asset operation failed:", error);
	});
	state.queue = run.then(
		() => undefined,
		() => undefined,
	);
}

function hasMediaReference({
	tracks,
	assetId,
}: {
	tracks: SceneTracks;
	assetId: string;
}): boolean {
	return [tracks.main, ...tracks.overlay, ...tracks.audio]
		.flatMap((track) => track.elements as TimelineElement[])
		.some(
			(element) =>
				(element.type === "video" || element.type === "image") &&
				element.mediaId === assetId,
		);
}

function removeAssetFromEditor({
	editor,
	assetId,
}: {
	editor: EditorCore;
	assetId: string;
}): void {
	const assets = editor.media.getAssets();
	if (!assets.some((asset) => asset.id === assetId)) return;
	editor.media.setAssets({
		assets: assets.filter((asset) => asset.id !== assetId),
	});
	videoCache.clearVideo({ mediaId: assetId });
}

function isMediaElement(
	element: TimelineElement | null | undefined,
): element is Extract<TimelineElement, { type: "video" | "image" }> {
	return element?.type === "video" || element?.type === "image";
}

/**
 * Nondestructive Replace Clip (#74): point an existing timeline clip at a
 * different already-imported media asset, keeping every authored property.
 *
 * Persistence is asynchronous and must not clobber newer work. Every execution
 * gets a unique per-clip operation id, and every asset save/delete intent gets a
 * per-asset generation token. Stale callbacks may observe completion, but they
 * must not revert newer clip edits, resurrect unwanted rows, or delete an asset
 * that a newer operation still requires.
 */
export class ReplaceClipMediaCommand extends Command {
	private readonly projectId: string;
	private readonly ref: ElementRef;
	private readonly asset: MediaAsset;
	private readonly allowClamp: boolean;

	private savedTracks: SceneTracks | null = null;
	private appliedPlan: ReplaceMediaPlanOk | null = null;
	private previousElement: Extract<TimelineElement, { type: "video" | "image" }> | null = null;
	/** True when this command added the replacement asset to the library. */
	private addedAsset = false;
	private previousName: string | null = null;

	/** Unique id for the CURRENT execution. Null between executions. */
	private operationId: string | null = null;
	/** Operation ids this instance has invalidated (undo / supersession). */
	private readonly invalidatedOps = new Set<string>();
	/** Per-asset generation claimed by the current execution's persistence intent. */
	private assetGeneration: number | null = null;

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

	private invalidateCurrentOperation(): void {
		if (!this.operationId) return;
		this.invalidatedOps.add(this.operationId);
		if (ReplaceClipMediaCommand.activeOps.get(this.clipKey()) === this.operationId) {
			ReplaceClipMediaCommand.activeOps.delete(this.clipKey());
		}
	}

	private requestAssetPresent(): number {
		const key = assetKey({ projectId: this.projectId, assetId: this.asset.id });
		const state = getAssetState(key);
		state.generation += 1;
		state.intent = "present";
		this.assetGeneration = state.generation;
		return state.generation;
	}

	private requestAssetAbsent(): number {
		const key = assetKey({ projectId: this.projectId, assetId: this.asset.id });
		const state = getAssetState(key);
		state.generation += 1;
		state.intent = "absent";
		this.assetGeneration = state.generation;
		return state.generation;
	}

	private enqueueSave({
		generation,
		opId,
	}: {
		generation: number;
		opId: string;
	}): void {
		const key = assetKey({ projectId: this.projectId, assetId: this.asset.id });
		enqueueAssetOperation({
			key,
			operation: async () => {
				const state = getAssetState(key);
				if (state.generation !== generation || state.intent !== "present") {
					return;
				}
				try {
					await storageService.saveMediaAsset({
						projectId: this.projectId,
						mediaAsset: this.asset,
					});
					const current = getAssetState(key);
					if (current.generation === generation && current.intent === "present") {
						current.durableGeneration = generation;
						current.failedGeneration = 0;
						current.lastError = null;
					}
				} catch (error) {
					const current = getAssetState(key);
					if (current.generation === generation && current.intent === "present") {
						current.failedGeneration = generation;
						current.lastError = error;
						// Persistence failed for the current intent. Compensate the clip
						// only if this clip operation is still active; asset cleanup is
						// coordinated separately and reference-aware.
						this.compensateFailedSave({ opId, error, generation });
					}
					throw error;
				}
			},
		});
	}

	private enqueueDeleteIfAbsent({
		generation,
	}: {
		generation: number;
	}): void {
		const key = assetKey({ projectId: this.projectId, assetId: this.asset.id });
		enqueueAssetOperation({
			key,
			operation: async () => {
				const state = getAssetState(key);
				if (state.generation !== generation || state.intent !== "absent") {
					return;
				}
				try {
					await storageService.deleteMediaAsset({
						projectId: this.projectId,
						id: this.asset.id,
					});
					const current = getAssetState(key);
					if (current.generation === generation && current.intent === "absent") {
						current.durableGeneration = 0;
						current.failedGeneration = 0;
						current.lastError = null;
					}
				} catch (error) {
					const current = getAssetState(key);
					if (current.generation === generation && current.intent === "absent") {
						current.failedGeneration = generation;
						current.lastError = error;
					}
					throw error;
				}
			},
		});
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();

		this.invalidateCurrentOperation();
		const opId = generateUUID();
		this.operationId = opId;
		ReplaceClipMediaCommand.activeOps.set(this.clipKey(), opId);

		this.savedTracks = editor.scenes.getActiveScene().tracks;
		this.addedAsset = false;
		this.appliedPlan = null;
		this.previousName = null;
		this.previousElement = null;
		this.assetGeneration = null;

		const track = findTrackInSceneTracks({
			tracks: this.savedTracks,
			trackId: this.ref.trackId,
		});
		const element = track?.elements.find(
			(candidate) => candidate.id === this.ref.elementId,
		);
		if (!isMediaElement(element)) return undefined;

		const plan = planClipMediaReplacement({
			element,
			asset: this.asset,
			allowClamp: this.allowClamp,
		});
		if (!plan.ok) {
			throw new Error(`Replace clip refused: ${plan.message}`);
		}

		this.appliedPlan = plan;
		this.previousName = element.name;
		this.previousElement = { ...element };

		const currentAssets = editor.media.getAssets();
		const alreadyRegistered = currentAssets.some(
			(candidate) => candidate.id === this.asset.id,
		);
		if (!alreadyRegistered) {
			editor.media.setAssets({
				assets: [...currentAssets, this.asset],
			});
			this.addedAsset = true;
		} else {
			this.addedAsset = false;
		}

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedTracks,
			trackId: this.ref.trackId,
			elementId: this.ref.elementId,
			update: (current) =>
				isMediaElement(current) ? { ...current, ...plan.patch } : current,
		});
		editor.timeline.updateTracks(updatedTracks);

		if (this.addedAsset) {
			const generation = this.requestAssetPresent();
			this.enqueueSave({ generation, opId });
		}

		return undefined;
	}

	undo(): void {
		const editor = EditorCore.getInstance();
		this.invalidateCurrentOperation();

		// Narrow undo: revert this clip to its pre-execution element state when
		// the clip still exists. This avoids clobbering unrelated edits made to
		// other clips/tracks that may have been interleaved with async effects.
		if (this.previousElement) {
			const currentTracks = editor.scenes.getActiveScene().tracks;
			const track = findTrackInSceneTracks({
				tracks: currentTracks,
				trackId: this.ref.trackId,
			});
			const exists = track?.elements.some(
				(element) => element.id === this.ref.elementId,
			);
			if (exists) {
				const restored = this.previousElement;
				const revertedTracks = updateElementInSceneTracks({
					tracks: currentTracks,
					trackId: this.ref.trackId,
					elementId: this.ref.elementId,
					update: (current) => (isMediaElement(current) ? restored : current),
				});
				editor.timeline.updateTracks(revertedTracks);
			}
		} else if (this.savedTracks) {
			// Fallback for unexpected state.
			editor.timeline.updateTracks(this.savedTracks);
		}

		if (this.addedAsset) {
			const generation = this.requestAssetAbsent();
			removeAssetFromEditor({ editor, assetId: this.asset.id });
			this.enqueueDeleteIfAbsent({ generation });
			this.addedAsset = false;
		}
	}

	redo(): CommandResult | undefined {
		return this.execute();
	}

	getAppliedPlan(): ReplaceMediaPlanOk | null {
		return this.appliedPlan;
	}

	getPreviousName(): string | null {
		return this.previousName;
	}

	private compensateFailedSave({
		opId,
		error,
		generation,
	}: {
		opId: string;
		error: unknown;
		generation: number;
	}): void {
		if (!this.isActive(opId)) return;

		const editor = EditorCore.getInstance();
		const currentTracks = editor.scenes.getActiveScene().tracks;

		const currentTrack = findTrackInSceneTracks({
			tracks: currentTracks,
			trackId: this.ref.trackId,
		});
		const currentElement = currentTrack?.elements.find(
			(candidate) => candidate.id === this.ref.elementId,
		);
		const previous = this.previousElement;

		if (
			isMediaElement(currentElement) &&
			isMediaElement(previous) &&
			currentElement.mediaId === this.asset.id
		) {
			const revertPatch: Record<string, unknown> = {
				mediaId: previous.mediaId,
				name: previous.name,
			};
			if (this.appliedPlan?.clamped) {
				revertPatch.trimStart = previous.trimStart;
				revertPatch.duration = previous.duration;
				revertPatch.trimEnd = previous.trimEnd;
			}
			if (previous.type === "video" && currentElement.type === "video") {
				revertPatch.sourceDuration = previous.sourceDuration;
			}
			const patchedTracks = updateElementInSceneTracks({
				tracks: currentTracks,
				trackId: this.ref.trackId,
				elementId: this.ref.elementId,
				update: (current) =>
					isMediaElement(current) ? { ...current, ...revertPatch } : current,
			});
			editor.timeline.updateTracks(patchedTracks);
		}

		// Mark unwanted and remove only if this failed generation is still the
		// current intent and no element references the asset.
		const key = assetKey({ projectId: this.projectId, assetId: this.asset.id });
		const state = getAssetState(key);
		if (state.generation === generation && state.intent === "present") {
			state.generation += 1;
			state.intent = "absent";
			const deleteGeneration = state.generation;
			const postTracks = editor.scenes.getActiveScene().tracks;
			if (!hasMediaReference({ tracks: postTracks, assetId: this.asset.id })) {
				removeAssetFromEditor({ editor, assetId: this.asset.id });
				this.enqueueDeleteIfAbsent({ generation: deleteGeneration });
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

	/** Asset keys (projectId:assetId) currently coordinated for a project. */
	static pendingAssetKeys({ projectId }: { projectId: string }): string[] {
		const prefix = `${projectId}:`;
		return Array.from(assetCoordination.keys()).filter((key) =>
			key.startsWith(prefix),
		);
	}

	/** True when any media transaction for the project is still pending. */
	static hasPendingMediaTransactions({ projectId }: { projectId: string }): boolean {
		return this.pendingAssetKeys({ projectId }).some((key) => {
			const state = assetCoordination.get(key);
			if (!state) return false;
			if (state.intent === "present") {
				return state.durableGeneration !== state.generation;
			}
			// absent intent: durable when durableGeneration === 0 after the gen
			return state.failedGeneration === state.generation;
		});
	}

	/** Failed media transactions for a project (assetId + error). */
	static getFailedMediaTransactions({
		projectId,
	}: {
		projectId: string;
	}): { assetId: string; error: unknown }[] {
		const prefix = `${projectId}:`;
		const result: { assetId: string; error: unknown }[] = [];
		for (const [key, state] of assetCoordination) {
			if (!key.startsWith(prefix)) continue;
			if (state.failedGeneration === state.generation && state.generation > 0) {
				result.push({
					assetId: key.slice(prefix.length),
					error: state.lastError,
				});
			}
		}
		return result;
	}

	/** Await all queued asset persistence operations for a project (or all). */
	static async waitForPendingMediaTransactions({
		projectId,
	}: {
		projectId?: string;
	} = {}): Promise<void> {
		const keys =
			projectId === undefined
				? Array.from(assetCoordination.keys())
				: this.pendingAssetKeys({ projectId });
		const queues = keys.map((key) => assetCoordination.get(key)?.queue ?? Promise.resolve());
		await Promise.allSettled(queues);
		// Drain any follow-up work enqueued by compensation.
		const queuesAfter =
			projectId === undefined
				? Array.from(assetCoordination.values(), (s) => s.queue)
				: this.pendingAssetKeys({ projectId }).map(
						(key) => assetCoordination.get(key)?.queue ?? Promise.resolve(),
				  );
		await Promise.allSettled(queuesAfter);
	}

	/** Test-only: await all queued asset persistence operations. */
	static async flushPendingOperations(): Promise<void> {
		const queues = Array.from(assetCoordination.values(), (state) => state.queue);
		await Promise.allSettled(queues);
		// A flush may have enqueued follow-up work in rare cases; drain once more.
		const queuesAfter = Array.from(assetCoordination.values(), (state) => state.queue);
		await Promise.allSettled(queuesAfter);
	}

	/** Test-only: clear shared pending-operation registries. */
	static resetPendingOperations(): void {
		ReplaceClipMediaCommand.activeOps.clear();
		assetCoordination.clear();
	}
}
