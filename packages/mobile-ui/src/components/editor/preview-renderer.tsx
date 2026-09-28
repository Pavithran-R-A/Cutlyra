/**
 * Live preview rendering for the mobile editor — closes the "chrome-only
 * placeholder, does not render frame content" gap PreviewStage's own header
 * disclosed (and the founder hit on device: playback ran over a black
 * preview, 2026-08-18).
 *
 * Same architecture as apps/web's preview (apps/web/src/preview/components/
 * index.tsx, RenderTreeController + PreviewCanvas), deliberately minus the
 * web-only chrome (zoom/pan viewport, overlay handles, context menus):
 *   1. a scene-sync effect maps live engine state -> buildScene() ->
 *      editor.renderer.setRenderTree()
 *   2. a CanvasRenderer draws the tree into its output canvas (wgpu/wasm
 *      compositor underneath — WebGPU preferred, WebGL2 fallback)
 *   3. a rAF loop renders the frame under the playhead, skipping when
 *      neither the frame index nor the tree changed (same guard as web).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	NO_SNAP,
	SNAP_CAPTURE_PX,
	SNAP_RELEASE_PX,
	pulseSnapHaptic,
	snapToCenterAxes,
	type AxisSnapFlags,
} from "../../editor/axis-snap";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { TICKS_PER_SECOND, type MediaTime } from "@cutlyra/editor-core";
import { useEditor } from "@cutlyra/editor-core/react";
import { isVisualElement, type TimelineElement } from "@cutlyra/editor-core/timeline";
import type { ParamValues } from "@cutlyra/editor-core/params";
import {
	clipLocalTime,
	hasClipKeyframes,
	resolveClipValuesAtTime,
	snapLocalTimeToFrame,
	upsertClipAnimationValues,
	type ClipKeyframeValues,
} from "../../editor/keyframes";
import { useSelectedElement } from "../../editor/use-live-editor";
import { CanvasRenderer } from "@cutlyra/editor-core/services/renderer/canvas-renderer";
import { buildScene } from "@cutlyra/editor-core/services/renderer/scene-builder";
import type { RootNode } from "@cutlyra/editor-core/services/renderer/nodes/root-node";
import { initializeGpu } from "opencut-wasm";

/**
 * Stage 11 physical QA (iQOO I2221 / Android 16, Chrome WebView 152.0.7977.88,
 * Adreno 735): the WebView ACQUIRES WebGPU fine but WebGPU canvas
 * PRESENTATION is unreliable-to-broken — measured live across sessions:
 * minimal one-pass clears read back alpha=0 through `toDataURL()` in some
 * sessions, and — decisive — even in a session where a RAW-API probe canvas
 * presents correctly (r=255), the app's wgpu-configured compositor canvas
 * still read back alpha=0 (wgpu surface configure + the device's format
 * mismatch warning path fails to present). The engine's WebGPU path is fine
 * on desktop/iOS (offscreen renders + thumbnails carry real pixels
 * everywhere); only Android WebView presentation is affected.
 *
 * wgpu's `acquire_device` only falls back to WebGL when device ACQUISITION
 * fails — which it doesn't here — so the proven GL path never engages on
 * its own. Fix at this layer, two parts:
 *  1. ANDROID (userAgent class, deterministic): skip WebGPU entirely —
 *     hide `navigator.gpu` so wgpu's `new_instance_with_webgpu_detection`
 *     routes onto its existing WebGL2 fallback, the backend verified to
 *     present on this device (GL clear read back r=85/a=255 live).
 *     A probe cannot be trusted here: it tests raw-API presentation, not
 *     wgpu's own surface configuration, which is exactly what fails.
 *  2. NON-ANDROID (desktop dev harness, future iOS WebGPU): keep the
 *     one-time presentation probe below — it catches a wholesale broken
 *     WebGPU there without cost when healthy (one 64×64 clear + readback).
 * The probe canvas is never attached to the DOM; result is memoized.
 */
