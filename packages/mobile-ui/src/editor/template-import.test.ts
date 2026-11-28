import { describe, expect, test } from "bun:test";
import { TEMPLATES } from "@cutlyra/editor-core/templates";
import type { Template } from "@cutlyra/editor-core/templates";
import type { TemplateMediaAssignments } from "@cutlyra/editor-core/templates";
import {
	templateAssignmentForAsset,
	unfilledTemplateSlots,
} from "./actions";

/**
 * Template import slot assignment. The native picker itself is covered by the
 * Android instrumentation test; these pin the pure rules the mobile flow uses
 * so a template can never ask for an already-filled slot, reorder slots, or
 * retype one from a probe mismatch.
 */

function multiSlotTemplate(): Template {
	const template = TEMPLATES.find((candidate) => candidate.mediaSlots.length >= 3);
	if (!template) throw new Error("no template with three media slots in the library");
	return template;
}

describe("unfilledTemplateSlots", () => {
	test("returns every slot in template order when nothing is assigned", () => {
		const template = multiSlotTemplate();
		expect(unfilledTemplateSlots({ template, media: {} }).map((slot) => slot.id)).toEqual(
			template.mediaSlots.map((slot) => slot.id),
		);
	});

	test("skips slots that already hold media instead of picking them again", () => {
		const template = multiSlotTemplate();
		const filled = template.mediaSlots[0];
		if (!filled) throw new Error("template has no first slot");
		const media: TemplateMediaAssignments = {
			[filled.id]: {
				mediaId: "existing",
				name: "Existing clip",
				type: filled.kind,
			},
		};
		expect(unfilledTemplateSlots({ template, media }).map((slot) => slot.id)).toEqual(
			template.mediaSlots.slice(1).map((slot) => slot.id),
		);
	});
});

describe("templateAssignmentForAsset", () => {
	test("uses the slot's kind and keeps the source duration", () => {
		const template = multiSlotTemplate();
		const slot = template.mediaSlots[0];
		if (!slot) throw new Error("template has no first slot");
		const assignment = templateAssignmentForAsset({
			asset: {
				id: "asset-1",
				name: "clip.mp4",
				type: "video",
				duration: 8.5,
			},
			slot,
		});
		expect(assignment.mediaId).toBe("asset-1");
		expect(assignment.name).toBe("clip.mp4");
		expect(assignment.type).toBe(slot.kind);
		expect(assignment.sourceDuration).toBe(8.5);
	});

	test("a probe mismatch cannot retype the slot, and a still duration of 0 is omitted", () => {
		const template = multiSlotTemplate();
		const slot = template.mediaSlots[0];
		if (!slot) throw new Error("template has no first slot");
		const assignment = templateAssignmentForAsset({
			asset: { id: "asset-2", name: "photo.jpg", type: "image", duration: 0 },
			slot,
		});
		expect(assignment.type).toBe(slot.kind);
		expect(assignment.sourceDuration).toBeUndefined();
	});
});
