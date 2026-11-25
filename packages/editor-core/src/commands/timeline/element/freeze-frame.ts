import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type {
	SceneTracks,
	TimelineElement,
	VideoElement,
	ImageElement,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { isRetimableElement } from "@/timeline";
import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
} from "@/wasm";
import { mediaTime } from "@/wasm";

export interface FreezeFrameParams {
	trackId: string;
	elementId: string;
	splitTime: MediaTime;
	holdDuration: MediaTime;
	/** Media asset id of the captured frozen frame (image). */
	frozenMediaId: string;
}

/**
 * Non-destructive Freeze Frame command.
 *
 * Splits the source video element at `splitTime`, inserts a duration-adjustable
 * still (image) interval between the two halves, and preserves preceding and
 * following video: on the MAIN track (magnetic) every later clip ripples by the
 * hold duration, so inserting the freeze can never overlap or gap the rest of
 * the edit. Overlay tracks are free-position and are not rippled.
 *
 * Audio policy (explicit, and the same one the UI states):
 *  - the LEFT half keeps its source audio up to the split;
 *  - the frozen interval, being a still image, carries NO audio;
 *  - the RIGHT half keeps its source audio from its new trim start.
 * Nothing is muted, duplicated, or re-encoded differently; only the timeline
 * interval changes. The source media is never deleted — both halves still
 * reference the original asset.
 *
 * Undo restores the saved scene tracks (including the ripple), so a freeze is
 * one undo step and its redo replays the same deterministic edit.
 */
export class FreezeFrameCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly splitTime: MediaTime;
	private readonly holdDuration: MediaTime;
	private readonly frozenMediaId: string;
	private frozenElementId: string = "";

	constructor(params: FreezeFrameParams) {
		super();
		this.trackId = params.trackId;
		this.elementId = params.elementId;
		this.splitTime = params.splitTime;
		this.holdDuration = params.holdDuration;
		this.frozenMediaId = params.frozenMediaId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const track = this.savedState.main.id === this.trackId
			? this.savedState.main
			: this.savedState.overlay.find((t) => t.id === this.trackId);
		if (!track) return;

		const element = track.elements.find((e) => e.id === this.elementId);
		if (!element || element.type !== "video") return;

		const video = element as VideoElement;
		const effectiveStart = video.startTime;
		const effectiveEnd = video.startTime + video.duration;

		if (this.splitTime <= effectiveStart || this.splitTime >= effectiveEnd) {
			return;
		}

		const relativeTime = subMediaTime({ a: this.splitTime, b: video.startTime });
		const leftVisibleDuration = relativeTime;
		const rightVisibleDuration = subMediaTime({ a: video.duration, b: relativeTime });

		const retimeRef = isRetimableElement(video) ? video.retime : undefined;
		const leftSourceSpan = roundMediaTime({
			time: getSourceSpanAtClipTime({ clipTime: leftVisibleDuration, retime: retimeRef }),
		});
		const totalSourceSpan = roundMediaTime({
			time: getSourceSpanAtClipTime({ clipTime: video.duration, retime: retimeRef }),
		});
		const rightSourceSpan = subMediaTime({ a: totalSourceSpan, b: leftSourceSpan });

		const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
			animations: video.animations,
			splitTime: relativeTime,
			shouldIncludeSplitBoundary: true,
		});

		const leftTrimEnd = addMediaTime({ a: video.trimEnd, b: rightSourceSpan });
		const rightTrimStart = addMediaTime({ a: video.trimStart, b: leftSourceSpan });

		const frozenId = generateUUID();
		this.frozenElementId = frozenId;

		const frozenImage: ImageElement = {
			id: frozenId,
			type: "image",
			name: `${video.name} (freeze)`,
			mediaId: this.frozenMediaId,
			startTime: this.splitTime,
			duration: this.holdDuration,
			trimStart: 0 as MediaTime,
			trimEnd: 0 as MediaTime,
			params: {
				"transform.positionX": 0,
				"transform.positionY": 0,
				"transform.scaleX": 1,
				"transform.scaleY": 1,
				framing: "fit",
			},
			animations: undefined,
		};

		const leftElement: VideoElement = {
			...video,
			duration: leftVisibleDuration,
			trimEnd: leftTrimEnd,
			name: `${video.name} (left)`,
			animations: leftAnimations,
			...(retimeRef !== undefined ? { retime: retimeRef } : {}),
		};

		const rightElementId = generateUUID();
		const rightElement: VideoElement = {
			...video,
			id: rightElementId,
			startTime: addMediaTime({ a: this.splitTime, b: this.holdDuration }),
			duration: rightVisibleDuration,
			trimStart: rightTrimStart,
			name: `${video.name} (right)`,
			animations: rightAnimations,
			...(retimeRef !== undefined ? { retime: retimeRef } : {}),
		};

		// Main-track ripple: the insert makes the edit `holdDuration` longer, so
		// every clip that started at/after the split moves right by exactly that
		// amount. Without this the inserted still overlapped its neighbours.
		const ripples = this.savedState.main.id === this.trackId;
		const newElements = track.elements.flatMap((el) => {
			if (el.id === this.elementId) {
				return [leftElement, frozenImage, rightElement];
			}
			if (ripples && el.startTime >= this.splitTime) {
				return [
					{
						...el,
						startTime: addMediaTime({
							a: el.startTime,
							b: this.holdDuration,
						}),
					} as TimelineElement,
				];
			}
			return [el];
		});

		const newTrack = { ...track, elements: newElements } as typeof track;
		const newTracks: SceneTracks =
			this.savedState.main.id === this.trackId
				? ({ ...this.savedState, main: newTrack } as SceneTracks)
				: ({
						...this.savedState,
						overlay: this.savedState.overlay.map((t) =>
							t.id === this.trackId ? newTrack : t,
						),
				  } as SceneTracks);

		editor.timeline.updateTracks(newTracks);
		return createElementSelectionResult([
			{ trackId: this.trackId, elementId: frozenId },
		]);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}

	getFrozenElementId(): string {
		return this.frozenElementId;
	}
}