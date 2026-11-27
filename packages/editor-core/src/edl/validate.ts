import { rationalToNumber, scaleTicks } from "./rational";
import {
	EDL_VERSION,
	type Edl,
	type EdlClip,
	type EdlTrack,
} from "./types";

/**
 * `validateEdl()` — plan §2.3 rule 2: the preview renderer and the native
 * exporters must be provable to read the same graph, so the same checker runs
 * on both sides of the bridge.
 *
 * It is a CHECKER, not a parser: it takes an already-parsed document and
 * reports everything wrong with it, rather than throwing on the first problem.
 * A native mapper that finds an error here should refuse the export; a warning
 * means "v1 cannot represent this faithfully" and the host decides.
 */

export interface EdlValidationIssue {
	/** JSON-pointer-ish path to the offending value, e.g. "tracks[2].clips[0]". */
	path: string;
	message: string;
}

export interface EdlValidationResult {
	ok: boolean;
	errors: EdlValidationIssue[];
	warnings: EdlValidationIssue[];
}

export interface ValidateEdlOptions {
	/**
	 * Strict mode is what a NATIVE EXPORTER should use. It additionally requires
	 * that every asset referenced by a media clip has a real `sourceUri` — a
	 * document that is structurally perfect but has `sourceUri: null` everywhere
	 * is fine for the preview renderer and useless to AVFoundation/Media3.
	 */
	strict?: boolean;
}

/**
 * Effects a v1 native mapper is expected to implement (plan §2.3 rule 4).
 *
 * GitHub #48 / PAV-142: these are the two effect TYPES the editor actually
 * produces (`adjust` with its seven sliders, `filter` with preset +
 * intensity) — the previous list enumerated individual slider names, which
 * never appear as an effect type, so every VALID document warned. Android
 * maps both through `export/ColorGrade.kt` (affine subset; `sharpen` and
 * `vignette` are refused loudly rather than dropped) and iOS maps `adjust`
 * through `VideoCompositionBuilder`'s `AdjustSettings`.
 *
 * Anything not on this list (e.g. `blur`, or a future effect) must still
 * warn: a mapper is expected to REFUSE it, never to export as if it were
 * absent.
 */
export const EDL_V1_SUPPORTED_EFFECT_TYPES: readonly string[] = ["adjust", "filter"];

/**
 * Mask shapes the native exporters map. The preview registry also has heart,
 * diamond, star, text, cinematic-bars and freeform masks; those are NOT
 * silently dropped on export — they are rejected below so a project never
 * ships with a mask the preview shows and the MP4 does not.
 *
 * `linear` is the user-facing name for the engine's `split` mask; both parse
 * to the same half-plane math (`mask.wgsl` / `EdlMaskEffect`). A `circle` is
 * an ellipse whose two axes are equal, accepted as its own type so the UI and
 * fixtures can name it directly.
 */
export const EDL_V1_SUPPORTED_MASK_TYPES: readonly string[] = [
	"rectangle",
	"circle",
	"ellipse",
	"split",
	"linear",
];

/** Mirrors `MAX_FEATHER` in `masks/feather.ts`. */
const MAX_MASK_FEATHER = 1000;

function maskNumber({
	params,
	key,
}: {
	params: Record<string, unknown>;
	key: string;
}): number | null {
	const value = params[key];
	if (value === undefined) return null;
	return isFiniteNumber(value) ? value : null;
}

function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

class Issues {
	readonly errors: EdlValidationIssue[] = [];
	readonly warnings: EdlValidationIssue[] = [];

	error({ path, message }: EdlValidationIssue): void {
		this.errors.push({ path, message });
	}

	warn({ path, message }: EdlValidationIssue): void {
		this.warnings.push({ path, message });
	}

	/** The workhorse: assert an integer tick count. */
	ticks({
		path,
		value,
		allowNegative = false,
	}: {
		path: string;
		value: unknown;
		allowNegative?: boolean;
	}): void {
		if (!isInt(value)) {
			this.error({
				path,
				message: `expected an integer tick count, got ${JSON.stringify(value)}. EDL carries integer ticks only — never float seconds (plan §2.3 rule 1).`,
			});
			return;
		}
		if (!allowNegative && value < 0) {
			this.error({ path, message: `tick count must be >= 0, got ${value}` });
		}
	}

