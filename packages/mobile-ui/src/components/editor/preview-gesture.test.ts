import { describe, expect, test } from "bun:test";
import {
	applyPointerTopologyChange,
	gestureTransform,
	initialAnchors,
	pointerCentroidAndDistance,
	type GestureAnchors,
	type GesturePointer,
	type GestureTransform,
} from "./preview-gesture";

/** CSS px per canvas unit: a 400px-wide mount showing an 800-unit canvas. */
const SCALE = 2;

/**
 * Drives the production gesture functions in the same order the component's
 * pointer handlers do (`preview-renderer.tsx` calls these exact functions; the
 * only difference here is the engine sink, which records the payload instead
 * of applying it).
 */
class GestureHarness {
	state: GestureAnchors | null = null;
	dragging = false;
	preview: GestureTransform | null = null;
	committed: GestureTransform | null = null;
	readonly trace: { step: string; pointers: number; transform: GestureTransform }[] = [];

	constructor({
		start = { x: 0, y: 0 },
		startScale = 1,
	}: { start?: { x: number; y: number }; startScale?: number } = {}) {
		this.start = start;
		this.startScale = startScale;
	}

	private readonly start: { x: number; y: number };
	private readonly startScale: number;

	private record(step: string) {
		if (!this.state) return;
		this.trace.push({
			step,
			pointers: this.state.pointers.size,
			transform: gestureTransform({ anchors: this.state, scale: SCALE }),
		});
	}

	down({ id, x, y }: { id: number; x: number; y: number }) {
		if (this.state) {
			applyPointerTopologyChange({
				state: this.state,
				mutate: (pointers) => pointers.set(id, { x, y }),
				scale: SCALE,
			});
			this.record(`down:#${id}`);
			return;
		}
		this.state = {
			...initialAnchors({
				pointers: new Map<number, GesturePointer>([[id, { x, y }]]),
				positionX: this.start.x,
				positionY: this.start.y,
				scaleX: this.startScale,
				scaleY: this.startScale,
			}),
		};
		this.record(`down:#${id}`);
	}

	move({ id, x, y }: { id: number; x: number; y: number }) {
		if (!this.state?.pointers.has(id)) return;
		this.state.pointers.set(id, { x, y });
		this.dragging = true;
		this.preview = gestureTransform({ anchors: this.state, scale: SCALE });
		this.record(`move:#${id}`);
	}

	up({ id, x, y }: { id: number; x: number; y: number }) {
		const last = this.state?.pointers.get(id);
		if (!this.state || !last) return;
		if (this.dragging && (last.x !== x || last.y !== y)) {
			this.state.pointers.set(id, { x, y });
			this.preview = gestureTransform({ anchors: this.state, scale: SCALE });
			this.record(`up-coords:#${id}`);
		}
		applyPointerTopologyChange({
			state: this.state,
			mutate: (pointers) => pointers.delete(id),
			scale: SCALE,
		});
		this.record(`up:#${id}`);
		if (this.state.pointers.size === 0) {
			// The component commits exactly the preview it last applied.
			this.committed = this.preview;
			this.state = null;
		}
	}

	cancel() {
		this.state = null;
		this.preview = null;
	}

	/** The transform the NEXT move would produce for this pointer set. */
	peek() {
		if (!this.state) throw new Error("no session");
		return gestureTransform({ anchors: this.state, scale: SCALE });
	}
}

