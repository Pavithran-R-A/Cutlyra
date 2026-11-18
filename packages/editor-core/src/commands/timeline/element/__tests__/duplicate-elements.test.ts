/**
 * Complaint D from the closed-test feedback: "unintended or accidental
 * duplication". The device evidence (qa3-evidence-poco-20261118, row 1) shows one
 * deliberate Duplicate produced exactly one copy, so the remaining risk is
 * mechanical: one command producing more than one element, a copy overwriting or
 * mutating its source, or an undo that takes the original with it.
 *
 * Drives the REAL DuplicateElementsCommand against the REAL EditorCore, same
 * fixture pattern as the sibling command tests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import type { SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import { DuplicateElementsCommand } from "@/commands/timeline/element/duplicate-elements";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

function videoElement({ id, name }: { id: string; name: string }): VideoElement {
	return {
		id,
		type: "video",
		name,
		mediaId: "m1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			framing: "fit",
		},
		animations: undefined,
	};
}

const canvas = { width: 1080, height: 1920 };

function buildHarness(elements: VideoElement[]) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = {
		...buildDefaultScene({ name: "Main", isMain: true }),
		id: "scene-duplicate",
	};
	scene.tracks.main.elements = elements;
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	return {
		editor,
		get tracks(): SceneTracks {
			return editor.scenes.getActiveScene().tracks;
		},
		mainTrackId: scene.tracks.main.id,
		canvas,
	};
}

/** Every element id in the scene, so uniqueness can be asserted globally. */
function allIds(tracks: SceneTracks): string[] {
	const out: string[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements) {
			out.push(element.id);
		}
	}
	return out;
}

function overlayElements(tracks: SceneTracks): TimelineElement[] {
	const out: TimelineElement[] = [];
	for (const track of tracks.overlay) {
		out.push(...track.elements);
	}
	return out;
}

afterEach(() => {
	EditorCore.reset();
});

describe("one Duplicate action adds exactly one copy", () => {
	it("adds one element and leaves the source byte-identical", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const sourceBefore = structuredClone(h.tracks.main.elements[0]);

		const cmd = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v1" }],
		});
		cmd.execute();

		expect(h.tracks.main.elements).toHaveLength(1);
		expect(h.tracks.main.elements[0]).toEqual(sourceBefore);
		expect(overlayElements(h.tracks)).toHaveLength(1);

		const copy = overlayElements(h.tracks)[0];
		expect(copy?.id).not.toBe("v1");
		expect(copy?.name).toBe("clip (copy)");
		expect(copy?.startTime).toBe(sourceBefore?.startTime);
		// The copy is a source-compatible clip, not a new media reference.
		expect(copy && "mediaId" in copy ? copy.mediaId : null).toBe("m1");
		expect(cmd.getDuplicatedElements()).toHaveLength(1);
	});

	it("keeps every element id unique across the scene", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v1" }],
		}).execute();
		const ids = allIds(h.tracks);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("duplicates only what was selected", () => {
		const h = buildHarness([
			videoElement({ id: "v1", name: "first" }),
			{
				...videoElement({ id: "v2", name: "second" }),
				startTime: mediaTime({ ticks: 120_000 }),
			},
		]);
		const cmd = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v2" }],
		});
		cmd.execute();

		expect(overlayElements(h.tracks)).toHaveLength(1);
		expect(overlayElements(h.tracks)[0]?.name).toBe("second (copy)");
		// The unselected clip was neither copied nor altered.
		expect(h.tracks.main.elements.map((element) => element.id)).toEqual(["v1", "v2"]);
	});

	it("gives a multi-selection one copy per element, not one per command", () => {
		const h = buildHarness([
			videoElement({ id: "v1", name: "first" }),
			{
				...videoElement({ id: "v2", name: "second" }),
				startTime: mediaTime({ ticks: 120_000 }),
			},
		]);
		const cmd = new DuplicateElementsCommand({
			elements: [
				{ trackId: h.mainTrackId, elementId: "v1" },
				{ trackId: h.mainTrackId, elementId: "v2" },
			],
		});
		cmd.execute();

		expect(overlayElements(h.tracks)).toHaveLength(2);
		expect(cmd.getDuplicatedElements()).toHaveLength(2);
		expect(h.tracks.main.elements).toHaveLength(2);
	});
});

describe("repeated and undone duplication stays additive", () => {
	it("two executions add two copies, never more per execution", () => {
		// Guards the mechanical half of "it duplicated on its own": a single
		// command can only ever add one copy per selected element, so a stray
		// second copy requires a second command — not one command misfiring.
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);

		const first = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v1" }],
		});
		first.execute();
		expect(overlayElements(h.tracks)).toHaveLength(1);

		const second = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v1" }],
		});
		second.execute();
		expect(overlayElements(h.tracks)).toHaveLength(2);

		const names = overlayElements(h.tracks).map((element) => element.name);
		expect(names).toEqual(["clip (copy)", "clip (copy)"]);
		const ids = allIds(h.tracks);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("undo removes exactly the copy and keeps the source", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const cmd = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v1" }],
		});
		cmd.execute();
		expect(overlayElements(h.tracks)).toHaveLength(1);

		cmd.undo();
		expect(overlayElements(h.tracks)).toHaveLength(0);
		expect(h.tracks.main.elements.map((element) => element.id)).toEqual(["v1"]);
	});

	it("undoing the second copy leaves the first one in place", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const first = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v1" }],
		});
		first.execute();
		const second = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v1" }],
		});
		second.execute();
		expect(overlayElements(h.tracks)).toHaveLength(2);

		second.undo();
		// One copy is left: undo is granular, not "remove every duplicate".
		expect(overlayElements(h.tracks)).toHaveLength(1);
	});

	it("redoing after undo restores exactly one copy with a usable id", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const cmd = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "v1" }],
		});
		cmd.execute();
		const copyId = overlayElements(h.tracks)[0]?.id;
		cmd.undo();
		expect(overlayElements(h.tracks)).toHaveLength(0);

		cmd.redo();
		expect(overlayElements(h.tracks)).toHaveLength(1);
		expect(overlayElements(h.tracks)[0]?.id).not.toBe("v1");
		expect(typeof copyId).toBe("string");
	});

	it("duplicating a missing element is a no-op, not an empty overlay track", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const cmd = new DuplicateElementsCommand({
			elements: [{ trackId: h.mainTrackId, elementId: "does-not-exist" }],
		});
		expect(cmd.execute()).toBeUndefined();
		expect(overlayElements(h.tracks)).toHaveLength(0);
		expect(cmd.getDuplicatedElements()).toHaveLength(0);
	});
});