	rational({ path, value }: { path: string; value: unknown }): void {
		if (
			typeof value !== "object" ||
			value === null ||
			!("numerator" in value) ||
			!("denominator" in value)
		) {
			this.error({ path, message: "expected {numerator, denominator}" });
			return;
		}
		const r: { numerator: unknown; denominator: unknown } = value;
		if (!isInt(r.numerator) || !isInt(r.denominator)) {
			this.error({
				path,
				message: `rational must be a pair of integers, got ${JSON.stringify(r)}. A float rate here is a drift bug in every long export.`,
			});
			return;
		}
		if (r.denominator <= 0) {
			this.error({ path, message: `denominator must be > 0, got ${r.denominator}` });
		}
		if (r.numerator <= 0) {
			this.error({ path, message: `numerator must be > 0, got ${r.numerator}` });
		}
	}
}

function validateClip({
	clip,
	path,
	issues,
	assetIds,
	strict,
	assetsWithUri,
}: {
	clip: EdlClip;
	path: string;
	issues: Issues;
	assetIds: Set<string>;
	strict: boolean;
	assetsWithUri: Set<string>;
}): void {
	if (!clip.clipId) issues.error({ path: `${path}.clipId`, message: "required" });

	issues.ticks({ path: `${path}.startTicks`, value: clip.startTicks });
	issues.ticks({ path: `${path}.durationTicks`, value: clip.durationTicks });
	issues.ticks({ path: `${path}.sourceStartTicks`, value: clip.sourceStartTicks });
	issues.ticks({ path: `${path}.sourceEndTicks`, value: clip.sourceEndTicks });
	issues.ticks({ path: `${path}.trimEndTicks`, value: clip.trimEndTicks });
	issues.rational({ path: `${path}.speed`, value: clip.speed });

	if (isInt(clip.durationTicks) && clip.durationTicks <= 0) {
		issues.error({
			path: `${path}.durationTicks`,
			message: `a clip must occupy at least one tick, got ${clip.durationTicks}`,
		});
	}

	// The invariant that keeps preview and export on the same frame: the source
	// span must be exactly `durationTicks * speed`, in the same rounding mode the
	// engine used. One tick of slack absorbs the engine's own rounding.
	if (
		isInt(clip.durationTicks) &&
		isInt(clip.sourceStartTicks) &&
		isInt(clip.sourceEndTicks) &&
		isInt(clip.speed?.numerator) &&
		isInt(clip.speed?.denominator) &&
		clip.speed.denominator > 0
	) {
		const expected =
			clip.sourceStartTicks +
			scaleTicks({ ticks: clip.durationTicks, rate: clip.speed });
		if (Math.abs(expected - clip.sourceEndTicks) > 1) {
			issues.error({
				path: `${path}.sourceEndTicks`,
				message:
					`inconsistent with durationTicks x speed: expected ~${expected}, got ${clip.sourceEndTicks}. ` +
					"Preview and native export would read different source frames.",
			});
		}
	}

	// Audio fade envelope: present only on faded clips, and never longer than
	// the clip itself (one tick of slack for the engine's own rounding after
	// the proportional clamp in `timeline/audio-fades.ts`).
	if (clip.audioFade) {
		const { inTicks, outTicks } = clip.audioFade;
		if (!isInt(inTicks) || inTicks < 0 || !isInt(outTicks) || outTicks < 0) {
			issues.error({
				path: `${path}.audioFade`,
				message: `expected non-negative integer inTicks/outTicks, got ${JSON.stringify(clip.audioFade)}`,
			});
		} else if (
			isInt(clip.durationTicks) &&
			inTicks + outTicks > clip.durationTicks + 1
		) {
			issues.error({
				path: `${path}.audioFade`,
				message:
					`fade lengths (${inTicks} + ${outTicks}) exceed the clip's duration (${clip.durationTicks}); ` +
					"the exporter would ramp past the end of the audio.",
			});
		}
	}

	const needsAsset =
		clip.kind === "video" || clip.kind === "image" || clip.kind === "audio";
	if (needsAsset) {
		if (!clip.assetId) {
			issues.error({
				path: `${path}.assetId`,
				message: `a "${clip.kind}" clip must reference an asset`,
			});
		} else if (!assetIds.has(clip.assetId)) {
			issues.error({
				path: `${path}.assetId`,
				message: `references unknown asset "${clip.assetId}"`,
			});
		} else if (strict && !assetsWithUri.has(clip.assetId)) {
			issues.error({
				path: `${path}.assetId`,
				message:
					`asset "${clip.assetId}" has no sourceUri. A native exporter needs a real ` +
					"file handle — wire buildEdl's resolveAsset hook (plan §2.6, M4 media custody).",
			});
		}
	} else if (clip.assetId) {
		issues.warn({
			path: `${path}.assetId`,
			message: `a "${clip.kind}" clip carries an assetId; generated content should not reference source media`,
		});
	}

	if (!isFiniteNumber(clip.opacity) || clip.opacity < 0 || clip.opacity > 1) {
		issues.error({
			path: `${path}.opacity`,
			message: `expected 0..1, got ${JSON.stringify(clip.opacity)}`,
		});
	}

	for (const [i, effect] of clip.effects.entries()) {
		if (!EDL_V1_SUPPORTED_EFFECT_TYPES.includes(effect.type)) {
			issues.warn({
				path: `${path}.effects[${i}]`,
				message:
					`effect "${effect.type}" is not on the v1 native list. Plan §2.3 rule 3 requires a ` +
					"golden-frame test per effect; anything that cannot pass is cut from v1 rather than shipped inconsistent.",
			});
		}
	}

	for (const [mi, mask] of clip.masks.entries()) {
		const maskPath = `${path}.masks[${mi}]`;
		if (typeof mask.maskId !== "string" || mask.maskId.length === 0) {
			issues.error({
				path: `${maskPath}.maskId`,
				message: "expected a non-empty mask id",
			});
		}
		if (!EDL_V1_SUPPORTED_MASK_TYPES.includes(mask.type)) {
			issues.error({
				path: `${maskPath}.type`,
				message:
					`mask type "${mask.type}" is not mapped natively. Supported: ` +
					`${EDL_V1_SUPPORTED_MASK_TYPES.join(", ")}. Export refuses rather than dropping it.`,
			});
			continue;
		}

		const params = mask.params ?? {};
		const isShape = mask.type !== "split" && mask.type !== "linear";

		for (const key of ["centerX", "centerY"] as const) {
			const value = maskNumber({ params, key });
			if (value === null || Math.abs(value) > 10) {
				issues.error({
					path: `${maskPath}.params.${key}`,
					message: `expected a finite normalised offset in -10..10, got ${JSON.stringify(params[key])}`,
				});
			}
		}

		const rotation = maskNumber({ params, key: "rotation" });
		if (rotation === null || Math.abs(rotation) > 3600) {
			issues.error({
				path: `${maskPath}.params.rotation`,
				message: `expected finite degrees, got ${JSON.stringify(params.rotation)}`,
			});
		}

		const feather = maskNumber({ params, key: "feather" });
		if (feather === null || feather < 0 || feather > MAX_MASK_FEATHER) {
			issues.error({
				path: `${maskPath}.params.feather`,
				message: `expected 0..${MAX_MASK_FEATHER}px, got ${JSON.stringify(params.feather)}`,
			});
		}

		if (params.inverted !== undefined && typeof params.inverted !== "boolean") {
			issues.error({
				path: `${maskPath}.params.inverted`,
				message: "expected a boolean",
			});
		}

		// Strokes are a preview-only decoration today; exporting one would
		// require a second native pass, so refuse it explicitly instead of
		// silently omitting it from the MP4.
		const strokeWidth = maskNumber({ params, key: "strokeWidth" });
		if (strokeWidth !== null && strokeWidth > 0) {
			issues.error({
				path: `${maskPath}.params.strokeWidth`,
				message: "mask strokes are preview-only; native export does not draw them",
			});
		}

		if (isShape) {
			const keys = mask.type === "circle" ? (["width"] as const) : (["width", "height"] as const);
			for (const key of keys) {
				const value = maskNumber({ params, key });
				if (value === null || value <= 0 || value > 10) {
					issues.error({
						path: `${maskPath}.params.${key}`,
						message: `expected a positive normalised size in 0..10, got ${JSON.stringify(params[key])}`,
					});
				}
			}
		}
	}

	for (const [ci, channel] of clip.animations.entries()) {
		for (const [ki, key] of channel.keyframes.entries()) {
			issues.ticks({
				path: `${path}.animations[${ci}].keyframes[${ki}].timeTicks`,
				value: key.timeTicks,
			});
			if (key.leftHandle) {
				issues.ticks({
					path: `${path}.animations[${ci}].keyframes[${ki}].leftHandle.dtTicks`,
					value: key.leftHandle.dtTicks,
					allowNegative: true,
				});
			}
			if (key.rightHandle) {
				issues.ticks({
					path: `${path}.animations[${ci}].keyframes[${ki}].rightHandle.dtTicks`,
					value: key.rightHandle.dtTicks,
					allowNegative: true,
				});
			}
		}
	}
}

