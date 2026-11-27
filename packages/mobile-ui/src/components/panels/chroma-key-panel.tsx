import { useEffect } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ParamRow, ToggleRow, readNumberParam } from "../editor/param-row";
import type { EditorCore } from "@cutlyra/editor-core";
import type { ElementRef, VisualElement } from "@cutlyra/editor-core/timeline";
import {
	CHROMA_KEY_EFFECT_TYPE,
	DEFAULT_CHROMA_KEY,
} from "@cutlyra/editor-core/effects/chroma-key";
import {
	ensureSingleEffect,
	toggleEffectEnabled,
	updateEffectParam,
} from "../../editor/actions";

interface ChromaKeyPanelProps {
	editor: EditorCore;
	elementRef: ElementRef;
	element: VisualElement;
	onClose: () => void;
	/** True while the editor is waiting for a preview tap to sample a colour. */
	pickArmed: boolean;
	/** Arms the eyedropper: the sheet closes so the preview is tappable. */
	onPickFromPreview: () => void;
}

const PRESET_KEYS = [
	{ label: "Green", value: "#00b140" },
	{ label: "Blue", value: "#0066ff" },
	{ label: "Cyan", value: "#00c8c8" },
] as const;

const SLIDERS = [
	{ key: "similarity", label: "Similarity", hint: "How much of the frame counts as background" },
	{ key: "softness", label: "Edge softness", hint: "Width of the transparent-to-solid ramp" },
	{ key: "spill", label: "Spill reduction", hint: "Desaturates green fringe on kept pixels" },
] as const;

/**
 * Chroma key panel — key colour (with an eyedropper that samples the REAL
 * compositor frame), similarity, edge softness and spill reduction.
 *
 * Every control writes the `chroma-key` effect's params through the normal
 * command stack, and that one effect is what both renderers read: the preview's
 * `chroma-key` WGSL pass and Android's `EdlChromaKeyEffect`. There is no
 * preview-only control here — keyed pixels are transparent, so the lower
 * video/image layer shows through in the exported MP4 too.
 */
export function ChromaKeyPanel({
	editor,
	elementRef,
	element,
	onClose,
	pickArmed,
	onPickFromPreview,
}: ChromaKeyPanelProps) {
	const effect = element.effects?.find((e) => e.type === CHROMA_KEY_EFFECT_TYPE);

	useEffect(() => {
		if (!element.effects?.some((e) => e.type === CHROMA_KEY_EFFECT_TYPE)) {
			ensureSingleEffect({ editor, ref: elementRef, effectType: CHROMA_KEY_EFFECT_TYPE });
		}
		// Same rule as the Adjust panel: re-check when the selected element
		// changes, not on every effect write of our own.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, elementRef.trackId, elementRef.elementId]);

	const keyColor =
		typeof effect?.params.keyColor === "string" ? effect.params.keyColor : DEFAULT_CHROMA_KEY.keyColor;

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			{!effect && <p className="cc-panel-note">Setting up the chroma key…</p>}
			{effect && (
				<>
					<ToggleRow
						label="Chroma key enabled"
						active={effect.enabled}
						onToggle={() =>
							toggleEffectEnabled({ editor, ref: elementRef, effectId: effect.id })
						}
					/>
					<div className="cc-param-row">
						<div className="cc-param-row__head">
							<span className="cc-param-row__label">Key colour</span>
							<span className="cc-param-row__value">{keyColor.toUpperCase()}</span>
						</div>
						<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
							{PRESET_KEYS.map((preset) => (
								<button
									key={preset.value}
									type="button"
									aria-label={preset.label}
									aria-pressed={keyColor.toLowerCase() === preset.value}
									onClick={() =>
										updateEffectParam({
											editor,
											ref: elementRef,
											effectId: effect.id,
											key: "keyColor",
											value: preset.value,
										})
									}
									style={{
										width: 32,
										height: 32,
										borderRadius: 8,
										background: preset.value,
										border:
											keyColor.toLowerCase() === preset.value
												? "2px solid var(--cc-accent, #fff)"
												: "1px solid rgba(255,255,255,0.35)",
									}}
								/>
							))}
							<input
								type="color"
								aria-label="Custom key colour"
								value={keyColor}
								onChange={(event) =>
									updateEffectParam({
										editor,
										ref: elementRef,
										effectId: effect.id,
										key: "keyColor",
										value: event.target.value,
									})
								}
								style={{ width: 32, height: 32, padding: 0, borderRadius: 8, border: "none" }}
							/>
							<button
								type="button"
								onClick={onPickFromPreview}
								style={{
									marginLeft: "auto",
									padding: "8px 12px",
									borderRadius: 8,
									border: "1px solid rgba(255,255,255,0.35)",
									background: pickArmed ? "var(--cc-accent, #4f8cff)" : "transparent",
									color: "inherit",
									fontSize: 13,
								}}
							>
								{pickArmed ? "Tap the preview…" : "Pick from preview"}
							</button>
						</div>
					</div>
					{SLIDERS.map((slider) => (
						<ParamRow
							key={slider.key}
							label={slider.label}
							value={readNumberParam({
								raw: effect.params[slider.key],
								fallback: DEFAULT_CHROMA_KEY[slider.key],
							})}
							min={0}
							max={100}
							step={1}
							onChange={(value) =>
								updateEffectParam({
									editor,
									ref: elementRef,
									effectId: effect.id,
									key: slider.key,
									value,
								})
							}
						/>
					))}
					<p className="cc-panel-note" style={{ fontSize: 12, opacity: 0.72 }}>
						Keyed areas become transparent, so put the clip on an overlay track above the
						background you want to show through.
					</p>
				</>
			)}
		</PanelSheet>
	);
}
