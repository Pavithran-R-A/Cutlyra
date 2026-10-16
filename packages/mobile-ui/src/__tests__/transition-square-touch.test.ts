import { describe, expect, it } from "bun:test";
import { TransitionSquare } from "../components/timeline/transition-square";

type PointerHandler = (event: { stopPropagation: () => void }) => void;

function renderSquare(applied = false) {
	const calls: string[] = [];
	const element = TransitionSquare({
		afterClipId: "first-clip",
		atSec: 6,
		pixelsPerSecond: 48,
		applied,
		onTap: ({ afterClipId }) => calls.push(afterClipId),
	});
	// TransitionSquare is a hook-free component, so we can check the
	// event contract directly without a DOM or fabricated touch event order.
	const props = element.props as {
		onPointerDown: PointerHandler;
		onClick: PointerHandler;
		"aria-label": string;
		style: { left: number };
	};
	return { calls, props };
}

describe("TransitionSquare touch activation regression (#15)", () => {
	it("never opens a sheet during pointerdown, before touch click completes", () => {
		const { calls, props } = renderSquare();
		let stopped = 0;
		props.onPointerDown({ stopPropagation: () => { stopped++; } });
		expect(stopped).toBe(1);
		expect(calls).toEqual([]);
	});

	it("activates exactly once on the later click and stops clip-selection bubbling", () => {
		const { calls, props } = renderSquare();
		let stopped = 0;
		props.onPointerDown({ stopPropagation: () => { stopped++; } });
		expect(calls).toHaveLength(0);
		props.onClick({ stopPropagation: () => { stopped++; } });
		expect(stopped).toBe(2);
		expect(calls).toEqual(["first-clip"]);
	});

	it("allows keyboard-generated click without a preceding pointerdown", () => {
		const { calls, props } = renderSquare();
		props.onClick({ stopPropagation() {} });
		expect(calls).toEqual(["first-clip"]);
	});

	it("preserves distinct add/edit labels for persisted transitions", () => {
		expect(renderSquare(false).props["aria-label"]).toBe("Add transition");
		expect(renderSquare(true).props["aria-label"]).toBe("Edit transition");
	});

	it("keeps square placement at the exact clip boundary", () => {
		const { props } = renderSquare();
		expect(props.style.left).toBe(288);
	});
});
