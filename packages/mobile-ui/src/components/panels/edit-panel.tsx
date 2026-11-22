import { Copy, FlipHorizontal2, FlipVertical2, RefreshCw, RotateCcw, RotateCw, Scissors, ScissorsLineDashed, Trash2 } from "lucide-react";
import { setElementParam } from "../../editor/actions";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { SegmentedControl } from "../segmented-control";
import { ParamRow, ToggleRow } from "../editor/param-row";
import type { ElementRef, TimelineElement } from "@cutlyra/editor-core/timeline";
import { DEFAULT_RETIME_RATE, MAX_RETIME_RATE, MIN_RETIME_RATE } from "@cutlyra/editor-core/retime";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@cutlyra/editor-core/timeline/audio-constants";
import { mediaTimeToSeconds } from "@cutlyra/editor-core/wasm";

const RETIMABLE_TYPES = new Set(["video", "audio"]);
const FRAMING_TYPES = new Set(["video", "image"]);
const FRAMING_SEGMENTS = [
	{ id: "fit", label: "Fit" },
	{ id: "fill", label: "Fill" },
] as const;

interface EditPanelProps {
	editor: import("@cutlyra/editor-core").EditorCore;
	elementRef: ElementRef;
	element: TimelineElement;
	onClose: () => void;
	onSplit: () => void;
	onDelete: () => void;
	onDuplicate: () => void;
	/** Absent for element types that can't carry audio — the row is then
	 *  hidden rather than shown-and-disabled, matching how this panel already
	 *  treats speed/volume/reverse on a text or sticker selection. */
	onCutDeadSpace?: () => void;
	onSetSpeed: (args: { rate: number; maintainPitch: boolean }) => void;
	onSetVolume: (db: number) => void;
	/** Fade lengths in SECONDS; the engine clamps in + out to the clip. */
	onSetAudioFade?: (args: { fadeIn: number; fadeOut: number }) => void;
	onSetFraming?: (mode: "fit" | "fill") => void;
	/** Video/image transform edits. Preview and native export must honor these
	 *  operations before exposing them in release UI. */
	onRotate?: (deltaDegrees: number) => void;
	onFlipHorizontal?: () => void;
	onFlipVertical?: () => void;
	/** Nondestructive Replace Clip (#74). Absent for element types whose media
	 *  cannot be swapped (text, captions, graphics, library audio). */
	onReplace?: () => void;
	/** "Relink media" when the clip's media reference is already missing. */
	replaceLabel?: string;
	/** Non-null when the picked replacement is shorter than the clip's edited
	 *  range: the user must choose to shorten the clip or keep it unchanged. */
	replacePrompt?: { message: string; confirmLabel: string } | null;
	onConfirmReplace?: () => void;
	onDismissReplace?: () => void;
}

/**
 * Release edit panel: split/speed/volume/delete/duplicate. Reverse remains
 * in the engine data model for project compatibility, but is intentionally
 * hidden in v0.1.0 until preview and native export can honor it. Speed/volume
 * only apply to retimable
 * elements (video/audio, per `RETIMABLE_ELEMENT_TYPES` in the engine) —
 * for a text/sticker/graphic selection those controls are hidden
 * rather than shown-and-disabled, since there is no engine-side field for
 * them to write to on those types.
 */
