import type { ParamValues } from "@/params";
import { mediaTimeFromSeconds } from "@/wasm";
import { DEFAULT_FRAMING } from "@/rendering";
import type {
	PlannedElement,
	Template,
	TemplateMediaAssignments,
	TemplateMediaSlot,
	TemplatePlan,
	TemplateTextOverrides,
	TemplateTransform,
	UnfilledSlot,
} from "./types";

export const IDENTITY_TEMPLATE_TRANSFORM: TemplateTransform = {
	positionX: 0,
	positionY: 0,
	scaleX: 1,
	scaleY: 1,
};

/** A slot shorter than this is not a usable clip and is almost always a data
 *  bug; the planner refuses to emit one rather than shipping an invisible
 *  element into the user's timeline. */
const MIN_CLIP_SECONDS = 0.2;

function transformParams({
	transform,
	extra,
}: {
	transform?: Partial<TemplateTransform>;
	extra?: ParamValues;
}): ParamValues {
	const t = { ...IDENTITY_TEMPLATE_TRANSFORM, ...transform };
	return {
		"transform.positionX": t.positionX,
		"transform.positionY": t.positionY,
		"transform.scaleX": t.scaleX,
		"transform.scaleY": t.scaleY,
		...extra,
	};
}

function mediaParams({ slot }: { slot: TemplateMediaSlot }): ParamValues {
	return transformParams({
		transform: slot.transform,
		extra: {
			framing: slot.framing ?? DEFAULT_FRAMING,
			...(slot.params ?? {}),
		},
	});
}

/**
 * Turn a descriptor plus the user's choices into the exact elements a project
 * should contain. Pure by design: no editor, no timers, no storage.
 *
 * Rules that matter for correctness:
 *  - A video is clamped to the slot length (never stretched past its source,
 *    which would freeze the last frame for the untouched remainder) but always
 *    fills at least MIN_CLIP_SECONDS.
 *  - A still always fills its slot — that is what a photo slideshow means.
 *  - An unfilled media slot produces NO element (an element pointing at a
 *    missing asset would fail export) and is reported instead, so the UI can
 *    ask for the remaining media without losing the text the user typed.
 */
export function planTemplate({
	template,
	media = {},
	text = {},
}: {
	template: Template;
	media?: TemplateMediaAssignments;
	text?: TemplateTextOverrides;
}): TemplatePlan {
	const elements: PlannedElement[] = [];
	const unfilledSlots: UnfilledSlot[] = [];
	const warnings: string[] = [];

	for (const slot of template.mediaSlots) {
		const assignment = media[slot.id];
		if (!assignment) {
			unfilledSlots.push({
				slotId: slot.id,
				label: slot.label,
				kind: slot.kind,
			});
			continue;
		}

		if (assignment.type !== slot.kind) {
			warnings.push(
				`${slot.label}: a ${assignment.type} was supplied for a ${slot.kind} slot; using the ${slot.kind} placement.`,
			);
		}

		let duration = slot.duration;
		if (assignment.type === "video" && assignment.sourceDuration !== undefined) {
			duration = Math.min(slot.duration, assignment.sourceDuration);
		}
		if (duration < MIN_CLIP_SECONDS) {
			warnings.push(`${slot.label}: the supplied clip is shorter than ${MIN_CLIP_SECONDS}s; skipped.`);
			unfilledSlots.push({ slotId: slot.id, label: slot.label, kind: slot.kind });
			continue;
		}

		elements.push({
			kind: "media",
			slotId: slot.id,
			mediaId: assignment.mediaId,
			name: assignment.name,
			mediaType: assignment.type,
			startTime: slot.startTime,
			duration,
			params: mediaParams({ slot }),
			transitionAfter: slot.transitionAfter ?? null,
			sourceAudio: slot.sourceAudio ?? true,
		});
	}

	for (const slot of template.textSlots) {
		const content = text[slot.id] ?? slot.content;
		elements.push({
			kind: "text",
			slotId: slot.id,
			content,
			startTime: slot.startTime,
			duration: slot.duration,
			params: transformParams({
				transform: slot.transform,
				extra: {
					content,
					fontSize: slot.fontSize,
					color: slot.color,
					textAlign: slot.align ?? "center",
					fontWeight: slot.fontWeight ?? "normal",
					...(slot.letterSpacing === undefined
						? {}
						: { letterSpacing: slot.letterSpacing }),
					...(slot.lineHeight === undefined ? {} : { lineHeight: slot.lineHeight }),
					...(slot.background
						? {
								"background.enabled": true,
								"background.color": slot.background.color,
							}
						: {}),
				},
			}),
		});
	}

	for (const slot of template.graphics ?? []) {
		elements.push({
			kind: "graphic",
			slotId: slot.id,
			definitionId: slot.definitionId,
			startTime: slot.startTime,
			duration: slot.duration,
			params: transformParams({ transform: slot.transform, extra: slot.params }),
		});
	}

	return {
		templateId: template.id,
		templateVersion: template.version,
		settings: {
			canvasSize: template.canvas,
			fps: template.fps,
			background: template.background,
		},
		// Stable order: media (main track, in timeline order), then text, then
		// graphics. The executor relies on it to keep track assignment stable.
		elements,
		unfilledSlots,
		warnings,
	};
}

/** Total timeline length in MediaTime ticks, from the plan itself rather than
 *  the descriptor, so a trimmed clip can never leave a dangling tail. */
export function planDurationSeconds({ plan }: { plan: TemplatePlan }): number {
	let max = 0;
	for (const element of plan.elements) {
		max = Math.max(max, element.startTime + element.duration);
	}
	return max;
}

export function planDuration({ plan }: { plan: TemplatePlan }) {
	return mediaTimeFromSeconds({ seconds: planDurationSeconds({ plan }) });
}