export function validateEdl({
	edl,
	options = {},
}: {
	edl: Edl;
	options?: ValidateEdlOptions;
}): EdlValidationResult {
	const strict = options.strict === true;
	const issues = new Issues();

	// --- meta ---------------------------------------------------------------
	if (edl?.meta?.edlVersion !== EDL_VERSION) {
		issues.error({
			path: "meta.edlVersion",
			message: `unsupported EDL version ${JSON.stringify(edl?.meta?.edlVersion)}; this build understands v${EDL_VERSION}`,
		});
		// Everything below assumes v1 field names, so stop here.
		return { ok: false, errors: issues.errors, warnings: issues.warnings };
	}

	if (!isInt(edl.meta.ticksPerSecond) || edl.meta.ticksPerSecond <= 0) {
		issues.error({
			path: "meta.ticksPerSecond",
			message: `expected a positive integer, got ${JSON.stringify(edl.meta.ticksPerSecond)}`,
		});
	}
	issues.rational({ path: "meta.frameRate", value: edl.meta.frameRate });
	issues.ticks({ path: "meta.durationTicks", value: edl.meta.durationTicks });

	if (
		!isInt(edl.meta.canvas?.width) ||
		!isInt(edl.meta.canvas?.height) ||
		edl.meta.canvas.width <= 0 ||
		edl.meta.canvas.height <= 0
	) {
		issues.error({
			path: "meta.canvas",
			message: `expected positive integer width/height, got ${JSON.stringify(edl.meta.canvas)}`,
		});
	}

	// --- assets -------------------------------------------------------------
	const assetIds = new Set<string>();
	const assetsWithUri = new Set<string>();
	for (const [i, asset] of (edl.assets ?? []).entries()) {
		if (assetIds.has(asset.assetId)) {
			issues.error({
				path: `assets[${i}].assetId`,
				message: `duplicate asset id "${asset.assetId}"`,
			});
		}
		assetIds.add(asset.assetId);

		if (asset.durationTicks !== null) {
			issues.ticks({ path: `assets[${i}].durationTicks`, value: asset.durationTicks });
		}
		if (asset.sourceUri) {
			if (asset.sourceUri.startsWith("blob:")) {
				issues.error({
					path: `assets[${i}].sourceUri`,
					message:
						'a blob: URL is meaningless to a native exporter. Media stays in the native sandbox and crosses the bridge as a URI, never as bytes (plan §2.2).',
				});
			} else {
				assetsWithUri.add(asset.assetId);
			}
		}
		if (![0, 90, 180, 270].includes(asset.rotationDegrees)) {
			issues.error({
				path: `assets[${i}].rotationDegrees`,
				message: `expected 0/90/180/270, got ${JSON.stringify(asset.rotationDegrees)}`,
			});
		}
	}

	// --- tracks -------------------------------------------------------------
	const trackIds = new Set<string>();
	const clipIndex = new Map<string, { track: EdlTrack; clip: EdlClip }>();
	const zIndices: number[] = [];
	let mainTrackCount = 0;

	for (const [ti, track] of (edl.tracks ?? []).entries()) {
		const path = `tracks[${ti}]`;
		if (trackIds.has(track.trackId)) {
			issues.error({ path: `${path}.trackId`, message: `duplicate track id "${track.trackId}"` });
		}
		trackIds.add(track.trackId);

		if (track.kind === "main") mainTrackCount++;

		if (track.kind === "audio") {
			if (track.zIndex !== null) {
				issues.error({
					path: `${path}.zIndex`,
					message: "audio tracks are not composited and must carry zIndex: null",
				});
			}
		} else if (!isInt(track.zIndex)) {
			issues.error({
				path: `${path}.zIndex`,
				message: `composited tracks need an integer zIndex, got ${JSON.stringify(track.zIndex)}`,
			});
		} else {
			zIndices.push(track.zIndex);
		}

		for (const [ci, clip] of track.clips.entries()) {
			if (clipIndex.has(clip.clipId)) {
				issues.error({
					path: `${path}.clips[${ci}].clipId`,
					message: `duplicate clip id "${clip.clipId}"`,
				});
			}
			clipIndex.set(clip.clipId, { track, clip });
			validateClip({
				clip,
				path: `${path}.clips[${ci}]`,
				issues,
				assetIds,
				strict,
				assetsWithUri,
			});
		}
	}

	if (mainTrackCount !== 1) {
		issues.error({
			path: "tracks",
			message: `expected exactly one track with kind "main", found ${mainTrackCount}`,
		});
	}

	// z-order must be a dense 0..n-1 permutation, so "paint in ascending zIndex"
	// is unambiguous for a mapper.
	const sortedZ = [...zIndices].sort((a, b) => a - b);
	for (let i = 0; i < sortedZ.length; i++) {
		if (sortedZ[i] !== i) {
			issues.error({
				path: "tracks[].zIndex",
				message: `composited zIndex values must be a dense 0..${sortedZ.length - 1} range, got [${sortedZ.join(", ")}]`,
			});
			break;
		}
	}

	// --- overlays: derived view, must agree with tracks ---------------------
	for (const [i, overlay] of (edl.overlays ?? []).entries()) {
		const found = clipIndex.get(overlay.clipId);
		if (!found) {
			issues.error({
				path: `overlays[${i}].clipId`,
				message: `references unknown clip "${overlay.clipId}"; overlays[] is a derived view of tracks[]`,
			});
			continue;
		}
		if (found.track.trackId !== overlay.trackId) {
			issues.error({
				path: `overlays[${i}].trackId`,
				message: `says "${overlay.trackId}" but clip "${overlay.clipId}" lives on "${found.track.trackId}"`,
			});
		}
		if (
			overlay.startTicks !== found.clip.startTicks ||
			overlay.durationTicks !== found.clip.durationTicks
		) {
			issues.error({
				path: `overlays[${i}]`,
				message:
					`timing disagrees with tracks[]: overlay ${overlay.startTicks}+${overlay.durationTicks} ` +
					`vs clip ${found.clip.startTicks}+${found.clip.durationTicks}`,
			});
		}
		if (overlay.zIndex !== found.track.zIndex) {
			issues.error({
				path: `overlays[${i}].zIndex`,
				message: `says ${overlay.zIndex} but its track has zIndex ${found.track.zIndex}`,
			});
		}
	}

	// --- transitions --------------------------------------------------------
	const mainTrack = (edl.tracks ?? []).find((t) => t.kind === "main");
	for (const [i, transition] of (edl.transitions ?? []).entries()) {
		issues.ticks({
			path: `transitions[${i}].durationTicks`,
			value: transition.durationTicks,
		});
		const found = clipIndex.get(transition.afterClipId);
		if (!found) {
			issues.error({
				path: `transitions[${i}].afterClipId`,
				message: `references unknown clip "${transition.afterClipId}"`,
			});
		} else if (!mainTrack || found.track.trackId !== mainTrack.trackId) {
			issues.error({
				path: `transitions[${i}].afterClipId`,
				message:
					"transitions are main-track only in v1 (matching CapCut), but this clip is on an overlay/audio track",
			});
		}
	}

	// --- output -------------------------------------------------------------
	issues.rational({ path: "output.fps", value: edl.output?.fps });
	if (!isInt(edl.output?.bitrate) || edl.output.bitrate <= 0) {
		issues.error({
			path: "output.bitrate",
			message: `expected a positive integer bits-per-second, got ${JSON.stringify(edl.output?.bitrate)}`,
		});
	}
	if (edl.output?.container !== "mp4" && edl.output?.container !== "webm") {
		issues.error({
			path: "output.container",
			message: `expected "mp4" or "webm", got ${JSON.stringify(edl.output?.container)}`,
		});
	}
	if (
		edl.meta.edlVersion === EDL_VERSION &&
		edl.output?.fps &&
		isInt(edl.output.fps.numerator) &&
		isInt(edl.output.fps.denominator) &&
		edl.output.fps.denominator > 0 &&
		rationalToNumber(edl.output.fps) > 240
	) {
		issues.warn({
			path: "output.fps",
			message: `${rationalToNumber(edl.output.fps)} fps is above anything a phone encoder will accept`,
		});
	}

	return {
		ok: issues.errors.length === 0,
		errors: issues.errors,
		warnings: issues.warnings,
	};
}

/** Convenience for call sites that just want to fail loudly. */
export function assertValidEdl({
	edl,
	options,
}: {
	edl: Edl;
	options?: ValidateEdlOptions;
}): void {
	const result = validateEdl({ edl, options });
	if (result.ok) return;
	const detail = result.errors
		.map((issue) => `  ${issue.path}: ${issue.message}`)
		.join("\n");
	throw new Error(`Invalid EDL v1:\n${detail}`);
}
