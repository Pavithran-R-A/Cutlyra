/**
 * Split one caption cue at a timeline time — the transcript editor's "split"
 * affordance. `SplitElementsCommand` cannot serve here: it keeps each half's
 * `words` array whole, so both halves would render every word of the original
 * cue. A caption's words carry their own times (relative to the element), so a
 * real split has to divide the words at the boundary and rebase the right
 * half, not just cut the duration.
 *
 * The split lands on the first word whose midpoint is at/after the requested
 * time, so both halves always keep at least one whole word. A time outside the
 * cue, or one that would leave a half wordless, is a no-op.
 */
import { Command, createElementSelectionResult, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { CaptionElement, CaptionWord, SceneTracks } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { mediaTime, type MediaTime } from "@/wasm";

export interface SplitCaptionParams {
	trackId: string;
	elementId: string;
	/** Absolute timeline time of the cut. */
	splitTime: MediaTime;
}

interface SplitWordsResult {
	leftWords: CaptionWord[];
	rightWords: CaptionWord[];
}

/** Divide a cue's words at `splitTicks` (element-local). `null` when the cut
 *  would strand a half without a whole word. */
export function splitCaptionWords({
	words,
	splitTicks,
}: {
	words: readonly CaptionWord[];
	splitTicks: number;
}): SplitWordsResult | null {
	const firstRight = words.findIndex((word) => {
		const midpoint = (word.startTime + word.endTime) / 2;
		return midpoint >= splitTicks;
	});
	if (firstRight <= 0 || firstRight >= words.length) return null;

	const leftWords = words.slice(0, firstRight).map((word) => ({
		...word,
		endTime: mediaTime({
			ticks: Math.min(word.endTime, splitTicks),
		}),
	}));
	const rightWords = words.slice(firstRight).map((word) => {
		const start = Math.max(0, word.startTime - splitTicks);
		const end = Math.max(start + 1, word.endTime - splitTicks);
		return {
			...word,
			startTime: mediaTime({ ticks: start }),
			endTime: mediaTime({ ticks: end }),
		};
	});
	return { leftWords, rightWords };
}

export class SplitCaptionCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly splitTime: MediaTime;
	private rightElementId: string | null = null;

	constructor({ trackId, elementId, splitTime }: SplitCaptionParams) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.splitTime = splitTime;
	}

	getRightElementId(): string | null {
		return this.rightElementId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		this.rightElementId = null;

		const track = this.savedState.overlay.find((entry) => entry.id === this.trackId);
		if (!track || track.type !== "caption") return undefined;
		const element = track.elements.find((entry) => entry.id === this.elementId);
		if (!element || element.type !== "caption") return undefined;

		const relativeTicks = this.splitTime - element.startTime;
		if (relativeTicks <= 0 || relativeTicks >= element.duration) return undefined;

		const split = splitCaptionWords({ words: element.words, splitTicks: relativeTicks });
		if (!split) return undefined;

		const rightId = generateUUID();
		const left: CaptionElement = {
			...element,
			duration: mediaTime({ ticks: relativeTicks }),
			words: split.leftWords,
		};
		const right: CaptionElement = {
			...element,
			id: rightId,
			startTime: this.splitTime,
			duration: mediaTime({ ticks: element.duration - relativeTicks }),
			words: split.rightWords,
			name: `${element.name} (cont.)`,
		};

		const updatedTracks: SceneTracks = {
			...this.savedState,
			overlay: this.savedState.overlay.map((entry) => {
				if (entry.id !== this.trackId || entry.type !== "caption") return entry;
				const elements = entry.elements.flatMap((candidate) =>
					candidate.id === this.elementId ? [left, right] : [candidate],
				);
				return { ...entry, elements };
			}),
		};

		editor.timeline.updateTracks(updatedTracks);
		this.rightElementId = rightId;
		return createElementSelectionResult([{ trackId: this.trackId, elementId: rightId }]);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