type NavWithWebGpu = Navigator & {
	gpu?: {
		requestAdapter: () => Promise<{
			requestDevice: () => Promise<{
				createCommandEncoder: () => {
					beginRenderPass: (desc: unknown) => { end: () => void };
					finish: () => unknown;
				};
				queue: {
					submit: (cmd: unknown[]) => void;
					onSubmittedWorkDone: () => Promise<void>;
				};
			}>;
		}> | null;
		getPreferredCanvasFormat: () => string;
	};
};

async function probeWebGpuPresentation(): Promise<boolean> {
	const nav = navigator as NavWithWebGpu;
	if (!nav.gpu) return false;
	// Android WebView class: bypass entirely (see the doc comment above —
	// a raw-API probe cannot detect wgpu's surface-configure presentation
	// failure, which is the failure this device actually has).
	if (/Android/.test(navigator.userAgent)) return false;
	try {
		const adapter = await nav.gpu.requestAdapter();
		if (!adapter) return false;
		const device = await adapter.requestDevice();
		const canvas = document.createElement("canvas");
		canvas.width = 64;
		canvas.height = 64;
		// Runtime shape check: a real GPUCanvasContext, not a 2D/webgl one.
		const context = canvas.getContext("webgpu") as {
			configure: (config: {
				device: unknown;
				format: string;
				alphaMode: string;
			}) => void;
			getCurrentTexture: () => { createView: () => unknown };
		} | null;
		if (!context || typeof context.configure !== "function") return false;
		context.configure({
			device,
			format: nav.gpu.getPreferredCanvasFormat(),
			alphaMode: "opaque",
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: context.getCurrentTexture().createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 1, g: 0, b: 0, a: 1 },
				},
			],
		});
		pass.end();
		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();
		// Readback MUST go through toDataURL (the compositor path): on the
		// broken WebView, createImageBitmap(canvas) reads the GPU texture
		// DIRECTLY and sees the frame even though presentation produces
		// nothing — measured live. toDataURL is exactly the path that
		// returns alpha=0 there, so it is the honest detector.
		const dataUrl = canvas.toDataURL("image/png");
		const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
		const readback = new OffscreenCanvas(1, 1);
		const ctx2d = readback.getContext("2d");
		if (!ctx2d) return false;
		ctx2d.drawImage(bitmap, 0, 0, 1, 1);
		const { data } = ctx2d.getImageData(0, 0, 1, 1);
		// A presenting canvas read back through the compositor must show the
		// clear color's channel (red=255). alpha=0 / rgb=0 means the frame
		// never reached the canvas's presentation buffer.
		return data[0] > 0;
	} catch {
		// Any probe failure (adapter rejected, device lost, readback blocked)
		// leaves WebGPU enabled: the engine's own error handling applies.
		return true;
	}
}
/** Same contract as apps/web's `initializeGpuRenderer()`: init once per
 *  process, NEVER reject — a GPU-less environment degrades (the compositor
 *  falls back off the wgpu path) instead of crashing. Constructing
 *  `CanvasRenderer` before this resolves was CRITICAL finding #1 of the
 *  2026-08-18 test sweep: `initializeGpu()` had never been called on the
 *  mobile shell, the first render threw "GPU context not initialized"
 *  inside React render, and the entire app unmounted to a black screen. */
