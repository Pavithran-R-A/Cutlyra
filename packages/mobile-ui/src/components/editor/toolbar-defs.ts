import {
	Captions,
	FileText,
	LayoutTemplate,
	Layers,
	Music,
	PaintBucket,
	Scissors,
	Square,
	Sticker,
	Type,
} from "lucide-react";
import type { ToolbarItemDef } from "../toolbar-row";

/**
 * M8 primary toolbar — order MEASURED from the founder's live-CapCut capture
 * session (2026-08-18, docs/capcut-reference/capture-editor-toolbar-start.png
 * + capture-editor-toolbar-scrolled.png, two overlapping scroll positions of
 * the same bar). This closes the corpus 04 §3 [NEEDS-CAPTURE] on ordering:
 * Edit / Audio / Text / Overlay / Captions / Stickers / Transcript /
 * Aspect ratio / Background / Template for the v0.1.0 release surface.
 *
 * Effects / Filters / Adjust remain implemented in the shared UI/preview
 * code, but Android's native v0.1 exporter deliberately refuses non-empty
 * EdlClip.effects rather than silently dropping them. They are therefore
 * not exposed in the shipping toolbar until Android export parity lands.
 * This keeps every visible release tool export-safe.
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
	{ id: "captions", label: "Captions", icon: Captions },
	{ id: "stickers", label: "Stickers", icon: Sticker },
	{ id: "transcript", label: "Transcript", icon: FileText },
	{ id: "ratio", label: "Aspect ratio", icon: Square },
	{ id: "background", label: "Background", icon: PaintBucket },
	{ id: "template", label: "Template", icon: LayoutTemplate },
];

export type PrimaryToolId = (typeof PRIMARY_TOOLBAR_ITEMS)[number]["id"];
