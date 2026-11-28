/**
 * The ONE transition-definition layer, shared by the preview renderer
 * (`timeline/transitions.ts` -> `applyTransitionsToSceneTracks`), the EDL
 * producer (`edl/build.ts` -> `buildTransitions` + derived clip animation) and
 * — through the EDL — the Android Media3 exporter (`TransitionAlphaMath` /
 * `MainTrackPlacements` / `CrossfadeCompositorSettings`).
 *
 * DESIGN (Phase 3): a transition kind is NOT a special case in either
 * renderer. Every kind is expressed as a small set of element-local
 * animation channels — `opacity` and the `transform.*` channels both
 * renderers already evaluate per frame (preview: scene animations; export:
 * `KeyframeEvaluator` + `EdlTransformEffect` / `AnimatedOpacityRgbMatrix`).
 * The kind therefore only declares WHICH ramp its two neighbours get, in
 * which direction, and how the exporter must stack its incoming "head"
 * layer. One derivation, two renderers, no drift.
 *
 * Derived values are absolute: a channel replaces the element's static value,
 * so every derived key is `staticParam + delta`. Elements that ALREADY
 * keyframe the property are left untouched (same documented policy the
 * cross-fade has always had for hand-keyframed opacity — clobbering user
 * keyframes would be worse than skipping the derivation for that one clip).
 *
 * AUDIO POLICY: every kind below is declared `"cut"`. The native compositor
 * (media3 1.11.0) has no per-input gain ramp, so a main-track audio
 * cross-fade is impossible without re-architecting the audio lanes; the
 * exporter plays the outgoing clip's audio up to the window and the incoming
 * clip's audio from the window (the base sequence's own copy carries it).
 * That is exactly what the preview's audio scheduler does — the merged
 * timeline has no audio element overlap, because only the VISUAL tracks are
 * compressed. Defining this here makes the policy explicit and testable
 * instead of an accident of the compositor.
 */
import type { ElementAnimations, ScalarAnimationKey, ScalarChannel } from "@/animation/types";
import type { Effect } from "@/effects/types";
import { roundMediaTime } from "@/wasm";
import type { TimelineElement } from "./types";

export const SUPPORTED_TRANSITION_KINDS = [
	"fade",
	"slide",
	"push",
	"zoom",
	"wipe",
	"dip-black",
	"dip-white",
	"blur",
] as const;
export type TransitionKind = (typeof SUPPORTED_TRANSITION_KINDS)[number];

export const TRANSITION_DIRECTIONS = ["left", "right", "up", "down"] as const;
export type TransitionDirection = (typeof TRANSITION_DIRECTIONS)[number];

/** How the exporter must stack the incoming clip's head relative to the base. */
export type TransitionLayerOrder = "incoming-above" | "incoming-below";

export type TransitionAudioPolicy = "cut";

/**
 * Which derived visual pass (if any) the kind needs in BOTH renderers.
 * `"none"` kinds are pure opacity/transform ramps; `"wipe"` and `"dip"` are
 * per-layer colour/alpha passes with a progress parameter; `"blur"` reuses
 * the existing blur effect on the incoming clip.
 */
export type TransitionVisual = "none" | "wipe" | "dip" | "blur";

export interface TransitionDefinition {
	kind: TransitionKind;
	label: string;
	supportsDirection: boolean;
	defaultDirection: TransitionDirection;
	visual: TransitionVisual;
	/** Dip kinds only: the colour the frame passes through at the midpoint. */
	dipColour?: readonly [number, number, number];
	/**
	 * `incoming-below`: the head is painted UNDER the base and the base's
	 * opacity dips (alpha blend). `incoming-above`: the head is painted OVER
	 * the base and both layers are opaque, so the base stays visible in the
	 * area the head has not reached yet — required for slide/push, whose
	 * motion (not opacity) does the work.
	 */
	layerOrder: TransitionLayerOrder;
	audio: TransitionAudioPolicy;
}

export const TRANSITION_DEFINITIONS: Readonly<
	Record<TransitionKind, TransitionDefinition>