let gpuInitPromise: Promise<boolean> | null = null;
export function ensurePreviewGpu(): Promise<boolean> {
	return ensureGpu();
}
function ensureGpu(): Promise<boolean> {
	if (!gpuInitPromise) {
		gpuInitPromise = probeWebGpuPresentation()
			.then((presents) => {
				if (!presents) {
					// This WebView acquires WebGPU but presents every WebGPU
					// canvas transparent/black (measured: see the probe's doc
					// comment). Hiding navigator.gpu routes wgpu's
					// `new_instance_with_webgpu_detection` onto its existing
					// WebGL2 fallback — the backend that actually presents
					// on this device. The compositor canvas swap this
					// triggers (initCompositor's gl_canvas reuse branch) is
					// the WebGL path the codebase already ships and tests.
					delete (navigator as { gpu?: unknown }).gpu;
					console.warn(
						"WebGPU canvas presentation broken on this WebView — using WebGL2 renderer",
					);
				}
			})
			// The probe's own failures leave WebGPU enabled (probe contract);
			// a probe REJECTION still must not reject the init chain.
			.catch(() => undefined)
			.then(() => initializeGpu())
			.then(() => true)
			.catch((error: unknown) => {
				console.warn(
					`GPU renderer unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			});
	}
	return gpuInitPromise;
}

export function PreviewRenderer() {
	const editor = useEditor();
	const [gpuReady, setGpuReady] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void ensureGpu().then((ok) => {
			if (cancelled) return;
			editor.renderer.setDegraded(!ok);
			setGpuReady(true);
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- editor is the process singleton.
	}, []);

	if (!gpuReady) return null;
	return <PreviewRendererInner />;
}

function PreviewRendererInner() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	// Render tracks = preview-overlay tracks + main-track transitions applied
	// (memoized in the manager, so this snapshot is referentially stable).
	const tracks = useEditor(
		(e) => e.timeline.getRenderTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const renderTree = useEditor((e) => e.renderer.getRenderTree());

	const { width, height } = activeProject.settings.canvasSize;
	const background = activeProject.settings.background;
	const fps = activeProject.settings.fps;

	// Scene sync — rebuild the render tree whenever timeline/media/canvas
	// state changes. Reference identity on `tracks`/`mediaAssets` is the
	// engine's own change signal (managers notify with fresh snapshots).
	useEffect(() => {
		const duration = editor.timeline.getTotalDuration();
		const tree = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			background,
			isPreview: true,
		});
		editor.renderer.setRenderTree({ renderTree: tree });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `editor` is the process-wide singleton; the deps that matter are the state snapshots.
	}, [tracks, mediaAssets, background, width, height]);

	const renderer = useMemo(
		() => new CanvasRenderer({ width, height, fps }),
		[width, height, fps],
	);

	const mountRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const outputCanvas = renderer.getOutputCanvas();
		outputCanvas.style.display = "block";
		outputCanvas.style.width = "100%";
		outputCanvas.style.height = "100%";
		mount.appendChild(outputCanvas);
		return () => {
			if (outputCanvas.parentElement === mount) {
				mount.removeChild(outputCanvas);
			}
		};
	}, [renderer]);

	const lastFrameRef = useRef(-1);
	const lastTreeRef = useRef<RootNode | null>(null);
	const renderingRef = useRef(false);

	const renderFrame = useCallback(() => {
		if (!renderTree || renderingRef.current) return;
		const renderTime = Math.min(
			editor.playback.getCurrentTime(),
			editor.timeline.getLastFrameTime(),
		);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);
		const frame = Math.floor(renderTime / ticksPerFrame);
		if (frame === lastFrameRef.current && renderTree === lastTreeRef.current) return;
		renderingRef.current = true;
		lastFrameRef.current = frame;
		lastTreeRef.current = renderTree;
		renderer
			.render({ node: renderTree, time: renderTime })
			.catch((error: unknown) => {
				// A single bad frame must not kill the loop; log and move on.
				console.error("preview render failed:", error);
			})
			.finally(() => {
				renderingRef.current = false;
			});
	}, [editor.playback, editor.timeline, renderTree, renderer]);

	useEffect(() => {
		let rafId: number;
		const tick = () => {
			renderFrame();
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, [renderFrame]);

	const gestureHandlers = usePreviewTransformGesture({
		mountRef,
		canvasWidth: width,
	});

	const { snapGuides, ...pointerHandlers } = gestureHandlers;

	return (
		<div
			ref={mountRef}
			className="cc-preview-stage__render"
			style={{ touchAction: "none" }}
			{...pointerHandlers}
		>
			{/* The detent has to be SEEN, not just felt: without a line on
			    screen a snapped element just looks like it stopped tracking
			    the finger. Drawn only while a drag holds the axis, and marked
			    inert so it can never intercept the gesture that spawned it. */}
			{snapGuides.x && (
				<div
					className="cc-preview-guide cc-preview-guide--v"
					aria-hidden="true"
				/>
			)}
			{snapGuides.y && (
				<div
					className="cc-preview-guide cc-preview-guide--h"
					aria-hidden="true"
				/>
			)}
		</div>
	);
}

/**
 * SELECTION-GATED manipulation on the preview (round 23, founder: "maybe
 * this is bc video is hyper sensitive, how about these things are only
 * adjustable if they are selected in the timeline") — this supersedes
 * round 18's direct-grab hit-testing, which made the full-frame video
 * swallow every touch and left text/captions practically unreachable.
 *
 * The rule is one line: preview drags and pinches apply to the element
 * currently selected in the TIMELINE, and only then. One finger moves
 * (`transform.positionX/Y`, canvas units), two fingers pinch to scale
 * (`transform.scaleX/Y`) anywhere on the preview. Nothing selected →
 * touches do nothing at all (stage tap-to-play was REMOVED 2026-08-22:
 * the toggle also fired on the pointer-up ending a gesture — releasing a
 * caption resize started playback; play/pause is the PlaybackBar button
 * only).
 *
 * CAPTIONS MOVE AS ONE (round 23, founder: "if i can move one caption it
 * should move all of it around to same position and sizing — sync all
 * caption sizing and positioning"): when the selected element is a
 * caption, the session fans the same transform out to EVERY caption
 * element, and the commit lands them all in one undo step.
 *
 * Mid-gesture frames ride the engine's preview overlay
 * (`timeline.previewElements`); release commits ONE undoable
 * TracksSnapshotCommand (`timeline.commitPreview`). Tap semantics: only
 * real drags swallow the up-event; plain taps bubble but nothing above
 * listens anymore (see the stage-tap removal note in the header).
 */
const DRAG_SLOP_PX = 6;

/** One element a preview gesture writes to: the selection, or every caption
 *  when a caption is selected (they move as one). Round 47: a target that
 *  already has clip keyframes is `keyed` — the gesture then writes a
 *  keyframe at the playhead (CapCut's auto-add once a clip is keyed) instead
 *  of the base params, which the animation would override anyway. */
interface GestureTarget {
	trackId: string;
	elementId: string;
	/** PRE-gesture element: every frame's params/animations build from it. */
	element: TimelineElement;
	keyed: boolean;
	/** Frame-snapped clip-local playhead at gesture start. */
	localTime: MediaTime;
	/** The keyframe group's values at `localTime` — the drag anchors here
	 *  (so a keyed clip is grabbed where it IS at this time, not at its base
	 *  params) and rotate/opacity ride along unchanged so the keyframe the
	 *  drag writes is complete. */
	baseValues: ClipKeyframeValues;
}

function usePreviewTransformGesture({
	mountRef,
	canvasWidth,
}: {
	mountRef: RefObject<HTMLDivElement | null>;
	canvasWidth: number;
}) {
	const editor = useEditor();
	const [selectedRef, selectedElement] = useSelectedElement();
	/** Which centre lines to draw. React state (not the session ref) because
	 *  this one piece of gesture state has to reach the render. */
	const [snapGuides, setSnapGuides] = useState<AxisSnapFlags>(NO_SNAP);

	// Anchor values are the element's transform at the LAST pointer-topology
	// change (gesture start, finger added, finger lifted); deltas are always
	// measured from the geometry captured at that same moment, so adding or
	// removing a finger never makes the element jump.
	const sessionRef = useRef<{
		pointers: Map<number, { x: number; y: number }>;
		startCentroid: { x: number; y: number };
		startDistance: number | null;
		anchorPositionX: number;
		anchorPositionY: number;
		anchorScaleX: number;
		anchorScaleY: number;
		dragging: boolean;
		/** Which axes are currently held by the centre-line detent. Lives on
		 *  the session because the snap decision is hysteretic: it depends on
		 *  whether the axis was ALREADY snapped a frame ago. */
		snapped: AxisSnapFlags;
		/** The selection alone, or every caption in the scene when a caption
		 *  is selected — the shared transform fans out to all of them per
		 *  frame, each written its own way (params vs keyframe). */
		targets: GestureTarget[];
	} | null>(null);

	const centroidAndDistance = (pointers: Map<number, { x: number; y: number }>) => {
		const points = [...pointers.values()];
		const centroid = {
			x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
			y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
		};
		const distance =
			points.length >= 2
				? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
				: null;
		return { centroid, distance };
	};

	const pxToCanvas = () => {
		const rect = mountRef.current?.getBoundingClientRect();
		// The mount is rendered at the canvas's own aspect ratio (PreviewStage
		// sizes it), so one uniform factor maps CSS px -> canvas units.
		return rect && rect.width > 0 ? canvasWidth / rect.width : 0;
	};

	type Session = NonNullable<typeof sessionRef.current>;

	/**
	 * The element's effective transform under the current pointer deltas,
	 * with the centre-axis detent applied.
	 *
	 * The snap is applied HERE rather than at commit time on purpose: the
	 * whole point is that the element visibly leaves the finger and sits on
	 * the axis during the drag. Snapping only on release would land in the
	 * same place while showing the user nothing.
	 */
	const currentTransform = (session: Session) => {
		const scale = pxToCanvas();
		const { centroid, distance } = centroidAndDistance(session.pointers);
		const factor =
			distance !== null && session.startDistance && session.startDistance > 0
				? distance / session.startDistance
				: 1;
		const rawX = session.anchorPositionX + (centroid.x - session.startCentroid.x) * scale;
		const rawY = session.anchorPositionY + (centroid.y - session.startCentroid.y) * scale;
		// Thresholds are authored in CSS px and converted with the same
		// px -> canvas factor the drag itself uses, so the detent is the same
		// physical size on any preview size or project resolution.
		const snap = snapToCenterAxes({
			x: rawX,
			y: rawY,
			wasSnapped: session.snapped,
			capture: SNAP_CAPTURE_PX * scale,
			release: SNAP_RELEASE_PX * scale,
		});
		return {
			positionX: snap.x,
			positionY: snap.y,
			scaleX: session.anchorScaleX * factor,
			scaleY: session.anchorScaleY * factor,
			snapped: snap.snapped,
		};
	};

	/** Re-anchor after a finger joins/leaves: bank the current transform and
	 *  restart deltas from the new pointer geometry. */
	const reanchor = (session: Session) => {
		const current = currentTransform(session);
		session.anchorPositionX = current.positionX;
		session.anchorPositionY = current.positionY;
		session.anchorScaleX = current.scaleX;
		session.anchorScaleY = current.scaleY;
		const { centroid, distance } = centroidAndDistance(session.pointers);
		session.startCentroid = centroid;
		session.startDistance = distance;
	};

	const applySessionUpdate = () => {
		const session = sessionRef.current;
		if (!session || session.pointers.size === 0 || pxToCanvas() === 0) return;
		const current = currentTransform(session);
		// Feedback fires on the RISING edge only — a tick every frame while
		// the element rides the line would be a buzz, not a detent.
		if (
			(current.snapped.x && !session.snapped.x) ||
			(current.snapped.y && !session.snapped.y)
		) {
			pulseSnapHaptic();
		}
		session.snapped = current.snapped;
		setSnapGuides(current.snapped);
		const transformPatch: ParamValues = {
			"transform.positionX": current.positionX,
			"transform.positionY": current.positionY,
			"transform.scaleX": current.scaleX,
			"transform.scaleY": current.scaleY,
		};
		editor.timeline.previewElements({
			updates: session.targets.map((t) => ({
				trackId: t.trackId,
				elementId: t.elementId,
				updates: t.keyed
					? {
							// Auto-keyframe: the whole group at the playhead, built
							// from the PRE-gesture animations so re-writing the same
							// time every frame replaces one key instead of stacking.
							animations: upsertClipAnimationValues({
								element: t.element,
								localTime: t.localTime,
								values: {
									...t.baseValues,
									"transform.positionX": current.positionX,
									"transform.positionY": current.positionY,
									"transform.scaleX": current.scaleX,
									"transform.scaleY": current.scaleY,
								},
							}),
						}
					: { params: { ...t.element.params, ...transformPatch } },
			})),
		});
	};

	const endSession = (commit: boolean) => {
		const session = sessionRef.current;
		if (!session) return null;
		sessionRef.current = null;
		setSnapGuides(NO_SNAP);
		if (session.dragging && commit) {
			editor.timeline.commitPreview();
		} else if (session.dragging) {
			editor.timeline.discardPreview();
		}
		return session;
	};

	/** Snapshot one element as a gesture target at the current playhead. */
	const makeTarget = ({ trackId, element }: { trackId: string; element: TimelineElement }): GestureTarget => {
		const localTime = snapLocalTimeToFrame({
			localTime: clipLocalTime({ element, timelineTime: editor.playback.getCurrentTime() }),
			fps: editor.project.getActive().settings.fps,
			duration: element.duration,
		});
		return {
			trackId,
			elementId: element.id,
			element,
			keyed: hasClipKeyframes({ animations: element.animations }),
			localTime,
			baseValues: resolveClipValuesAtTime({ element, localTime }),
		};
	};

	/** All caption elements in the active scene — the "captions move as one"
	 *  fan-out list. */
	const collectCaptionFanout = (): GestureTarget[] => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const out: GestureTarget[] = [];
		for (const track of tracks.overlay) {
			if (track.type !== "caption") continue;
			for (const element of track.elements) {
				if (element.type === "caption") {
					out.push(makeTarget({ trackId: track.id, element }));
				}
			}
		}
		return out;
	};

	const openSession = ({
		pointers,
		element,
		target,
		isCaption,
	}: {
		pointers: Map<number, { x: number; y: number }>;
		element: TimelineElement;
		target: { trackId: string; elementId: string };
		isCaption: boolean;
	}) => {
		const { centroid, distance } = centroidAndDistance(pointers);
		const targets = isCaption ? collectCaptionFanout() : [];
		if (!targets.some((t) => t.elementId === target.elementId)) {
			targets.unshift(makeTarget({ trackId: target.trackId, element }));
		}
		const primary = targets.find((t) => t.elementId === target.elementId) ?? targets[0];
		// Anchor on the RESOLVED values: for a keyed clip that is where the
		// element is at the playhead (grabbing it must not snap it back to its
		// base params); for an un-keyed clip it equals the params/defaults.
		sessionRef.current = {
			pointers,
			startCentroid: centroid,
			startDistance: distance,
			anchorPositionX: primary.baseValues["transform.positionX"],
			anchorPositionY: primary.baseValues["transform.positionY"],
			anchorScaleX: primary.baseValues["transform.scaleX"],
			anchorScaleY: primary.baseValues["transform.scaleY"],
			dragging: false,
			snapped: NO_SNAP,
			targets,
		};
	};

	const selectionIsManipulable =
		selectedRef !== null &&
		selectedElement !== null &&
		isVisualElement(selectedElement);

	return {
		snapGuides,
		onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
			const point = { x: event.clientX, y: event.clientY };
			const existing = sessionRef.current;
			if (existing) {
				existing.pointers.set(event.pointerId, point);
				reanchor(existing);
				return;
			}

			// Selection-gated: a touch only manipulates the element selected
			// in the timeline. No selection → the touch is fully inert (the
			// stage has no tap handler anymore — see the header note).
			if (selectionIsManipulable && selectedRef && selectedElement) {
				openSession({
					pointers: new Map([[event.pointerId, point]]),
					element: selectedElement,
					target: selectedRef,
					isCaption: selectedElement.type === "caption",
				});
			}
		},
		onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
			const session = sessionRef.current;
			if (!session || !session.pointers.has(event.pointerId)) return;
			session.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (!session.dragging) {
				const { centroid } = centroidAndDistance(session.pointers);
				const moved = Math.hypot(
					centroid.x - session.startCentroid.x,
					centroid.y - session.startCentroid.y,
				);
				if (moved < DRAG_SLOP_PX && session.pointers.size < 2) return;
				session.dragging = true;
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					// Defensive: an invalid/stale pointerId (synthetic events,
					// odd webview states) must not kill the drag — capture is
					// an optimization, not a correctness requirement.
				}
			}
			applySessionUpdate();
		},
		onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
			const session = sessionRef.current;
			if (!session || !session.pointers.has(event.pointerId)) return;
			session.pointers.delete(event.pointerId);
			if (session.pointers.size > 0) {
				reanchor(session);
				return;
			}
			const ended = endSession(true);
			// Only a real drag swallows the up-event; a plain tap (session
			// opened but never moved) bubbles — harmlessly, now that the
			// stage has no tap-to-play handler.
			if (ended?.dragging) {
				event.stopPropagation();
			}
		},
		onPointerCancel: () => {
			endSession(false);
		},
	};
}
