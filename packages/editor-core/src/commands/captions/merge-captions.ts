/**
 * Merge two adjacent caption cues on the same track — the transcript editor's
 * "merge" counterpart to `SplitCaptionCommand`.
 *
 * The merged cue keeps the left element's identity, start time and style, spans
 * from the left cue's start to the right cue's end (including any gap between
 * them, which is what "merge" means for a transcript: one page covering both
 * lines of speech), and concatenates the word lists with the right cue's times
 * rebased into the merged cue's local timeline. Undo restores both elements.
 */
import { Command, createElementSelectionResult, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { CaptionElement, CaptionWord, SceneTracks } from "@/timeline";
import { mediaTime } from "@/wasm";

export interface MergeCaptionsParams {
	trackId: string;
	leftElementId: string;
	rightElementId: string;
}

/** Shift a cue's words into a merged cue's local timeline. */
export function rebaseCaptionWords({
	words,
	offsetTicks,
}: {
	words: readonly CaptionWord[];
	offsetTicks: number;
}): CaptionWord[] {
	return words.map((word) => ({
		...word,
		startTime: mediaTime({ ticks: word.startTime + offsetTicks }),
		endTime: mediaTime({ ticks: word.endTime + offsetTicks }),
	}));
}

export class MergeCaptionsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly leftElementId: string;
	private readonly rightElementId: string;

	constructor({ trackId, leftElementId, rightElementId }: MergeCaptionsParams) {
		super();
		this.trackId = trackId;
		this.leftElementId = leftElementId;
		this.rightElementId = rightElementId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const track = this.savedState.overlay.find((entry) => entry.id === this.trackId);
		if (!track || track.type !== "caption") return undefined;
		const leftIndex = track.elements.findIndex((entry) => entry.id === this.leftElementId);
		const rightIndex = track.elements.findIndex((entry) => entry.id === this.rightElementId);
		if (leftIndex === -1 || rightIndex === -1 || leftIndex === rightIndex) return undefined;

		const left = track.elements[leftIndex];
		const right = track.elements[rightIndex];
		if (!left || !right || left.type !== "caption" || right.type !== "caption") {
			return undefined;
		}
		// Only merge in timeline order; a "merge with next" caller passes the
		// earlier cue first. Reversed input is refused rather than silently
		// reordered, so the command cannot surprise its caller.
		if (right.startTime <= left.startTime) return undefined;

		const offsetTicks = right.startTime - left.startTime;
		const merged: CaptionElement = {
			...left,
			duration: mediaTime({ ticks: offsetTicks + right.duration }),
			words: [...left.words, ...rebaseCaptionWords({ words: right.words, offsetTicks })],
		};

		const updatedTracks: SceneTracks = {
			...this.savedState,
			overlay: this.savedState.overlay.map((entry) => {
				if (entry.id !== this.trackId || entry.type !== "caption") return entry;
				const elements = entry.elements.flatMap((candidate) => {
					if (candidate.id === this.leftElementId) return [merged];
					if (candidate.id === this.rightElementId) return [];
					return [candidate];
				});
				return { ...entry, elements };
			}),
		};

		editor.timeline.updateTracks(updatedTracks);
		return createElementSelectionResult([
			{ trackId: this.trackId, elementId: this.leftElementId },
		]);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}

/** The caption that follows `elementId` on its own track, in timeline order —
 *  what the transcript editor's "merge with next" needs. Pure, so the UI can
 *  disable the button without constructing a command. */
export function findNextCaption({
	elements,
	elementId,
}: {
	elements: readonly CaptionElement[];
	elementId: string;
}): CaptionElement | null {
	const ordered = [...elements]
		.filter((element): element is CaptionElement => element.type === "caption")
		.sort((a, b) => a.startTime - b.startTime);
	const index = ordered.findIndex((element) => element.id === elementId);
	if (index === -1) return null;
	return ordered[index + 1] ?? null;
}