> = {
	fade: {
		kind: "fade",
		label: "Fade",
		supportsDirection: false,
		defaultDirection: "left",
		visual: "none",
		layerOrder: "incoming-below",
		audio: "cut",
	},
	slide: {
		kind: "slide",
		label: "Slide",
		supportsDirection: true,
		defaultDirection: "left",
		visual: "none",
		layerOrder: "incoming-above",
		audio: "cut",
	},
	push: {
		kind: "push",
		label: "Push",
		supportsDirection: true,
		defaultDirection: "left",
		visual: "none",
		layerOrder: "incoming-above",
		audio: "cut",
	},
	zoom: {
		kind: "zoom",
		label: "Zoom",
		supportsDirection: false,
		defaultDirection: "left",
		visual: "none",
		layerOrder: "incoming-below",
		audio: "cut",
	},
	wipe: {
		kind: "wipe",
		label: "Wipe",
		supportsDirection: true,
		defaultDirection: "left",
		visual: "wipe",
		// The wipe reveals the incoming clip through an animated edge, so it
		// must be painted over the opaque base — same stacking as slide/push.
		layerOrder: "incoming-above",
		audio: "cut",
	},
	"dip-black": {
		kind: "dip-black",
		label: "Dip to Black",
		supportsDirection: false,
		defaultDirection: "left",
		visual: "dip",
		dipColour: [0, 0, 0],
		layerOrder: "incoming-below",
		audio: "cut",
	},
	"dip-white": {
		kind: "dip-white",
		label: "Dip to White",
		supportsDirection: false,
		defaultDirection: "left",
		visual: "dip",
		dipColour: [1, 1, 1],
		layerOrder: "incoming-below",
		audio: "cut",
	},
	blur: {
		kind: "blur",
		label: "Blur",
		supportsDirection: false,
		defaultDirection: "left",
		visual: "blur",
		layerOrder: "incoming-below",
		audio: "cut",
	},
};

/** Effect type strings the preview derives for a transition (both ends). */
export const TRANSITION_WIPE_EFFECT_TYPE = "transition-wipe";
export const TRANSITION_DIP_EFFECT_TYPE = "transition-dip";

/**
 * Normalised wipe edge softness (fraction of the frame along the wipe axis).
 * Shared by the preview shader and `EdlWipeEffect` so the soft edge has the
 * same width on both renderers.
 */
export const TRANSITION_WIPE_SOFTNESS = 0.01;

/** Blur transition: peak blur strength in the preview's `blur` param units. */
export const TRANSITION_BLUR_INTENSITY = 60;

/** Stable id for a derived transition effect on one element. */
export function transitionEffectId({
	elementId,
	kind,
}: {
	elementId: string;
	kind: TransitionKind;
}): string {
	return `${elementId}:transition:${kind}`;
}

/** Direction unit vector in the shaders' sampling-coordinate space. */
export function transitionDirectionVector({
	direction,
}: {
	direction: TransitionDirection;
}): [number, number] {
	switch (direction) {
		case "left":
			return [-1, 0];
		case "right":
			return [1, 0];
		case "up":
			return [0, -1];
		case "down":
			return [0, 1];
	}
}

/** How much larger the incoming clip starts in a `zoom` transition. */
export const ZOOM_START_SCALE = 1.25;

/**
 * Historical spellings kept for documents written before the canonical
 * `TransitionKind` tokens existed.
 */
const LEGACY_ALIASES: Readonly<Record<string, TransitionKind>> = {
	crossfade: "fade",
	"cross-fade": "fade",
	cross_fade: "fade",
	dissolve: "fade",
};

/** Unsupported or missing kinds fall back to `fade` (the historical contract). */
export function normalizeTransitionKind(raw: unknown): TransitionKind {
	if (typeof raw !== "string") return "fade";
	const key = raw.trim().toLowerCase();
	const supported = SUPPORTED_TRANSITION_KINDS.find((kind) => kind === key);
	if (supported) return supported;
	return LEGACY_ALIASES[key] ?? "fade";
}

export function isSupportedTransitionKind(raw: unknown): raw is TransitionKind {
	return (
		typeof raw === "string" &&
		(SUPPORTED_TRANSITION_KINDS as readonly string[]).includes(raw.trim().toLowerCase())
	);
}

