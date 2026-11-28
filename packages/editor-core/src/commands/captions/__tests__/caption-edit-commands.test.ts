/**
 * Transcript editing commands: splitting a cue must divide its WORDS (not just
 * its duration) and rebase the right half, merging must concatenate words at
 * the right offset, and both must restore the exact prior scene on undo.
 *
 * Drives the REAL EditorCore, same fixture pattern as the sibling command
 * tests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import type { CaptionElement, CaptionWord, SceneTracks } from "@/timeline";
import { SplitCaptionCommand } from "@/commands/captions/split-caption";
import { MergeCaptionsCommand, findNextCaption } from "@/commands/captions/merge-captions";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

const TERM = 30_000;

function words(texts: string[]): CaptionWord[] {
	return texts.map((text, index) => ({
		text,
		startTime: mediaTime({ ticks: index * TERM }),
		endTime: mediaTime({ ticks: (index + 1) * TERM }),
	}));
}

function caption({
	id,
	startTicks = 0,
	durationTicks = TERM * 4,
	texts = ["one", "two", "three", "four"],
}: {
	id: string;
	startTicks?: number;
	durationTicks?: number;
	texts?: string[];
}): CaptionElement {
	return {
		id,
		type: "caption",
		name: "cue",
		startTime: mediaTime({ ticks: startTicks }),
		duration: mediaTime({ ticks: durationTicks }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
		words: words(texts),
	};
}

function buildHarness(elements: CaptionElement[]) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = {
		...buildDefaultScene({ name: "Main", isMain: true }),
		id: "scene-caption-edits",
	};
	scene.tracks.overlay = [
		{ id: "cap-track", name: "Captions", type: "caption", hidden: false, elements },
	];
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	const track = () => {
		const found = editor.scenes
			.getActiveScene()
			.tracks.overlay.find((entry) => entry.id === "cap-track");
		if (!found || found.type !== "caption") throw new Error("missing caption track");
		return found;
	};
	return {
		editor,
		get tracks(): SceneTracks {
			return editor.scenes.getActiveScene().tracks;
		},
		captions(): CaptionElement[] {
			return [...track().elements].sort((a, b) => a.startTime - b.startTime);
		},
	};
}

afterEach(() => {
	EditorCore.reset();
});

describe("SplitCaptionCommand", () => {
	it("divides the words at the cut and rebases the right half", () => {
		const h = buildHarness([caption({ id: "c1" })]);
		const before = structuredClone(h.tracks);

		const cmd = new SplitCaptionCommand({
			trackId: "cap-track",
			elementId: "c1",
			splitTime: mediaTime({ ticks: TERM * 2 }),
		});
		cmd.execute();

		const [left, right] = h.captions();
		expect(left?.id).toBe("c1");
		expect(left?.startTime).toBe(mediaTime({ ticks: 0 }));
		expect(left?.duration).toBe(mediaTime({ ticks: TERM * 2 }));
		expect(left?.words.map((word) => word.text)).toEqual(["one", "two"]);
		expect(right?.startTime).toBe(mediaTime({ ticks: TERM * 2 }));
		expect(right?.duration).toBe(mediaTime({ ticks: TERM * 2 }));
		expect(right?.words.map((word) => word.text)).toEqual(["three", "four"]);
		// Right words are local to the new cue, so they start at zero again.
		expect(right?.words[0]?.startTime).toBe(mediaTime({ ticks: 0 }));
		expect(cmd.getRightElementId()).not.toBeNull();
		expect(right?.id).toBeTruthy();

		cmd.undo();
		expect(h.tracks).toEqual(before);
	});

	it("refuses a cut that would leave a half without a whole word", () => {
		const h = buildHarness([caption({ id: "c1" })]);
		const cmd = new SplitCaptionCommand({
			trackId: "cap-track",
			elementId: "c1",
			// Before the midpoint of the first word.
			splitTime: mediaTime({ ticks: 1_000 }),
		});
		cmd.execute();
		expect(h.captions()).toHaveLength(1);
		expect(cmd.getRightElementId()).toBeNull();
	});

	it("refuses a cut outside the cue", () => {
		const h = buildHarness([caption({ id: "c1" })]);
		new SplitCaptionCommand({
			trackId: "cap-track",
			elementId: "c1",
			splitTime: mediaTime({ ticks: TERM * 9 }),
		}).execute();
		expect(h.captions()).toHaveLength(1);
	});
});

describe("MergeCaptionsCommand", () => {
	it("concatenates words at the right offset and spans the gap", () => {
		const h = buildHarness([
			caption({ id: "c1", durationTicks: TERM * 2, texts: ["hello", "world"] }),
			caption({
				id: "c2",
				startTicks: TERM * 3,
				durationTicks: TERM * 2,
				texts: ["again", "now"],
			}),
		]);
		const before = structuredClone(h.tracks);

		const cmd = new MergeCaptionsCommand({
			trackId: "cap-track",
			leftElementId: "c1",
			rightElementId: "c2",
		});
		cmd.execute();

		const merged = h.captions();
		expect(merged).toHaveLength(1);
		expect(merged[0]?.id).toBe("c1");
		expect(merged[0]?.duration).toBe(mediaTime({ ticks: TERM * 5 }));
		expect(merged[0]?.words.map((word) => word.text)).toEqual([
			"hello",
			"world",
			"again",
			"now",
		]);
		// The right cue's first word lands where that cue started (3 terms in).
		expect(merged[0]?.words[2]?.startTime).toBe(mediaTime({ ticks: TERM * 3 }));

		cmd.undo();
		expect(h.tracks).toEqual(before);
	});

	it("restores both cues on undo", () => {
		const h = buildHarness([
			caption({ id: "c1", durationTicks: TERM * 2, texts: ["hello", "world"] }),
			caption({
				id: "c2",
				startTicks: TERM * 2,
				durationTicks: TERM * 2,
				texts: ["again", "now"],
			}),
		]);
		const before = structuredClone(h.tracks);
		const cmd = new MergeCaptionsCommand({
			trackId: "cap-track",
			leftElementId: "c1",
			rightElementId: "c2",
		});
		cmd.execute();
		expect(h.captions()).toHaveLength(1);
		cmd.undo();
		expect(h.tracks).toEqual(before);
	});

	it("refuses reversed order instead of silently reordering", () => {
		const h = buildHarness([
			caption({ id: "c1", durationTicks: TERM }),
			caption({ id: "c2", startTicks: TERM * 2, durationTicks: TERM }),
		]);
		new MergeCaptionsCommand({
			trackId: "cap-track",
			leftElementId: "c2",
			rightElementId: "c1",
		}).execute();
		expect(h.captions()).toHaveLength(2);
	});
});

describe("findNextCaption", () => {
	it("returns the next cue in timeline order, not array order", () => {
		const later = caption({ id: "later", startTicks: TERM * 10, durationTicks: TERM });
		const sooner = caption({ id: "sooner", startTicks: TERM * 2, durationTicks: TERM });
		expect(findNextCaption({ elements: [later, sooner], elementId: "sooner" })?.id).toBe(
			"later",
		);
		expect(findNextCaption({ elements: [later, sooner], elementId: "later" })).toBeNull();
		expect(findNextCaption({ elements: [sooner, later], elementId: "missing" })).toBeNull();
	});
});
