import { EditorCore } from "@/core";
import { InsertElementCommand, UpdateProjectSettingsCommand, TransitionsSnapshotCommand } from "@/commands";
import {
	buildElementFromMedia,
	buildGraphicElement,
	buildTextElement,
} from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import type { TSceneTransition } from "@/timeline";
import { planDuration, planTemplate } from "./plan";
import type {
	PlannedElement,
	Template,
	TemplateApplySummary,
	TemplateMediaAssignments,
	TemplateTextOverrides,
} from "./types";

export interface AppliedTemplateRefs {
	projectId: string;
	projectName: string;
	/** Elements the template inserted, in timeline order, keyed by slot id. */
	elementRefs: Record<string, { trackId: string; elementId: string }>;
	summary: TemplateApplySummary;
}

/**
 * Apply a template as a NEW project.
 *
 * Deliberately never merges into the current project: a template is a whole
 * composition (its own canvas, fps, background and main track), so merging
 * would either overwrite the user's existing clips or interleave two
 * timelines. "New project" is also what makes applying the same template
 * twice safe — each apply starts clean instead of stacking a second copy of
 * the same main-track clips.
 *
 * Everything goes through the same commands as manual editing, so the result
 * is an ordinary project: undoable, persisted by the save manager, editable in
 * every panel, and exported by the same native EDL path.
 */
export async function applyTemplateToNewProject({
	editor,
	template,
	media = {},
	text = {},
	projectName,
	prepareMedia,
}: {
	editor: EditorCore;
	template: Template;
	media?: TemplateMediaAssignments;
	text?: TemplateTextOverrides;
	projectName?: string;
	/**
	 * Runs after the new project exists and before any clip is inserted. Native
	 * media has to be imported HERE, not before: `createNewProject` calls
	 * `editor.media.clearAllAssets()`, so assets picked against the previous
	 * project would be silently dropped. Resolves to the assignments to use.
	 */
	prepareMedia?: (args: {
		projectId: string;
		slots: Template["mediaSlots"];
	}) => Promise<TemplateMediaAssignments>;
}): Promise<AppliedTemplateRefs> {
	const projectId = await editor.project.createNewProject({
		name: projectName ?? template.name,
	});
	const resolvedMedia = prepareMedia
		? { ...media, ...(await prepareMedia({ projectId, slots: template.mediaSlots })) }
		: media;
	const plan = planTemplate({ template, media: resolvedMedia, text });

	// Template geometry is the contract: pin the canvas BEFORE any media
	// insert. `canvasSizeMode: "preset"` at the factory default size is what
	// makes InsertElementCommand adopt the first clip's aspect (GitHub #30),
	// which would silently turn a 16:9 template portrait when the user's first
	// photo is portrait. "custom" means "the user (here: the template) chose".
	editor.command.execute({
		command: new UpdateProjectSettingsCommand({
			canvasSize: plan.settings.canvasSize,
			canvasSizeMode: "custom",
			lastCustomCanvasSize: plan.settings.canvasSize,
			fps: plan.settings.fps,
			background: plan.settings.background,
		}),
	});

	const elementRefs: Record<string, { trackId: string; elementId: string }> = {};
	const mainTrackId = editor.scenes.getActiveScene().tracks.main.id;
	const mainOrder: Array<{
		slotId: string;
		elementId: string;
		transitionAfter: { kind: string; duration: number } | null;
	}> = [];

	for (const planned of plan.elements) {
		const ref = insertPlannedElement({ editor, planned, mainTrackId });
		if (!ref) continue;
		elementRefs[planned.slotId] = ref;
		if (planned.kind === "media") {
			mainOrder.push({
				slotId: planned.slotId,
				elementId: ref.elementId,
				transitionAfter: planned.transitionAfter ?? null,
			});
		}
	}

	const transitions = buildTransitions({ mainOrder });
	if (transitions.length > 0) {
		editor.command.execute({
			command: new TransitionsSnapshotCommand({ before: [], after: transitions }),
		});
	}

	return {
		projectId,
		projectName: editor.project.getActive().metadata.name,
		elementRefs,
		summary: {
			templateId: plan.templateId,
			insertedElements: Object.keys(elementRefs).length,
			unfilledSlots: plan.unfilledSlots,
			warnings: plan.warnings,
		},
	};
}

function insertPlannedElement({
	editor,
	planned,
	mainTrackId,
}: {
	editor: EditorCore;
	planned: PlannedElement;
	mainTrackId: string;
}): { trackId: string; elementId: string } | null {
	const startTime = mediaTimeFromSeconds({ seconds: planned.startTime });
	const duration = mediaTimeFromSeconds({ seconds: planned.duration });

	if (planned.kind === "media") {
		const base = buildElementFromMedia({
			mediaId: planned.mediaId,
			mediaType: planned.mediaType,
			name: planned.name,
			duration,
			startTime,
		});
		const element =
			planned.mediaType === "video"
				? {
						...base,
						isSourceAudioEnabled: planned.sourceAudio,
					}
				: base;
		const command = new InsertElementCommand({
			element: {
				...element,
				params: { ...element.params, ...planned.params },
				duration,
			},
			placement: { mode: "explicit", trackId: mainTrackId },
		});
		editor.command.execute({ command });
		const trackId = command.getTrackId();
		return trackId ? { trackId, elementId: command.getElementId() } : null;
	}

	if (planned.kind === "text") {
		const command = new InsertElementCommand({
			element: buildTextElement({
				raw: {
					duration,
					params: planned.params,
				},
				startTime,
			}),
			placement: { mode: "auto", trackType: "text" },
		});
		editor.command.execute({ command });
		const trackId = command.getTrackId();
		return trackId ? { trackId, elementId: command.getElementId() } : null;
	}

	const graphic = buildGraphicElement({
		definitionId: planned.definitionId,
		startTime,
		params: planned.params,
	});
	const command = new InsertElementCommand({
		element: { ...graphic, duration },
		placement: { mode: "auto", trackType: "graphic" },
	});
	editor.command.execute({ command });
	const trackId = command.getTrackId();
	return trackId ? { trackId, elementId: command.getElementId() } : null;
}

/**
 * Main-track transitions exist between ADJACENT clips, so they are keyed by
 * the element that comes before the cut. Only clips that actually landed get
 * one: an unfilled slot leaves a gap, and a transition to a gap is not a
 * transition — the next clip simply starts.
 */
function buildTransitions({
	mainOrder,
}: {
	mainOrder: Array<{
		slotId: string;
		elementId: string;
		transitionAfter: { kind: string; duration: number } | null;
	}>;
}): TSceneTransition[] {
	const transitions: TSceneTransition[] = [];
	for (let index = 0; index < mainOrder.length - 1; index++) {
		const entry = mainOrder[index];
		if (!entry.transitionAfter) continue;
		transitions.push({
			id: `template-transition-${entry.elementId}`,
			afterElementId: entry.elementId,
			kind: entry.transitionAfter.kind,
			duration: mediaTimeFromSeconds({
				seconds: Math.max(1 / 30, entry.transitionAfter.duration),
			}),
		});
	}
	return transitions;
}

/** Length of the composition a template would produce with these inputs, in
 *  ticks. Used by the preview card and by tests; applying returns the real
 *  project, so this is an estimate of the same number. */
export function estimateTemplateDuration({
	template,
	media = {},
	text = {},
}: {
	template: Template;
	media?: TemplateMediaAssignments;
	text?: TemplateTextOverrides;
}) {
	return planDuration({ plan: planTemplate({ template, media, text }) });
}