/** Kinds without a direction concept normalise to their default. */
export function normalizeTransitionDirection({
	kind,
	raw,
}: {
	kind: TransitionKind;
	raw: unknown;
}): TransitionDirection {
	const definition = TRANSITION_DEFINITIONS[kind];
	if (!definition.supportsDirection) return definition.defaultDirection;
	if (typeof raw === "string") {
		const key = raw.trim().toLowerCase();
		const match = TRANSITION_DIRECTIONS.find((candidate) => candidate === key);
		if (match) return match;
	}
	return definition.defaultDirection;
}

export interface TransitionCanvasSize {
	width: number;
	height: number;
}

/** A window as produced by `computeMainTrackPlacements` (both renderers agree). */
export interface TransitionWindowLike {
	kind: string;
	/** Normalised `TransitionDirection` on a real window; `unknown` so both
	 *  renderers can hand over the raw persisted value and get it normalised. */
	direction?: unknown;
	outgoingElementId: string;
	incomingElementId: string;
	durationTicks: number;
}

type VisualPath =
	| "opacity"
	| "transform.positionX"
	| "transform.positionY"
	| "transform.scaleX"
	| "transform.scaleY";

interface Ramp {
	path: VisualPath;
	from: number;
	to: number;
}

interface BaseVisuals {
	positionX: number;
	positionY: number;
	scaleX: number;
	scaleY: number;
}

function readStaticVisuals(element: TimelineElement): BaseVisuals {
	const params: Record<string, unknown> = element.params ?? {};
	const read = ({ key, fallback }: { key: string; fallback: number }): number => {
		const value = params[key];
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};
	return {
		positionX: read({ key: "transform.positionX", fallback: 0 }),
		positionY: read({ key: "transform.positionY", fallback: 0 }),
		scaleX: read({ key: "transform.scaleX", fallback: 1 }),
		scaleY: read({ key: "transform.scaleY", fallback: 1 }),
	};
}

/**
 * Offset a clip enters from / leaves to, in canvas PIXELS (the unit
 * `transform.positionX/Y` uses everywhere: preview NDC conversion and
 * `EdlTransformEffect.matrixValues` both divide by the canvas size).
 */
function travelOffset({
	direction,
	canvas,
}: {
	direction: TransitionDirection;
	canvas: TransitionCanvasSize;
}): { x: number; y: number } {
	switch (direction) {
		case "left":
			return { x: canvas.width, y: 0 };
		case "right":
			return { x: -canvas.width, y: 0 };
		case "up":
			return { x: 0, y: canvas.height };
		case "down":
			return { x: 0, y: -canvas.height };
	}
}

function incomingRamps({
	kind,
	direction,
	canvas,
	base,
}: {
	kind: TransitionKind;
	direction: TransitionDirection;
	canvas: TransitionCanvasSize;
	base: BaseVisuals;
}): Ramp[] {
	if (kind === "fade" || kind === "dip-black" || kind === "dip-white" || kind === "blur") {
		// Alpha kinds: the incoming clip fades in while the dip/blur pass
		// supplies the colour or softness ramp.
		return [{ path: "opacity", from: 0, to: 1 }];
	}
	if (kind === "wipe") {
		// The wipe's own shader reveals the incoming clip; an opacity ramp on
		// top would double-darken the seam.
		return [];
	}
	if (kind === "zoom") {
		return [
			{ path: "opacity", from: 0, to: 1 },
			{ path: "transform.scaleX", from: base.scaleX * ZOOM_START_SCALE, to: base.scaleX },
			{ path: "transform.scaleY", from: base.scaleY * ZOOM_START_SCALE, to: base.scaleY },
		];
	}
	// slide / push: the incoming clip travels in from `direction`'s opposite
	// side, fully opaque, and lands on its authored position.
	const offset = travelOffset({ direction, canvas });
	return [
		{ path: "transform.positionX", from: base.positionX + offset.x, to: base.positionX },
		{ path: "transform.positionY", from: base.positionY + offset.y, to: base.positionY },
	];
}

function outgoingRamps({
	kind,
	direction,
	canvas,
	base,
}: {
	kind: TransitionKind;
	direction: TransitionDirection;
	canvas: TransitionCanvasSize;
	base: BaseVisuals;
}): Ramp[] {
	// push: both layers travel together, so the outgoing clip leaves the frame
	// in the same direction the incoming clip arrives from.
	if (kind !== "push") return [];
	const offset = travelOffset({ direction, canvas });
	return [
		{ path: "transform.positionX", from: base.positionX, to: base.positionX - offset.x },
		{ path: "transform.positionY", from: base.positionY, to: base.positionY - offset.y },
	];
}

