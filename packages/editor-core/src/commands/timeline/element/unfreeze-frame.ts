import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, VideoElement, ImageElement } from "@/timeline";
import { addMediaTime, subMediaTime } from "@/wasm";

export interface UnfreezeFrameParams {
	trackId: string;
	frozenElementId: string;
}

/**
 * Reverses a Freeze Frame: removes the still interval and rejoins the
 * preceding/following video halves back into a single video element,
 * restoring the original trim/duration.
 *
 * Main-track clips that were pushed right by the hold ripple back by exactly
 * the removed still's duration, so the timeline returns to the length it had
 * before the freeze (one undo step either way). The generated still asset is
 * removed separately by the caller (it is not this command's job to touch the
 * media library); the SOURCE video is never touched.
 */
export class UnfreezeFrameCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly frozenElementId: string;

	constructor(params: UnfreezeFrameParams) {
		super();
		this.trackId = params.trackId;
		this.frozenElementId = params.frozenElementId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const track =
			this.savedState.main.id === this.trackId
				? this.savedState.main
				: this.savedState.overlay.find((t) => t.id === this.trackId);
		if (!track) return;

		const idx = track.elements.findIndex((e) => e.id === this.frozenElementId);
		if (idx < 0) return;
		const frozen = track.elements[idx];
		if (frozen.type !== "image") return;

		const left = idx > 0 ? track.elements[idx - 1] : undefined;
		const right = idx < track.elements.length - 1 ? track.elements[idx + 1] : undefined;
		// A main-track freeze pushed everything after the still to the right by
		// the still's duration; removing it pulls them back by the same amount.
		const ripples = this.savedState.main.id === this.trackId;
		const hold = frozen.duration;
		const rippleBack = <T extends TimelineElement>(elements: T[]): T[] => {
			if (!ripples) return elements;
			const restStart = addMediaTime({ a: frozen.startTime, b: hold });
			return elements.map((el) =>
				el.startTime < restStart
					? el
					: ({
							...el,
							startTime: subMediaTime({ a: el.startTime, b: hold }),
						} as T),
			);
		};

		if (!left || left.type !== "video" || !right || right.type !== "video") {
			// Fall back: just remove the frozen element (and undo its ripple).
			const newElements = rippleBack(
				track.elements.filter((e) => e.id !== this.frozenElementId),
			);
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
			return;
		}

		const leftV = left as VideoElement;
		const rightV = right as VideoElement;

		// Merge: trimStart from left, trimEnd from right, duration = sum.
		const merged: VideoElement = {
			...leftV,
			duration: addMediaTime({ a: leftV.duration, b: rightV.duration }),
			trimEnd: rightV.trimEnd,
			name: leftV.name.replace(/ \(left\)$/, ""),
		};

		const newElements = rippleBack(
			track.elements.filter(
				(e) => e.id !== this.frozenElementId && e.id !== rightV.id,
			),
		);
		const mergedIdx = newElements.findIndex((e) => e.id === leftV.id);
		if (mergedIdx >= 0) newElements[mergedIdx] = merged;

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
		return createElementSelectionResult([{ trackId: this.trackId, elementId: leftV.id }]);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}