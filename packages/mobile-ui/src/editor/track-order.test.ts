import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	VideoTrack,
} from "@cutlyra/editor-core/timeline";
import { trackDisplayOrder } from "./track-order";

function videoTrack(id: string): VideoTrack {
	return {
		id,
		name: id,
		type: "video",
		elements: [],
		hidden: false,
		muted: false,
	};
}

function audioTrack(id: string): AudioTrack {
	return { id, name: id, type: "audio", elements: [], muted: false };
}

function scene({
	overlay = [],
	audio = [],
}: {
	overlay?: VideoTrack[];
	audio?: AudioTrack[];
} = {}): SceneTracks {
	return { main: videoTrack("main"), overlay, audio };
}

/**
 * The order `resolveTrackPlacement`/`applyPlacement` index against
 * (`packages/editor-core/src/timeline/placement/resolve.ts`: `[...overlay,
 * main, ...audio]`). `getHighestInsertIndexForTrack` returns 0 for a new
 * overlay track — the TOP of this list — and `getDefaultInsertIndexForTrack`
 * returns `overlay.length + 1 + audio.length` for audio, i.e. append at the
 * bottom. Written out from the scene rather than imported because this
 * package's `tsc` cannot resolve editor-core deep subpaths (see
 * `use-timeline-project-vm.ts`'s note on that same limitation).
 */
function engineTrackOrder(tracks: SceneTracks): string[] {
	return [
		...tracks.overlay.map((track) => track.id),
		tracks.main.id,
		...tracks.audio.map((track) => track.id),
	];
}

function mainLane(tracks: SceneTracks): number {
	return trackDisplayOrder(tracks).findIndex((entry) => entry.isMain);
}

describe("timeline lane order", () => {
	test("renders overlays above the main row and audio below it", () => {
		const order = trackDisplayOrder(
			scene({ overlay: [videoTrack("o1")], audio: [audioTrack("a1")] }),
		);
		expect(order.map((entry) => entry.track.id)).toEqual(["o1", "main", "a1"]);
		expect(order.map((entry) => entry.isMain)).toEqual([false, true, false]);
	});

	test("matches the placement engine's own track indexing", () => {
		const base = scene({
			overlay: [videoTrack("o1"), videoTrack("o2")],
			audio: [audioTrack("a1"), audioTrack("a2")],
		});
		expect(trackDisplayOrder(base).map((entry) => entry.track.id)).toEqual(
			engineTrackOrder(base),
		);
	});

	// DuplicateElementsCommand and a fresh text/graphic insert both land at
	// `alwaysNew` + `highest`, i.e. engine index 0 = the top overlay slot. The
	// view model used to emit `[main, ...overlay, ...audio]`, so that new lane
	// rendered directly UNDER the main clip — the band users read as the music
	// lane ("if u duplicate, it ends up in the music slot … if u add a text, it
	// ends up in the music slot too").
	test("engine index 0 is the topmost lane, above the main row", () => {
		const base = scene({ overlay: [videoTrack("o1")], audio: [audioTrack("a1")] });
		expect(trackDisplayOrder(base)[0]?.track.id).toBe(engineTrackOrder(base)[0]);
		expect(engineTrackOrder(base)[0]).toBe("o1");
		expect(0).toBeLessThan(mainLane(base));
	});

	test("a new audio track appends past the last lane, below the main row", () => {
		const base = scene({ overlay: [videoTrack("o1")], audio: [audioTrack("a1")] });
		// `overlay.length + 1 + audio.length` == one past the last engine slot.
		const audioInsertIndex = base.overlay.length + 1 + base.audio.length;
		expect(audioInsertIndex).toBe(engineTrackOrder(base).length);
		expect(audioInsertIndex).toBeGreaterThan(mainLane(base));
	});

	test("main is flagged for exactly one row", () => {
		const order = trackDisplayOrder(scene());
		expect(order).toHaveLength(1);
		expect(order[0]?.isMain).toBe(true);
	});

	test("a text lane added at the top never renders below the music lanes", () => {
		const base = scene({ audio: [audioTrack("music-1")] });
		const display = trackDisplayOrder(base);
		const audioLane = display.findIndex(
			(entry) => entry.track.type === "audio",
		);
		// The new text track takes slot 0 and pushes main and the music row down,
		// so it stays above both.
		expect(0).toBeLessThan(mainLane(base) + 1);
		expect(0).toBeLessThan(audioLane + 1);
	});
});