function key({
	id,
	time,
	value,
}: {
	id: string;
	time: number;
	value: number;
}): ScalarAnimationKey {
	return {
		id,
		time: roundMediaTime({ time }),
		value,
		segmentToNext: "linear",
		tangentMode: "auto",
	};
}

function rampChannel({
	idBase,
	ramp,
	startTicks,
	endTicks,
}: {
	idBase: string;
	ramp: Ramp;
	startTicks: number;
	endTicks: number;
}): ScalarChannel {
	return {
		keys: [
			key({ id: `${idBase}:0`, time: startTicks, value: ramp.from }),
			key({ id: `${idBase}:1`, time: endTicks, value: ramp.to }),
		],
		extrapolation: { before: "hold", after: "hold" },
	};
}

/** ONLY the transition's own channels (never the element's authored ones). */
function buildDerivedChannels({
	element,
	ramps,
	startTicks,
	endTicks,
}: {
	element: TimelineElement;
	ramps: Ramp[];
	startTicks: number;
	endTicks: number;
}): ElementAnimations | undefined {
	const existing = element.animations ?? {};
	let derived: ElementAnimations | undefined;
	for (const ramp of ramps) {
		if (existing[ramp.path]) continue; // user keyframes win — never clobber
		derived = derived ?? {};
		derived[ramp.path] = rampChannel({
			idBase: `${element.id}:transition:${ramp.path}`,
			ramp,
			startTicks,
			endTicks,
		});
	}
	return derived;
}

function mergeDerivedChannels({
	element,
	ramps,
	startTicks,
	endTicks,
}: {
	element: TimelineElement;
	ramps: Ramp[];
	startTicks: number;
	endTicks: number;
}): ElementAnimations | undefined {
	const derived = buildDerivedChannels({ element, ramps, startTicks, endTicks });
	return derived ? { ...element.animations, ...derived } : undefined;
}

function resolveTransition({
	window,
	element,
	canvasSize,
}: {
	window: TransitionWindowLike;
	element: TimelineElement;
	canvasSize: TransitionCanvasSize | undefined;
}): {
	kind: TransitionKind;
	direction: TransitionDirection;
	canvas: TransitionCanvasSize;
	base: BaseVisuals;
} {
	return {
		kind: normalizeTransitionKind(window.kind),
		direction: incomingDirection(window),
		canvas: canvasSize ?? { width: 0, height: 0 },
		base: readStaticVisuals(element),
	};
}

/**
 * The transition's channels for the INCOMING clip, without the element's own
 * animations. The exporter attaches these to the incoming clip's transition
 * HEAD (which starts at the window, exactly like the preview's element), not
 * to the base-sequence copy of the clip (which starts at the window END and
 * must play steady).
 */
export function deriveTransitionIncomingChannels({
	window,
	element,
	canvasSize,
}: {
	window: TransitionWindowLike;
	element: TimelineElement;
	canvasSize: TransitionCanvasSize | undefined;
}): ElementAnimations | undefined {
	if (!(window.durationTicks > 0)) return undefined;
	const resolved = resolveTransition({ window, element, canvasSize });
	return buildDerivedChannels({
		element,
		ramps: incomingRamps(resolved),
		startTicks: 0,
		endTicks: window.durationTicks,
	});
}

/**
 * The transition's channels for the OUTGOING clip (`push` only). Unlike the
 * incoming side these stay on the base-sequence clip: its last
 * `durationTicks` are exactly the transition window in both renderers.
 */
export function deriveTransitionOutgoingChannels({
	window,
	element,
	canvasSize,
}: {
	window: TransitionWindowLike;
	element: TimelineElement;
	canvasSize: TransitionCanvasSize | undefined;
}): ElementAnimations | undefined {
	if (!(window.durationTicks > 0)) return undefined;
	const resolved = resolveTransition({ window, element, canvasSize });
	return buildDerivedChannels({
		element,
		ramps: outgoingRamps(resolved),
		startTicks: Math.max(0, element.duration - window.durationTicks),
		endTicks: element.duration,
	});
}

