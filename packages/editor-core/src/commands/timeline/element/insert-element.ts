import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type {
	CreateTimelineElement,
	SceneTracks,
	TimelineElement,
	TrackType,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { requiresMediaId } from "@/timeline/element-utils";
import type { MediaAsset } from "@/media/types";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { floatToFrameRate } from "@/fps/utils";
import {
	DEFAULT_CANVAS_SIZE,
	getAdoptedCanvasSizeForFirstVisualElement,
} from "@/canvas/sizes";
import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import {
	applyPlacement,
	canElementGoOnTrack,
	resolveTrackPlacement,
	validateElementTrackCompatibility,
} from "@/timeline/placement";
import { roundMediaTime } from "@/wasm";

type InsertElementPlacement =
	| { mode: "explicit"; trackId: string }
	| { mode: "auto"; trackType?: TrackType; insertIndex?: number }
	/** Always creates a FRESH track of `trackType` (placement strategy
	 *  `alwaysNew`) — the overlay-media insert needs this: `auto` would
	 *  happily land a picture-in-picture clip on the MAIN track whenever
	 *  the playhead sits over empty main space. */
	| { mode: "newTrack"; trackType: TrackType; position?: "highest" | "default" };

export interface InsertElementParams {
	element: CreateTimelineElement;
	placement: InsertElementPlacement;
}

export class InsertElementCommand extends Command {
	private elementId: string;
	private savedState: SceneTracks | null = null;
	private targetTrackId: string | null = null;

	constructor({ element, placement }: InsertElementParams) {
		super();
		this.elementId = generateUUID();
		this.element = element;
		this.placement = placement;
	}

	private element: CreateTimelineElement;
	private placement: InsertElementPlacement;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		if (!this.validateElementBasics({ element: this.element })) {
			return;
		}

		// Aspect adoption is a FIRST-VISUAL-ELEMENT rule, so "first" is counted
		// in visual terms: an audio clip already on the timeline does not
		// establish the project's aspect (matching the import seam's
		// `hadVisualMediaBefore`).
		// Typed as `{ type?: unknown }` on purpose: `overlay` is a union of
		// track shapes whose element arrays are themselves a union, so a
		// spread of both arrays makes inference collapse to `unknown`.
		const isVisualElement = (element: { type?: unknown }): boolean =>
			element.type === "video" || element.type === "image";
		const hasVisualMediaBefore =
			this.savedState.main.elements.some(isVisualElement) ||
			this.savedState.overlay.some((track) =>
				(track.elements as ReadonlyArray<{ type?: unknown }>).some(
					isVisualElement,
				),
			);

		const newElement = this.buildElement({ element: this.element });
		const updateResult = this.applyPlacementResult({
			tracks: this.savedState,
			element: newElement,
		});

		if (!updateResult) {
			return;
		}

		const { updatedTracks, targetTrackId } = updateResult;
		this.targetTrackId = targetTrackId;

		const isVisualMedia =
			newElement.type === "video" || newElement.type === "image";

		if (isVisualMedia) {
			const mediaAssets = editor.media.getAssets();
			const activeProject = editor.project.getActive();
			const asset = mediaAssets.find(
				(item: MediaAsset) => item.id === newElement.mediaId,
			);

			if (asset?.width && asset?.height) {
				// ONE decision point for adoption (GitHub #30 / Linear PAV-81).
				// The previous code called `normalizeAdoptedCanvasSize` directly,
				// which skipped every guard the import seam applies and so
				// overwrote an explicit 1:1 / 9:16 / custom canvas the moment the
				// first clip landed. SOURCE dims are still what gets normalized —
				// on mobile `width`/`height` are the 540p preview proxy's.
				const nextCanvasSize = getAdoptedCanvasSizeForFirstVisualElement({
					currentSize: activeProject?.settings.canvasSize ?? DEFAULT_CANVAS_SIZE,
					currentMode: activeProject?.settings.canvasSizeMode,
					isFirstVisualElement: !hasVisualMediaBefore,
					asset: {
						type: asset.type,
						width: asset.width,
						height: asset.height,
						sourceWidth: asset.sourceWidth,
						sourceHeight: asset.sourceHeight,
					},
				});
				if (nextCanvasSize) {
					const shouldSetOriginalCanvasSize =
						!activeProject?.settings.originalCanvasSize;
					editor.project.updateSettings({
						settings: {
							canvasSize: nextCanvasSize,
							...(shouldSetOriginalCanvasSize
								? { originalCanvasSize: nextCanvasSize }
								: {}),
						},
						pushHistory: false,
					});
				}
			}

			if (asset?.type === "video" && asset?.fps) {
				editor.project.updateSettings({
					settings: { fps: floatToFrameRate(asset.fps) },
					pushHistory: false,
				});
			}
		}

		editor.timeline.updateTracks(updatedTracks);

		return {
			selection: {
				selectedElements: [
					{ trackId: targetTrackId, elementId: this.elementId },
				],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getElementId(): string {
		return this.elementId;
	}

	getTrackId(): string | null {
		return this.targetTrackId;
	}

	private buildElement({
		element,
	}: {
		element: CreateTimelineElement;
	}): TimelineElement {
		return {
			...element,
			id: this.elementId,
			startTime: element.startTime,
			trimStart: element.trimStart ?? 0,
			trimEnd: element.trimEnd ?? 0,
			duration: element.duration ?? DEFAULT_NEW_ELEMENT_DURATION,
		} as TimelineElement;
	}

	private validateElementBasics({
		element,
	}: {
		element: CreateTimelineElement;
	}): boolean {
		if (requiresMediaId({ element }) && !("mediaId" in element)) {
			console.error("Element requires mediaId");
			return false;
		}

		if (
			element.type === "audio" &&
			element.sourceType === "library" &&
			!element.sourceUrl
		) {
			console.error("Library audio element must have sourceUrl");
			return false;
		}

		if (element.type === "sticker" && !element.stickerId) {
			console.error("Sticker element must have stickerId");
			return false;
		}

		if (element.type === "graphic") {
			registerDefaultGraphics();
			if (
				!element.definitionId ||
				!graphicsRegistry.has(element.definitionId)
			) {
				console.error("Graphic element must have a valid definitionId");
				return false;
			}
		}

		if (element.type === "text" && !element.params.content) {
			console.error("Text element must have content");
			return false;
		}

		if (element.type === "caption" && element.words.length === 0) {
			console.error("Caption element must have at least one word");
			return false;
		}

		if (element.type === "effect" && !element.effectType) {
			console.error("Effect element must have effectType");
			return false;
		}

		return true;
	}

	private applyPlacementResult({
		tracks,
		element,
	}: {
		tracks: SceneTracks;
		element: TimelineElement;
	}): { updatedTracks: SceneTracks; targetTrackId: string } | null {
		const placement = this.placement;

		if (
			(placement.mode === "auto" || placement.mode === "newTrack") &&
			placement.trackType &&
			!canElementGoOnTrack({
				elementType: element.type,
				trackType: placement.trackType,
			})
		) {
			console.error(
				`${element.type} elements cannot be placed on ${placement.trackType} tracks`,
			);
			return null;
		}

		const placementResult = resolveTrackPlacement({
			tracks,
			...((placement.mode === "auto" || placement.mode === "newTrack") &&
			placement.trackType
				? { trackType: placement.trackType }
				: { elementType: element.type }),
			timeSpans: [
				{
					startTime: element.startTime,
					duration: element.duration,
				},
			],
			strategy:
				placement.mode === "explicit"
					? { type: "explicit", trackId: placement.trackId }
					: placement.mode === "newTrack"
						? { type: "alwaysNew", position: placement.position ?? "default" }
						: { type: "firstAvailable" },
		});
		if (!placementResult) {
			if (placement.mode === "explicit") {
				const targetTrack =
					tracks.main.id === placement.trackId
						? tracks.main
						: (tracks.overlay.find((track) => track.id === placement.trackId) ??
							tracks.audio.find((track) => track.id === placement.trackId));
				if (!targetTrack) {
					console.error("Track not found:", placement.trackId);
					return null;
				}

				const validation = validateElementTrackCompatibility({
					element,
					track: targetTrack,
				});
				console.error(validation.errorMessage);
			}

			return null;
		}

		const elementToPlace =
			placementResult.kind === "existingTrack"
				? {
						...element,
						startTime:
							placementResult.adjustedStartTime !== undefined
								? roundMediaTime({
										time: placementResult.adjustedStartTime,
									})
								: element.startTime,
					}
				: element;

		const appliedPlacement = applyPlacement({
			tracks,
			placementResult,
			elements: [elementToPlace],
			newTrackInsertIndexOverride:
				placement.mode === "auto" && typeof placement.insertIndex === "number"
					? placement.insertIndex
					: undefined,
		});
		if (!appliedPlacement) {
			return null;
		}

		return {
			updatedTracks: appliedPlacement.updatedTracks,
			targetTrackId: appliedPlacement.targetTrackId,
		};
	}
}
