import {
	Captions,
	FileText,
	LayoutTemplate,
	Layers,
	Music,
	PaintBucket,
	Scissors,
	SlidersHorizontal,
	Square,
	Sticker,
	Type,
	Wand2,
} from "lucide-react";
import type { ToolbarItemDef } from "../toolbar-row";

/**
 * M8 primary toolbar — order MEASURED from the founder's live-CapCut capture
 * session (2026-08-18, docs/capcut-reference/capture-editor-toolbar-start.png
 * + capture-editor-toolbar-scrolled.png, two overlapping scroll positions of
 * the same bar). This closes the corpus 04 §3 [NEEDS-CAPTURE] on ordering:
 * Edit / Audio / Text / Overlay / Filters / Adjust / Captions / Stickers /
 * Transcript / Aspect ratio / Background / Template.
 *
 * GitHub #48 lifted the old v0.1 hold on Filters/Adjust: the Android Media3
 * exporter now applies the same color grade the preview shader does
 * (`ColorGrade.kt` + `color-grade.ts`, parity proven by
 * `color-grade.test.ts` and `ExportColorGradeInstrumentedTest`), so these
 * two panels are export-safe to expose. Effects stays hidden — nothing
 * maps its non-affine params (sharpen/vignette) to the native exporter
 * yet, and shipping a preview-only tool is explicitly out of bounds.
 *
 * Transcript and Template open a "not in Cutlyra yet" sheet (deliberate,
 * visible response — v1 scope per docs/DECISIONS.md); Aspect ratio and
 * Background are real panels over the engine's project settings.
 */
export const PRIMARY_TOOLBAR_ITEMS: ToolbarItemDef[] = [
	{ id: "edit", label: "Edit", icon: Scissors },
	{ id: "audio", label: "Audio", icon: Music },
	{ id: "text", label: "Text", icon: Type },
	{ id: "overlay", label: "Overlay", icon: Layers },
	{ id: "filters", label: "Filters", icon: Wand2 },
	{ id: "adjust", label: "Adjust", icon: SlidersHorizontal },
	{ id: "captions", label: "Captions", icon: Captions },
	{ id: "stickers", label: "Stickers", icon: Sticker },
	{ id: "transcript", label: "Transcript", icon: FileText },
	{ id: "ratio", label: "Aspect ratio", icon: Square },
	{ id: "background", label: "Background", icon: PaintBucket },
	{ id: "template", label: "Template", icon: LayoutTemplate },
];

export type PrimaryToolId = (typeof PRIMARY_TOOLBAR_ITEMS)[number]["id"];