/**
 * The derivation both renderers consume. Windows must be the compressed
 * timeline's (see `computeMainTrackPlacements`): the window starts exactly at
 * the incoming clip's element-local zero and ends exactly at the outgoing
 * clip's element-local `duration`.
 *
 * Returns only elements whose animations changed, so callers can keep object
 * identity for everything else.
 */
export function deriveTransitionAnimations({
	windows,
	elements,
	canvasSize,
}: {
	windows: readonly TransitionWindowLike[];
	elements: readonly TimelineElement[];
	canvasSize: TransitionCanvasSize | undefined;
}): Map<string, ElementAnimations> {
	const out = new Map<string, ElementAnimations>();
	if (windows.length === 0) return out;
	const byId = new Map(elements.map((element) => [element.id, element]));
	// Without a canvas there is no pixel offset to travel; scale/opacity kinds
	// still derive exactly, and translated kinds degrade to a cut. Callers that
	// RENDER always have a canvas (the preview passes the project's).
	const canvas = canvasSize ?? { width: 0, height: 0 };

	for (const window of windows) {
		if (!(window.durationTicks > 0)) continue;
		const kind = normalizeTransitionKind(window.kind);
		const incoming = byId.get(window.incomingElementId);
		const outgoing = byId.get(window.outgoingElementId);
		if (!incoming || !outgoing) continue;

		const incomingDerived = mergeDerivedChannels({
			element: incoming,
			ramps: incomingRamps({
				kind,
				direction: incomingDirection(window),
				canvas,
				base: readStaticVisuals(incoming),
			}),
			startTicks: 0,
			endTicks: window.durationTicks,
		});
		if (incomingDerived) out.set(incoming.id, incomingDerived);

		const outgoingDerived = mergeDerivedChannels({
			element: outgoing,
			ramps: outgoingRamps({
				kind,
				direction: incomingDirection(window),
				canvas,
				base: readStaticVisuals(outgoing),
			}),
			startTicks: Math.max(0, outgoing.duration - window.durationTicks),
			endTicks: outgoing.duration,
		});
		if (outgoingDerived) out.set(outgoing.id, outgoingDerived);
	}
	return out;
}

/** Windows carry their own normalised direction (`TransitionWindow` field). */
function incomingDirection(window: TransitionWindowLike): TransitionDirection {
	return normalizeTransitionDirection({
		kind: normalizeTransitionKind(window.kind),
		raw: window.direction,
	});
}

/**
 * Per-element additions a `wipe` / `dip-*` / `blur` window needs beyond the
 * plain animation ramps `deriveTransitionAnimations` produces:
 *
 *  - `effects`: a derived effect instance on the element (NEVER persisted —
 *    `applyTransitionsToSceneTracks` adds it to the render-only element),
 *  - `animations`: the effect's animated parameter channels, in the same
 *    effect-param path space user keyframes use (`effects.<id>.params.<key>`).
 *
 * The Android exporter derives the same passes natively from the EDL window
 * (kind + direction + timing), so nothing extra has to travel in the EDL.
 */
export interface DerivedTransitionExtras {
	effects: Effect[];
	animations?: ElementAnimations;
}

function effectChannel({
	effectId,
	paramKey,
	keys,
}: {
	effectId: string;
	paramKey: string;
	keys: Array<{ time: number; value: number }>;
}): ScalarChannel {
	return {
		keys: keys.map((entry, index) =>
			key({
				id: `${effectId}:${paramKey}:${index}`,
				time: entry.time,
				value: entry.value,
			}),
		),
		extrapolation: { before: "hold", after: "hold" },
	};
}

function effectParamPath({
	effectId,
	paramKey,
}: {
	effectId: string;
	paramKey: string;
}): string {
	return `effects.${effectId}.params.${paramKey}`;
}

function addEffect({
	map,
	elementId,
	effect,
	channels,
}: {
	map: Map<string, DerivedTransitionExtras>;
	elementId: string;
	effect: Effect;
	channels: ElementAnimations;
}): void {
	const existing = map.get(elementId) ?? { effects: [] };
	if (existing.effects.some((candidate) => candidate.id === effect.id)) return;
	existing.effects = [...existing.effects, effect];
	existing.animations = { ...existing.animations, ...channels };
	map.set(elementId, existing);
}

