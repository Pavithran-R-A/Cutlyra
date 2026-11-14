import { describe, expect, test } from "bun:test";
import type { TimelineElement } from "@cutlyra/editor-core/timeline";
import { TICKS_PER_SECOND, mediaTime } from "@cutlyra/editor-core/wasm";
import { resolveClipValuesAtTime } from "../../editor/keyframes";
import { buildSessionPatches, type GestureTarget } from "./preview-gesture-payload";
import type { GestureTransform } from "./preview-gesture";

/**
 * The engine sink this module feeds (`timeline.previewElements`) records each
 * frame verbatim and `commitPreview` promotes the last preview unchanged
 * (`timeline-manager.ts` commitPreview), so asserting the payload here is
 * asserting what gets committed.
 *
 * These run against the real keyframe primitives; the structural fixture
 * follows the one in `editor/keyframes.test.ts`.
 */

const LOCAL_TIME = mediaTime({ ticks: 3 * TICKS_PER_SECOND });

function textElement({ animations }: { animations?: unknown } = {}): TimelineElement {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- structural fixture: only the fields the keyframe model reads.
	return {
		id: "text-1",
		type: "text",
		name: "Title",
		startTime: mediaTime({ ticks: 2 * TICKS_PER_SECOND }),
		duration: mediaTime({ ticks: 4 * TICKS_PER_SECOND }),
		trimStart: 0,
		trimEnd: 0,
		params: {
			"transform.positionX": 10,
			"transform.positionY": 20,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 30,
			opacity: 0.8,
		},
		animations,
	} as unknown as TimelineElement;
}

const DRAGGED: GestureTransform = {
	positionX: 111,
	positionY: 222,
	scaleX: 1.5,
	scaleY: 1.5,
	snapped: { x: false, y: false },
};

function target(overrides: Partial<GestureTarget> = {}): GestureTarget {
	const element = textElement();
	return {
		trackId: "track-1",
		elementId: "text-1",
		element,
		keyed: false,
		localTime: LOCAL_TIME,
		baseValues: resolveClipValuesAtTime({ element, localTime: LOCAL_TIME }),
		...overrides,
	};
}

describe("preview payloads", () => {
	test("an un-keyed element receives the transform as parameters", () => {
		const [patch] = buildSessionPatches({ targets: [target()], transform: DRAGGED });
		const params = patch?.updates.params;
		expect(params?.["transform.positionX"]).toBe(111);
		expect(params?.["transform.positionY"]).toBe(222);
		expect(params?.["transform.scaleX"]).toBe(1.5);
		// Untouched params ride along.
		expect(params?.["transform.rotate"]).toBe(30);
		expect(patch?.updates.animations).toBeUndefined();
	});

	test("a keyed element writes a complete keyframe group at the playhead", () => {
		const base = textElement();
		const [patch] = buildSessionPatches({
			targets: [target({ keyed: true, element: base })],
			transform: DRAGGED,
		});
		const keyed = textElement({ animations: patch?.updates.animations });
		const resolved = resolveClipValuesAtTime({ element: keyed, localTime: LOCAL_TIME });
		expect(resolved["transform.positionX"]).toBeCloseTo(111, 6);
		expect(resolved["transform.positionY"]).toBeCloseTo(222, 6);
		expect(resolved["transform.scaleX"]).toBeCloseTo(1.5, 6);
		expect(resolved["transform.scaleY"]).toBeCloseTo(1.5, 6);
		// Rotate/opacity ride along from the pre-gesture values.
		expect(resolved["transform.rotate"]).toBeCloseTo(30, 6);
		expect(resolved.opacity).toBeCloseTo(0.8, 6);
		expect(patch?.updates.params).toBeUndefined();
	});

	test("every caption in the scene is written by one frame", () => {
		const patches = buildSessionPatches({
			targets: [
				target({ elementId: "caption-a" }),
				target({ elementId: "caption-b", keyed: true }),
				target({ elementId: "caption-c" }),
			],
			transform: DRAGGED,
		});
		expect(patches.map((patch) => patch.elementId)).toEqual([
			"caption-a",
			"caption-b",
			"caption-c",
		]);
		expect(
			patches.filter((patch) => patch.updates.animations !== undefined),
		).toHaveLength(1);
		for (const patch of patches) {
			const params = patch.updates.params;
			if (params) {
				expect(params?.["transform.positionX"]).toBe(111);
				expect(params?.["transform.positionY"]).toBe(222);
			}
		}
	});
});