describe("pointer topology never moves the element", () => {
	test("single-finger drag follows the pointer delta at the mount scale", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 });
		h.move({ id: 1, x: 150, y: 120 });
		expect(h.preview?.positionX).toBeCloseTo(100, 6); // 50 CSS px * 2
		expect(h.preview?.positionY).toBeCloseTo(40, 6);
		expect(h.preview?.scaleX).toBeCloseTo(1, 6);
	});

	test("a second finger landing while stationary changes nothing", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 });
		h.move({ id: 1, x: 150, y: 100 });
		const beforeJoin = h.preview?.positionX ?? 0;

		h.down({ id: 2, x: 250, y: 100 }); // 100 CSS px away, pointer 1 not moved
		expect(h.peek().positionX).toBeCloseTo(beforeJoin, 6);

		// The next move must travel only as far as the centroid did: finger 2
		// moved 10 CSS px, so the two-finger centroid moved 5.
		h.move({ id: 2, x: 260, y: 100 });
		expect(h.peek().positionX).toBeCloseTo(beforeJoin + 10, 6);
	});

	test("the pre-fix ordering (re-anchor after mutating the map) keys in a jump", () => {
		// Recorded defect, reproduced numerically: the old code read the
		// transform from a pointer set that already contained the new finger.
		const anchors: GestureAnchors = initialAnchors({
			pointers: new Map<number, GesturePointer>([[1, { x: 150, y: 100 }]]),
			positionX: 100,
			positionY: 0,
			scaleX: 1,
			scaleY: 1,
		});
		anchors.pointers.set(2, { x: 250, y: 100 }); // mutated BEFORE reading
		const jumped = gestureTransform({ anchors: anchors, scale: SCALE });
		// Centroid moved 150 -> 200 CSS px against the old origin: +100 units.
		expect(jumped.positionX).toBeCloseTo(200, 6);
		expect(jumped.positionX - 100).toBeCloseTo(100, 6);

		// The production ordering banks the on-screen 100 and jumps 0.
		const correct = initialAnchors({
			pointers: new Map<number, GesturePointer>([[1, { x: 150, y: 100 }]]),
			positionX: 100,
			positionY: 0,
			scaleX: 1,
			scaleY: 1,
		});
		const banked = applyPointerTopologyChange({
			state: correct,
			mutate: (pointers) => pointers.set(2, { x: 250, y: 100 }),
			scale: SCALE,
		});
		expect(banked.positionX).toBeCloseTo(100, 6);
		expect(gestureTransform({ anchors: correct, scale: SCALE }).positionX).toBeCloseTo(100, 6);
	});

	test("lifting a finger while the other is stationary changes nothing", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 });
		h.down({ id: 2, x: 300, y: 100 });
		h.move({ id: 2, x: 300, y: 140 });
		const pinned = h.peek().positionY;

		h.up({ id: 2, x: 300, y: 140 });
		expect(h.peek().positionY).toBeCloseTo(pinned, 6);
		h.move({ id: 1, x: 120, y: 100 }); // horizontal only: the remaining finger keeps y
		expect(h.preview?.positionY).toBeCloseTo(pinned, 6);
		expect(h.preview?.positionX).toBeCloseTo(40, 6); // pointer 1 travelled 20px
	});

	test("lift order A-then-B and B-then-A leave the element in one place", () => {
		const run = (order: [number, number]) => {
			const h = new GestureHarness();
			h.down({ id: 1, x: 100, y: 100 });
			h.down({ id: 2, x: 300, y: 100 });
			h.move({ id: 1, x: 140, y: 100 });
			h.move({ id: 2, x: 340, y: 100 });
			h.up({ id: order[0], x: order[0] === 1 ? 140 : 340, y: 100 });
			h.up({ id: order[1], x: order[1] === 1 ? 140 : 340, y: 100 });
			return h.committed?.positionX;
		};
		const forward = run([1, 2]);
		const reverse = run([2, 1]);
		expect(forward).toBeCloseTo(reverse ?? Number.NaN, 6);
		expect(forward).toBeCloseTo(80, 6); // the centroid travelled 40 CSS px
	});
});

describe("pinch scaling", () => {
	test("spreading two fingers enlarges and closing them shrinks", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 });
		h.down({ id: 2, x: 200, y: 100 }); // distance 100
		h.move({ id: 2, x: 300, y: 100 }); // distance 200 -> 2x
		expect(h.peek().scaleX).toBeCloseTo(2, 6);
		h.move({ id: 2, x: 150, y: 100 }); // distance 50 -> 0.5x
		expect(h.peek().scaleX).toBeCloseTo(0.5, 6);
	});

	test("joining a second finger does not rescale on its own", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 });
		h.down({ id: 2, x: 260, y: 100 });
		expect(h.peek().scaleX).toBeCloseTo(1, 6);
		h.up({ id: 2, x: 260, y: 100 });
		expect(h.peek().scaleX).toBeCloseTo(1, 6);
	});
});