export function EditPanel({
	editor,
	elementRef,
	element,
	onClose,
	onSplit,
	onDelete,
	onDuplicate,
	onCutDeadSpace,
	onSetSpeed,
	onSetVolume,
	onSetAudioFade,
	onSetFraming,
	onRotate,
	onFlipHorizontal,
	onFlipVertical,
	onReplace,
	replaceLabel = "Replace",
	replacePrompt,
	onConfirmReplace,
	onDismissReplace,
}: EditPanelProps) {
	const isRetimable = RETIMABLE_TYPES.has(element.type);
	const isFramable = FRAMING_TYPES.has(element.type);
	const canTransform = isFramable && !!(onRotate && onFlipHorizontal && onFlipVertical);
	const retime = "retime" in element ? element.retime : undefined;
	const rate = retime?.rate ?? DEFAULT_RETIME_RATE;
	const maintainPitch = retime?.maintainPitch ?? false;
	const volumeDb = typeof element.params.volume === "number" ? element.params.volume : 0;
	const fadeIn = typeof element.params.fadeIn === "number" ? element.params.fadeIn : 0;
	const fadeOut = typeof element.params.fadeOut === "number" ? element.params.fadeOut : 0;
	// Slider ceilings leave room for the other side; the engine clamps again
	// (and proportionally scales) when the two are edited past the clip.
	const clipSeconds = mediaTimeToSeconds({ time: element.duration });
	const framing = element.params.framing === "fill" ? "fill" : "fit";
	const rotateDeg = typeof element.params["transform.rotate"] === "number" ? element.params["transform.rotate"] : 0;
	const cropX = typeof element.params["crop.x"] === "number" ? element.params["crop.x"] : 0;
	const cropY = typeof element.params["crop.y"] === "number" ? element.params["crop.y"] : 0;
	const cropW = typeof element.params["crop.width"] === "number" ? element.params["crop.width"] : 1;
	const cropH = typeof element.params["crop.height"] === "number" ? element.params["crop.height"] : 1;

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			{replacePrompt && (
				<div className="cc-replace-prompt" role="alert">
					<p className="cc-replace-prompt__text">{replacePrompt.message}</p>
					<div className="cc-panel-actions">
						<button
							type="button"
							className="cc-panel-actions__btn"
							onClick={onConfirmReplace}
						>
							<Scissors size={20} strokeWidth={CC_ICON_STROKE} />
							<span>{replacePrompt.confirmLabel}</span>
						</button>
						<button
							type="button"
							className="cc-panel-actions__btn"
							onClick={onDismissReplace}
						>
							<span>Keep clip unchanged</span>
						</button>
					</div>
				</div>
			)}
			<div className="cc-panel-actions">
				<button type="button" className="cc-panel-actions__btn" onClick={onSplit}>
					<Scissors size={20} strokeWidth={CC_ICON_STROKE} />
					<span>Split</span>
				</button>
				<button type="button" className="cc-panel-actions__btn" onClick={onDuplicate}>
					<Copy size={20} strokeWidth={CC_ICON_STROKE} />
					<span>Duplicate</span>
				</button>
				<button type="button" className="cc-panel-actions__btn" onClick={onDelete}>
					<Trash2 size={20} strokeWidth={CC_ICON_STROKE} />
					<span>Delete</span>
				</button>
				{onCutDeadSpace && (
					<button type="button" className="cc-panel-actions__btn" onClick={onCutDeadSpace}>
						<ScissorsLineDashed size={20} strokeWidth={CC_ICON_STROKE} />
						<span>Cut gaps</span>
					</button>
				)}
				{onReplace && (
					<button
						type="button"
						className="cc-panel-actions__btn"
						onClick={onReplace}
						aria-label={replaceLabel}
					>
						<RefreshCw size={20} strokeWidth={CC_ICON_STROKE} />
						<span>{replaceLabel}</span>
					</button>
				)}
			</div>

			{isRetimable && (
				<>
					<ParamRow
						label="Speed"
						value={rate}
						min={MIN_RETIME_RATE}
						max={MAX_RETIME_RATE}
						step={0.05}
						formatValue={(v) => `${v.toFixed(2)}x`}
						onChange={(v) => onSetSpeed({ rate: v, maintainPitch })}
					/>
					<ToggleRow
						label="Maintain pitch"
						active={maintainPitch}
						onToggle={() => onSetSpeed({ rate, maintainPitch: !maintainPitch })}
					/>
					{/* CapCut-parity volume: a LINEAR percent slider 0–1000
					    (100 = original, 1000 = 10×) — the raw dB slider
					    crammed the whole audible boost into its top edge and
					    read as "won't go loud enough" (founder, 2026-08-22).
					    Storage stays dB engine-wide: pct↔dB converts at this
					    UI boundary only. 0% pins to VOLUME_DB_MIN (silence);
					    1000% is exactly VOLUME_DB_MAX (+20 dB = 10×). */}
					<ParamRow
						label="Volume"
						value={Math.round(10 ** (volumeDb / 20) * 100)}
						min={0}
						max={1000}
						step={1}
						formatValue={(v) => `${Math.round(v)}`}
						onChange={(pct) =>
							onSetVolume(
								pct <= 0
									? VOLUME_DB_MIN
									: Math.min(
											VOLUME_DB_MAX,
											Math.max(VOLUME_DB_MIN, 20 * Math.log10(pct / 100)),
										),
							)
						}
					/>
					{onSetAudioFade && (
						<>
							<ParamRow
								label="Fade in"
								value={fadeIn}
								min={0}
								max={Math.max(0, clipSeconds - fadeOut)}
								step={0.05}
								formatValue={(v) => `${v.toFixed(2)}s`}
								onChange={(v) => onSetAudioFade({ fadeIn: v, fadeOut })}
							/>
							<ParamRow
								label="Fade out"
								value={fadeOut}
								min={0}
								max={Math.max(0, clipSeconds - fadeIn)}
								step={0.05}
								formatValue={(v) => `${v.toFixed(2)}s`}
								onChange={(v) => onSetAudioFade({ fadeIn, fadeOut: v })}
							/>
						</>
					)}
				</>
			)}

			{isFramable && onSetFraming && (
				<div className="cc-param-row">
					<div className="cc-param-row__head">
						<span className="cc-param-row__label">Framing</span>
						<span className="cc-param-row__value">
							{framing === "fill" ? "Crops to fill" : "Fits whole frame"}
						</span>
					</div>
					<SegmentedControl
						aria-label="Framing"
						segments={FRAMING_SEGMENTS}
						activeId={framing}
						onSelect={(id) => onSetFraming(id === "fill" ? "fill" : "fit")}
					/>
					<p className="cc-hint" style={{ marginTop: 6, fontSize: 12, opacity: 0.72 }}>
						{framing === "fill"
							? "Fill crops the media to cover the canvas. Use Transform to reposition."
							: "Fit keeps the whole frame visible; the canvas background shows around it."}
					</p>
				</div>
			)}

			{isFramable && (
				<div className="cc-param-row">
					<div className="cc-param-row__head">
						<span className="cc-param-row__label">Crop</span>
						<span className="cc-param-row__value">
							{`${Math.round(cropW * 100)}% x ${Math.round(cropH * 100)}%`}
						</span>
					</div>
					<ParamRow
						label="Crop X"
						value={cropX}
						min={0}
						max={1}
						step={0.01}
						formatValue={(v) => `${Math.round(v * 100)}%`}
						onChange={(v) => setElementParam({ editor, ref: elementRef, key: "crop.x", value: v })}
					/>
					<ParamRow
						label="Crop Y"
						value={cropY}
						min={0}
						max={1}
						step={0.01}
						formatValue={(v) => `${Math.round(v * 100)}%`}
						onChange={(v) => setElementParam({ editor, ref: elementRef, key: "crop.y", value: v })}
					/>
					<ParamRow
						label="Crop Width"
						value={cropW}
						min={0.01}
						max={1}
						step={0.01}
						formatValue={(v) => `${Math.round(v * 100)}%`}
						onChange={(v) => setElementParam({ editor, ref: elementRef, key: "crop.width", value: v })}
					/>
					<ParamRow
						label="Crop Height"
						value={cropH}
						min={0.01}
						max={1}
						step={0.01}
						formatValue={(v) => `${Math.round(v * 100)}%`}
						onChange={(v) => setElementParam({ editor, ref: elementRef, key: "crop.height", value: v })}
					/>
					<button
						type="button"
						className="cc-panel-actions__btn"
						onClick={() => {
							setElementParam({ editor, ref: elementRef, key: "crop.x", value: 0 });
							setElementParam({ editor, ref: elementRef, key: "crop.y", value: 0 });
							setElementParam({ editor, ref: elementRef, key: "crop.width", value: 1 });
							setElementParam({ editor, ref: elementRef, key: "crop.height", value: 1 });
						}}
					>
						<span>Reset crop</span>
					</button>
					<p className="cc-hint" style={{ marginTop: 6, fontSize: 12, opacity: 0.72 }}>
						Crop applies to the preview and to exports. The kept region is then fitted or filled like any other source frame.
					</p>
				</div>
			)}

			{canTransform && onRotate && onFlipHorizontal && onFlipVertical && (
				<div className="cc-param-row">
					<div className="cc-param-row__head">
						<span className="cc-param-row__label">Transform</span>
						<span className="cc-param-row__value">{Math.round(rotateDeg)}°</span>
					</div>
					<div className="cc-panel-actions" style={{ marginTop: 8 }}>
						<button type="button" className="cc-panel-actions__btn" onClick={() => onRotate(-90)} aria-label="Rotate left 90 degrees">
							<RotateCcw size={20} strokeWidth={CC_ICON_STROKE} />
							<span>Rotate L</span>
						</button>
						<button type="button" className="cc-panel-actions__btn" onClick={() => onRotate(90)} aria-label="Rotate right 90 degrees">
							<RotateCw size={20} strokeWidth={CC_ICON_STROKE} />
							<span>Rotate R</span>
						</button>
						<button type="button" className="cc-panel-actions__btn" onClick={onFlipHorizontal} aria-label="Flip horizontal">
							<FlipHorizontal2 size={20} strokeWidth={CC_ICON_STROKE} />
							<span>Flip H</span>
						</button>
						<button type="button" className="cc-panel-actions__btn" onClick={onFlipVertical} aria-label="Flip vertical">
							<FlipVertical2 size={20} strokeWidth={CC_ICON_STROKE} />
							<span>Flip V</span>
						</button>
					</div>
					<p className="cc-hint" style={{ marginTop: 6, fontSize: 12, opacity: 0.72 }}>
						Rotates and mirrors the selected media. Existing position, scale, and keyframes are preserved.
					</p>
				</div>
			)}
		</PanelSheet>
	);
}
