import { describe, expect, test } from "bun:test";
import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import { planTemplate } from "../plan";
import {
	TEMPLATE_CATEGORIES,
	TEMPLATES,
	getTemplate,
	isTemplateCategory,
	templatesForCategory,
} from "../library";
import type { Template, TemplateMediaAssignments } from "../types";

/**
 * The Templates tab used to be a "not in Cutlyra yet" sheet. These are the
 * invariants that keep the replacement honest: every advertised category must
 * ship usable templates, every slot must be a real element the planner emits,
 * and the timeline a descriptor promises must be the timeline it produces.
 */

function fullMedia(template: Template): TemplateMediaAssignments {
	const assignments: TemplateMediaAssignments = {};
	for (const slot of template.mediaSlots) {
		assignments[slot.id] = {
			mediaId: `media-${slot.id}`,
			name: slot.label,
			type: slot.kind,
			// Long enough to fill any slot, so clamping is not what these tests
			// are measuring.
			sourceDuration: slot.duration * 2,
		};
	}
	return assignments;
}

describe("template library", () => {
	test("ships at least twelve templates with unique ids and versions", () => {
		expect(TEMPLATES.length).toBeGreaterThanOrEqual(12);
		const ids = TEMPLATES.map((template) => template.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const template of TEMPLATES) {
			expect(template.version).toBeGreaterThanOrEqual(1);
			expect(Number.isInteger(template.version)).toBe(true);
			expect(template.name.length).toBeGreaterThan(0);
			expect(template.description.length).toBeGreaterThan(0);
		}
	});

	test("every advertised category contains at least one template", () => {
		for (const category of Object.keys(TEMPLATE_CATEGORIES)) {
			if (!isTemplateCategory(category)) continue;
			const templates = templatesForCategory({ category });
			expect(templates.length).toBeGreaterThan(0);
		}
		expect(Object.keys(TEMPLATE_CATEGORIES).length).toBeGreaterThanOrEqual(5);
	});

	test("every template keeps its slots inside its declared duration", () => {
		for (const template of TEMPLATES) {
			expect(template.duration).toBeGreaterThan(0);
			const slots = [
				...template.mediaSlots,
				...template.textSlots,
				...(template.graphics ?? []),
			];
			expect(slots.length).toBeGreaterThan(0);
			for (const slot of slots) {
				expect(slot.startTime).toBeGreaterThanOrEqual(0);
				expect(slot.duration).toBeGreaterThan(0);
				expect(slot.startTime + slot.duration).toBeLessThanOrEqual(
					template.duration + 1e-9,
				);
			}
		}
	});

	test("main-track media slots are contiguous so a transition has two clips", () => {
		for (const template of TEMPLATES) {
			let cursor = 0;
			for (const slot of template.mediaSlots) {
				expect(slot.startTime).toBeCloseTo(cursor, 6);
				cursor = slot.startTime + slot.duration;
			}
			expect(cursor).toBeCloseTo(template.duration, 6);
		}
	});

	test("only transition kinds the engine actually renders are used", () => {
		for (const template of TEMPLATES) {
			for (const slot of template.mediaSlots) {
				if (!slot.transitionAfter) continue;
				// The transition picker's own list (mobile-ui transition-sheet):
				// v1 renders every kind as a cross-fade, but only these ids exist.
				expect(["fade"]).toContain(slot.transitionAfter.kind);
				expect(slot.transitionAfter.duration).toBeGreaterThan(0);
			}
			// A transition on the last clip has nothing to fade into.
			const last = template.mediaSlots[template.mediaSlots.length - 1];
			expect(last?.transitionAfter ?? null).toBeNull();
		}
	});

	test("every text slot has real, non-empty content and a label", () => {
		for (const template of TEMPLATES) {
			expect(template.textSlots.length).toBeGreaterThan(0);
			for (const slot of template.textSlots) {
				expect(slot.label.trim().length).toBeGreaterThan(0);
				expect(slot.content.trim().length).toBeGreaterThan(0);
				expect(slot.fontSize).toBeGreaterThan(0);
			}
		}
	});

	test("decorative graphics resolve to bundled definitions", () => {
		registerDefaultGraphics();
		for (const template of TEMPLATES) {
			for (const slot of template.graphics ?? []) {
				expect(graphicsRegistry.has(slot.definitionId)).toBe(true);
			}
		}
	});

	test("canvas sizes and palette colours are usable", () => {
		for (const template of TEMPLATES) {
			expect(template.canvas.width).toBeGreaterThan(0);
			expect(template.canvas.height).toBeGreaterThan(0);
			for (const color of [
				template.palette.from,
				template.palette.to,
				template.palette.accent,
			]) {
				expect(color).toMatch(/^#[0-9a-f]{6}$/i);
			}
		}
	});

	test("lookup helpers agree with the library", () => {
		for (const template of TEMPLATES) {
			expect(getTemplate({ id: template.id })?.name).toBe(template.name);
		}
		expect(getTemplate({ id: "does-not-exist" })).toBeNull();
		expect(templatesForCategory({ category: "all" }).length).toBe(TEMPLATES.length);
	});
});

describe("template planner", () => {
	test("a fully filled template plans one element per slot", () => {
		for (const template of TEMPLATES) {
			const plan = planTemplate({ template, media: fullMedia(template) });
			const expected =
				template.mediaSlots.length +
				template.textSlots.length +
				(template.graphics?.length ?? 0);
			expect(plan.elements.length).toBe(expected);
			expect(plan.unfilledSlots).toHaveLength(0);
			expect(plan.warnings).toHaveLength(0);
			expect(plan.settings.canvasSize).toEqual(template.canvas);
			expect(plan.settings.fps).toEqual(template.fps);
		}
	});

	test("missing media is reported, never silently faked, and never drops text", () => {
		const template = TEMPLATES[0];
		const plan = planTemplate({ template });
		expect(plan.elements.filter((element) => element.kind === "media")).toHaveLength(0);
		expect(plan.unfilledSlots.map((slot) => slot.slotId)).toEqual(
			template.mediaSlots.map((slot) => slot.id),
		);
		expect(plan.elements.filter((element) => element.kind === "text")).toHaveLength(
			template.textSlots.length,
		);
	});

	test("text overrides replace content without mutating the descriptor", () => {
		const template = TEMPLATES[0];
		const slot = template.textSlots[0];
		const plan = planTemplate({
			template,
			text: { [slot.id]: "My own words" },
		});
		const planned = plan.elements.find(
			(element) => element.kind === "text" && element.slotId === slot.id,
		);
		expect(planned?.kind).toBe("text");
		if (planned?.kind === "text") {
			expect(planned.content).toBe("My own words");
			expect(planned.params.content).toBe("My own words");
		}
		expect(slot.content).not.toBe("My own words");
	});

	test("videos are clamped to the source but stills always fill the slot", () => {
		const template = TEMPLATES.find((candidate) =>
			candidate.mediaSlots.some((slot) => slot.kind === "video"),
		);
		expect(template).toBeDefined();
		if (!template) return;
		const videoSlot = template.mediaSlots.find((slot) => slot.kind === "video");
		expect(videoSlot).toBeDefined();
		if (!videoSlot) return;
		const shortClip = Math.max(0.5, videoSlot.duration - 1);
		const plan = planTemplate({
			template,
			media: {
				[videoSlot.id]: {
					mediaId: "clamped",
					name: "short",
					type: "video",
					sourceDuration: shortClip,
				},
			},
		});
		const planned = plan.elements.find(
			(element) => element.kind === "media" && element.slotId === videoSlot.id,
		);
		if (planned?.kind === "media") {
			expect(planned.duration).toBeCloseTo(shortClip, 6);
		}

		const stillTemplate = TEMPLATES.find((candidate) =>
			candidate.mediaSlots.some((slot) => slot.kind === "image"),
		);
		const stillSlot = stillTemplate?.mediaSlots.find((slot) => slot.kind === "image");
		if (stillTemplate && stillSlot) {
			const stillPlan = planTemplate({
				template: stillTemplate,
				media: {
					[stillSlot.id]: {
						mediaId: "still",
						name: "still",
						type: "image",
						sourceDuration: 0.4,
					},
				},
			});
			const stillPlanned = stillPlan.elements.find(
				(element) => element.kind === "media" && element.slotId === stillSlot.id,
			);
			if (stillPlanned?.kind === "media") {
				expect(stillPlanned.duration).toBeCloseTo(stillSlot.duration, 6);
			}
		}
	});

	test("media params carry framing and the slot transform", () => {
		const template = TEMPLATES.find((candidate) =>
			candidate.mediaSlots.some((slot) => slot.framing === "fill"),
		);
		expect(template).toBeDefined();
		if (!template) return;
		const slot = template.mediaSlots.find((candidate) => candidate.framing === "fill");
		if (!slot) return;
		const plan = planTemplate({
			template,
			media: {
				[slot.id]: {
					mediaId: "m",
					name: "m",
					type: slot.kind,
					sourceDuration: slot.duration,
				},
			},
		});
		const planned = plan.elements.find(
			(element) => element.kind === "media" && element.slotId === slot.id,
		);
		if (planned?.kind === "media") {
			expect(planned.params.framing).toBe("fill");
			expect(planned.params["transform.scaleX"]).toBe(1);
			expect(planned.params["transform.positionX"]).toBe(0);
		}
	});
});