describe("snap detent", () => {
	test("the element lands on the centre axis and leaves it with the finger", () => {
		// Starts 40 units right of centre, grabbed at x=100.
		const h = new GestureHarness({ start: { x: 40, y: 0 } });
		h.down({ id: 1, x: 100, y: 100 });
		h.move({ id: 1, x: 80, y: 100 }); // raw 40 + (-20 CSS * 2) = 0 -> captured
		expect(h.preview?.positionX).toBe(0);
		expect(h.preview?.snapped.x).toBe(true);
		h.move({ id: 1, x: 250, y: 100 }); // far away: released, follows the finger
		expect(h.preview?.snapped.x).toBe(false);
		expect(h.preview?.positionX).toBeCloseTo(340, 6); // 40 + 150*2
	});
});

describe("preview/commit continuity", () => {
	test("A–H: the committed transform equals the last visible preview", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 }); // A
		h.move({ id: 1, x: 200, y: 100 }); // B
		h.down({ id: 2, x: 400, y: 100 }); // C, second finger lands
		h.move({ id: 1, x: 220, y: 130 }); // D
		h.move({ id: 2, x: 420, y: 130 });
		h.up({ id: 2, x: 420, y: 130 }); // E, second finger lifts
		const afterLift = h.peek();
		h.move({ id: 1, x: 260, y: 160 }); // F
		h.up({ id: 1, x: 260, y: 160 }); // G
		// H: compare the commit with the frame that was on screen.
		const lastShown = h.trace.at(-1)?.transform;
		expect(h.committed?.positionX).toBeCloseTo(lastShown?.positionX ?? Number.NaN, 9);
		expect(h.committed?.positionX).toBeCloseTo(320, 6); // 160 CSS px * 2
		expect(h.committed?.positionY).toBeCloseTo(120, 6);
		expect(h.committed?.scaleX).toBeCloseTo(afterLift.scaleX, 9);
	});

	test("the release coordinates are folded in before the commit", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 });
		h.move({ id: 1, x: 150, y: 100 });
		h.up({ id: 1, x: 170, y: 100 }); // pointerup 20 CSS px past the last move
		expect(h.committed?.positionX).toBeCloseTo(140, 6);
		expect(h.committed?.positionX).toBeCloseTo(h.preview?.positionX ?? 0, 9);
	});

	test("a tap without movement commits nothing", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 });
		h.up({ id: 1, x: 100, y: 100 });
		expect(h.dragging).toBe(false);
		expect(h.committed).toBeNull();
	});

	test("cancellation keeps the pre-gesture transform", () => {
		const h = new GestureHarness();
		h.down({ id: 1, x: 100, y: 100 });
		h.move({ id: 1, x: 300, y: 100 });
		h.cancel();
		expect(h.committed).toBeNull();
	});
});

describe("geometry edge cases", () => {
	test("mount scale changes move the element by the same canvas distance", () => {
		const at = (scale: number) => {
			const anchors = initialAnchors({
				pointers: new Map<number, GesturePointer>([[1, { x: 100, y: 100 }]]),
				positionX: 0,
				positionY: 0,
				scaleX: 1,
				scaleY: 1,
			});
			anchors.pointers.set(1, { x: 120, y: 100 }); // 20 CSS px
			return gestureTransform({ anchors: anchors, scale: scale });
		};
		expect(at(2).positionX).toBeCloseTo(40, 6);
		expect(at(4).positionX).toBeCloseTo(80, 6);
		expect(at(2).scaleX).toBeCloseTo(1, 6);
	});

	test("an empty pointer set never produces NaN", () => {
		const anchors = initialAnchors({
			pointers: new Map<number, GesturePointer>(),
			positionX: 60, // outside the 12px snap capture at this scale
			positionY: -60,
			scaleX: 1,
			scaleY: 1,
		});
		const transform = gestureTransform({ anchors: anchors, scale: SCALE });
		expect(transform.positionX).toBe(60);
		expect(transform.positionY).toBe(-60);
		expect(Number.isNaN(transform.scaleX)).toBe(false);
		expect(pointerCentroidAndDistance(new Map()).distance).toBeNull();
	});
});