export function deriveTransitionExtras({
	windows,
	elements,
}: {
	windows: readonly TransitionWindowLike[];
	elements: readonly TimelineElement[];
}): Map<string, DerivedTransitionExtras> {
	const out = new Map<string, DerivedTransitionExtras>();
	const byId = new Map(elements.map((element) => [element.id, element]));

	for (const window of windows) {
		if (!(window.durationTicks > 0)) continue;
		const kind = normalizeTransitionKind(window.kind);
		const definition = TRANSITION_DEFINITIONS[kind];
		const incoming = byId.get(window.incomingElementId);
		const outgoing = byId.get(window.outgoingElementId);
		if (!incoming || !outgoing) continue;

		const duration = window.durationTicks;
		const midpoint = duration / 2;

		if (definition.visual === "wipe") {
			const effectId = transitionEffectId({ elementId: incoming.id, kind });
			const [directionX, directionY] = transitionDirectionVector({
				direction: incomingDirection(window),
			});
			addEffect({
				map: out,
				elementId: incoming.id,
				effect: {
					id: effectId,
					type: TRANSITION_WIPE_EFFECT_TYPE,
					enabled: true,
					params: {
						progress: 0,
						directionX,
						directionY,
						softness: TRANSITION_WIPE_SOFTNESS,
					},
				},
				channels: {
					[effectParamPath({ effectId, paramKey: "progress" })]: effectChannel({
						effectId,
						paramKey: "progress",
						keys: [
							{ time: 0, value: 0 },
							{ time: duration, value: 1 },
						],
					}),
				},
			});
			continue;
		}

		if (definition.visual === "dip") {
			const [red, green, blue] = definition.dipColour ?? [0, 0, 0];
			const white = red === 1 && green === 1 && blue === 1 ? 1 : 0;
			// Outgoing: colour ramps INTO the dip colour across the first half.
			const outgoingId = transitionEffectId({ elementId: outgoing.id, kind });
			const outgoingStart = Math.max(0, outgoing.duration - duration);
			addEffect({
				map: out,
				elementId: outgoing.id,
				effect: {
					id: outgoingId,
					type: TRANSITION_DIP_EFFECT_TYPE,
					enabled: true,
					params: { amount: 0, white },
				},
				channels: {
					[effectParamPath({ effectId: outgoingId, paramKey: "amount" })]:
						effectChannel({
							effectId: outgoingId,
							paramKey: "amount",
							keys: [
								{ time: outgoingStart, value: 0 },
								{ time: outgoingStart + midpoint, value: 1 },
							],
						}),
				},
			});
			// Incoming: fully dipped until the midpoint, then resolves to normal.
			const incomingId = transitionEffectId({ elementId: incoming.id, kind });
			addEffect({
				map: out,
				elementId: incoming.id,
				effect: {
					id: incomingId,
					type: TRANSITION_DIP_EFFECT_TYPE,
					enabled: true,
					params: { amount: 1, white },
				},
				channels: {
					[effectParamPath({ effectId: incomingId, paramKey: "amount" })]:
						effectChannel({
							effectId: incomingId,
							paramKey: "amount",
							keys: [
								{ time: 0, value: 1 },
								{ time: midpoint, value: 1 },
								{ time: duration, value: 0 },
							],
						}),
				},
			});
			continue;
		}

		if (definition.visual === "blur") {
			// The incoming clip resolves from the project's blur effect. It is
			// cross-faded in (opacity ramp from `incomingRamps`), so the base
			// stays sharp and only the arriving clip softens in.
			const effectId = transitionEffectId({ elementId: incoming.id, kind });
			addEffect({
				map: out,
				elementId: incoming.id,
				effect: {
					id: effectId,
					type: "blur",
					enabled: true,
					params: { intensity: TRANSITION_BLUR_INTENSITY },
				},
				channels: {
					[effectParamPath({ effectId, paramKey: "intensity" })]: effectChannel({
						effectId,
						paramKey: "intensity",
						keys: [
							{ time: 0, value: TRANSITION_BLUR_INTENSITY },
							{ time: duration, value: 0 },
						],
					}),
				},
			});
		}
	}

	return out;
}
