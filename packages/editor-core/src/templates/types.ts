import type { FrameRate } from "opencut-wasm";
import type { ParamValues } from "@/params";
import type { TBackground, TCanvasSize } from "@/project/types";
import type { FramingMode } from "@/rendering";

/**
 * A template is DATA, not a bespoke editor. Everything the Templates panel
 * shows and everything applying one does is derived from these descriptors:
 *
 *   descriptor -> planTemplate() -> TemplatePlan -> applyTemplateToEditor()
 *
 * `planTemplate` is pure (no EditorCore, no canvas, no storage), which is what
 * lets the whole library be tested headlessly. `applyTemplateToEditor` is a
 * thin executor that turns a plan into the same commands every other insert in
 * the app uses, so a template project is an ordinary project: editable,
 * undoable, persisted, exportable.
 */

export type TemplateCategory =
	| "social"
	| "celebration"
	| "romance"
	| "travel"
	| "cinematic"
	| "promo"
	| "minimal";

/** Offsets are canvas pixels from the canvas centre, like every element's
 *  `transform.*` params. Scale is multiplicative on the fitted size. */
export interface TemplateTransform {
	positionX: number;
	positionY: number;
	scaleX: number;
	scaleY: number;
}

export interface TemplateTransition {
	/** A registered transition kind (cross-fade, zoom, slide, ...). */
	kind: string;
	duration: number;
}

export interface TemplateMediaSlot {
	id: string;
	/** Shown on the empty placeholder and as the media picker's prompt. */
	label: string;
	kind: "video" | "image";
	/** Seconds on the template timeline. */
	startTime: number;
	duration: number;
	framing?: FramingMode;
	transform?: Partial<TemplateTransform>;
	/** Transition into the NEXT main-track clip (main-track transitions only). */
	transitionAfter?: TemplateTransition | null;
	/** Video slots keep the clip's own audio unless this is false. Secondary
	 *  shots in a montage usually mute so they don't fight the music. */
	sourceAudio?: boolean;
	params?: ParamValues;
}

export interface TemplateTextSlot {
	id: string;
	/** Placeholder name in the UI ("Headline"). */
	label: string;
	/** The text the template ships with — always real, never empty. */
	content: string;
	startTime: number;
	duration: number;
	fontSize: number;
	color: string;
	align?: "left" | "center" | "right";
	fontWeight?: "normal" | "bold";
	letterSpacing?: number;
	lineHeight?: number;
	/** Optional text background chip (colour only; the engine derives padding). */
	background?: { color: string } | null;
	transform?: Partial<TemplateTransform>;
}

/** Decorative graphic from the bundled graphics registry (rectangle, ellipse,
 *  star, heart, arrow, polygon). No downloaded assets. */
export interface TemplateGraphicSlot {
	id: string;
	label?: string;
	definitionId: string;
	startTime: number;
	duration: number;
	transform?: Partial<TemplateTransform>;
	params?: ParamValues;
}

export interface TemplatePalette {
	/** Preview card gradient endpoints, and the canvas background fallback. */
	from: string;
	to: string;
	accent: string;
}

export interface Template {
	id: string;
	/** Bumped whenever slot geometry or defaults change; stored with the
	 *  applied project so a reopen can tell what it was built from. */
	version: number;
	name: string;
	category: TemplateCategory;
	description: string;
	tags: string[];
	canvas: TCanvasSize;
	fps: FrameRate;
	/** Seconds. Must cover every slot (enforced by the library test). */
	duration: number;
	background: TBackground;
	palette: TemplatePalette;
	/** Main-track clips, in order, expected to be contiguous. */
	mediaSlots: TemplateMediaSlot[];
	textSlots: TemplateTextSlot[];
	graphics?: TemplateGraphicSlot[];
}

export interface TemplateMediaAssignment {
	mediaId: string;
	name: string;
	type: "video" | "image";
	/** Source length in seconds when known; videos are clamped to the slot. */
	sourceDuration?: number;
	hasAudio?: boolean;
}

export type TemplateMediaAssignments = Record<string, TemplateMediaAssignment>;
export type TemplateTextOverrides = Record<string, string>;

export interface TemplateSettings {
	canvasSize: TCanvasSize;
	fps: FrameRate;
	background: TBackground;
}

interface PlannedElementBase {
	slotId: string;
	startTime: number;
	duration: number;
	params: ParamValues;
}

export interface PlannedMediaElement extends PlannedElementBase {
	kind: "media";
	mediaId: string;
	name: string;
	mediaType: "video" | "image";
	transitionAfter?: TemplateTransition | null;
	/** Video only: whether the clip's own audio survives. */
	sourceAudio: boolean;
}

export interface PlannedTextElement extends PlannedElementBase {
	kind: "text";
	content: string;
}

export interface PlannedGraphicElement extends PlannedElementBase {
	kind: "graphic";
	definitionId: string;
}

export type PlannedElement =
	| PlannedMediaElement
	| PlannedTextElement
	| PlannedGraphicElement;

/** What an apply actually did — surfaced to the UI so a partially filled
 *  template says so instead of pretending it is complete. */
export interface TemplateApplySummary {
	templateId: string;
	insertedElements: number;
	unfilledSlots: UnfilledSlot[];
	warnings: string[];
}

export interface UnfilledSlot {
	slotId: string;
	label: string;
	kind: TemplateMediaSlot["kind"];
}

export interface TemplatePlan {
	templateId: string;
	templateVersion: number;
	settings: TemplateSettings;
	elements: PlannedElement[];
	/** Media slots the caller supplied nothing for. Their text/graphic slots
	 *  are still planned — applying must never silently drop the user's text. */
	unfilledSlots: UnfilledSlot[];
	warnings: string[];
}
