import { useState } from "react";
import { WandSparkles } from "lucide-react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ChipRow } from "../chip-row";
import type { EditorCore } from "@cutlyra/editor-core";
import type { ElementRef } from "@cutlyra/editor-core/timeline";
import { CAPTION_STYLE_PRESETS, DEFAULT_CAPTION_STYLE_PRESET_ID, buildSrtFromCaptions, buildVttFromCaptions } from "@cutlyra/editor-core/captions";
import type { CaptionElement } from "@cutlyra/editor-core/timeline";
import {
	generateCaptions,
	importCaptionsFromText,
	applyCaptionStyleToAll,
	getCaptionHighlightEnabled,
	setCaptionHighlightEnabled,
	getCaptionBorderEnabled,
	setCaptionBorderEnabled,
	getCaptionShadowEnabled,
	setCaptionShadowEnabled,
} from "../../editor/captions-actions";
import { setCaptionText } from "../../editor/actions";
import { getNativeBridge } from "@cutlyra/native-bridge";
import { ToggleRow } from "../editor/param-row";
import { captionText } from "../../editor/caption-text";
import { TranscriptEditor } from "./transcript-editor";

interface CaptionsPanelProps {
	/** The selected caption element, when one is selected — drives the
	 *  text-field editor below (round 21.4). */
	selectedCaption?: { ref: ElementRef; element: CaptionElement } | null;
	editor: EditorCore;
	onClose: () => void;
	onInserted: (ref: ElementRef) => void;
}

const STYLES = CAPTION_STYLE_PRESETS.map((preset) => ({ id: preset.id, label: preset.name }));

type GenerateState = "idle" | "generating" | "done" | "error";

/**
 * M8 Captions panel — fixer pass. This IS now wired to the real M10
 * captions engine (`@cutlyra/editor-core/captions` +
 * `commands/captions/*`), not the placeholder from before: "Generate"
 * calls `generateCaptionsFromSampleClip`, which runs the real
 * `getNativeBridge()` -> `transcribe()` -> `buildCaptionElementsFromTranscript`
 * -> `insertGeneratedCaptions` pipeline against `@cutlyra/native-bridge`'s
 * own disclosed dev-fixture sample clip (the exact mechanism plan M10's
 * exit criterion names: "verify the full generate -> edit -> preview flow
 * in the dev harness using the web fallback + a pre-transcribed fixture").
 * The style chips call the real `ApplyCaptionStyleCommand` ("apply to
 * all"), not local-only UI state.
 *
 * On Android, Generate uses the native bridge to transcribe the project's
 * real audio-bearing timeline clips through the bundled English tiny.en
 * whisper.cpp runtime. Below the style controls, `TranscriptEditor` edits the
 * cues themselves — seek, text, cue timing, per-word corrections, split at the
 * playhead and merge with the next cue — all through engine commands, so
 * undo/redo, persistence and the native caption export stay in sync.
 *
 * Subtitle files enter through the native SAF picker (`pickSubtitleFile`,
 * 2 MB / encoding validated natively) and leave through `saveSubtitleFile`'s
 * system save dialog; the paste textarea remains as the web-shell path.
 */
export function CaptionsPanel({ editor, onClose, onInserted, selectedCaption }: CaptionsPanelProps) {
	const [stylePreset, setStylePreset] = useState(DEFAULT_CAPTION_STYLE_PRESET_ID);
	const [state, setState] = useState<GenerateState>("idle");
	// Local draft for the caption-text field: committing rewrites words and
	// re-deriving the value from them normalizes whitespace, which ate the
	// space key mid-typing (caught live in the harness). The draft holds
	// exactly what the user typed; the engine stores the tokenized words.
	const [captionDraft, setCaptionDraft] = useState<{ id: string; text: string } | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	// Read live from the engine each render (the shell re-renders this panel
	// on timeline changes, same as the caption textarea's words).
	const highlightEnabled = getCaptionHighlightEnabled({ editor });
	const borderEnabled = getCaptionBorderEnabled({ editor });
	const shadowEnabled = getCaptionShadowEnabled({ editor });
	const [srtStatus, setSrtStatus] = useState<"idle" | "copied" | "error">("idle");
	const [srtText, setSrtText] = useState<string>("");
	const [exportFormat, setExportFormat] = useState<"srt" | "vtt">("srt");
	const [exportStatus, setExportStatus] = useState<string | null>(null);
	// Subtitle import (SRT/VTT). Android uses the native SAF picker; this
	// textarea is the paste path, and the only file path the web shell has.
	const [importText, setImportText] = useState<string>("");
	const [importStatus, setImportStatus] = useState<string | null>(null);
	const [importError, setImportError] = useState<string | null>(null);

	const gatherCaptions = (): CaptionElement[] => {
		const scene = editor.scenes.getActiveSceneOrNull();
		if (!scene) return [];
		const out: CaptionElement[] = [];
		for (const track of scene.tracks.overlay) {
			if (track.type === "caption") {
				out.push(...(track.elements as CaptionElement[]));
			}
		}
		return out;
	};

	const handleExportSrt = async () => {
		const srt = buildSrtFromCaptions(gatherCaptions());
		setSrtText(srt);
		if (!srt) {
			setSrtStatus("error");
			return;
		}
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(srt);
				setSrtStatus("copied");
				return;
			}
			setSrtStatus("error");
		} catch {
			setSrtStatus("error");
		}
	};

	const handleImport = () => {
		setImportError(null);
		setImportStatus(null);
		try {
			const result = importCaptionsFromText({
				editor,
				text: importText,
				stylePresetId: stylePreset,
			});
			const count = result.elementIds.length;
			const skipped =
				result.skippedCueCount > 0 ? ` · ${result.skippedCueCount} skipped` : "";
			setImportStatus(`Imported ${count} ${count === 1 ? "cue" : "cues"}${skipped}`);
			setImportText("");
			if (result.elementIds[0]) {
				onInserted({ trackId: result.trackId, elementId: result.elementIds[0] });
			}
		} catch (error) {
			setImportError(error instanceof Error ? error.message : String(error));
		}
	};

	const handleImportFromFile = async () => {
		setImportError(null);
		setImportStatus(null);
		try {
			const bridge = await getNativeBridge();
			const picked = await bridge.pickSubtitleFile();
			if (!picked) {
				setImportStatus("Cancelled");
				return;
			}
			const result = importCaptionsFromText({
				editor,
				text: picked.text,
				stylePresetId: stylePreset,
			});
			const count = result.elementIds.length;
			const skipped =
				result.skippedCueCount > 0 ? ` · ${result.skippedCueCount} skipped` : "";
			setImportStatus(
				`Imported ${count} ${count === 1 ? "cue" : "cues"} from ${picked.displayName ?? picked.format.toUpperCase()}${skipped}`,
			);
			if (result.elementIds[0]) {
				onInserted({ trackId: result.trackId, elementId: result.elementIds[0] });
			}
		} catch (error) {
			setImportError(error instanceof Error ? error.message : String(error));
		}
	};

	const handleExportToFile = async () => {
		const captions = gatherCaptions();
		// Check the CAPTIONS, not the serialized text: a VTT document always
		// starts with a `WEBVTT` header, so an empty timeline would otherwise
		// pass the text check and save a header-only file as if it held cues.
		if (captions.length === 0) {
			setExportStatus("No captions to export");
			return;
		}
		const text =
			exportFormat === "vtt" ? buildVttFromCaptions(captions) : buildSrtFromCaptions(captions);
		if (!text.trim()) {
			setExportStatus("No captions to export");
			return;
		}
		const suggestedName = `captions.${exportFormat}`;
		try {
			const bridge = await getNativeBridge();
			const saved = await bridge.saveSubtitleFile({ text, suggestedName });
			if (!saved) {
				setExportStatus("Cancelled");
				return;
			}
			setExportStatus(`Saved ${suggestedName}`);
		} catch (error) {
			setExportStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const handleGenerate = () => {
		setState("generating");
		setErrorMessage(null);
		generateCaptions({ editor, stylePresetId: stylePreset })
			.then((result) => {
				setState("done");
				if (result && result.elementIds[0]) {
					onInserted({ trackId: result.trackId, elementId: result.elementIds[0] });
				}
			})
			.catch((error: unknown) => {
				setState("error");
				setErrorMessage(error instanceof Error ? error.message : String(error));
			});
	};

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<p className="cc-panel-note">
				Generate transcribes audio from your whole timeline on this device (zero
				network, zero cloud) — every clip and voiceover, with trims respected.
			</p>
			{selectedCaption && (
				<div className="cc-param-row">
					<div className="cc-param-row__head">
						<span className="cc-param-row__label">Caption text</span>
					</div>
					<textarea
						className="cc-text-content-input"
						rows={2}
						value={
							captionDraft?.id === selectedCaption.ref.elementId
								? captionDraft.text
								: captionText(selectedCaption.element.words)
						}
						aria-label="Caption text"
						onChange={(event) => {
							setCaptionDraft({ id: selectedCaption.ref.elementId, text: event.target.value });
							setCaptionText({
								editor,
								ref: selectedCaption.ref,
								words: selectedCaption.element.words,
								text: event.target.value,
							});
						}}
					/>
				</div>
			)}
			{/* Round 45 (founder: the button "just looks like text rn") — this
			    wore `.cc-panel-actions__btn`, which is the Edit sheet's
			    ICON-ROW style: no background, no border, label under a glyph.
			    With no glyph above it, it rendered as a bare word. */}
			<button
				type="button"
				className="cc-panel-cta"
				disabled={state === "generating"}
				onClick={handleGenerate}
			>
				<WandSparkles className="cc-panel-cta__icon" size={18} aria-hidden="true" />
				<span>
					{state === "generating"
						? "Generating…"
						: state === "done"
							? "Generate again"
							: "Generate"}
				</span>
			</button>
			{state === "error" && errorMessage && <p className="cc-panel-note">{errorMessage}</p>}
			<div className="cc-param-row">
				<div className="cc-param-row__head">
					<span className="cc-param-row__label">Language</span>
					<span className="cc-param-row__value">English · on-device</span>
				</div>
			</div>
			<p className="cc-panel-note">
				v0.1.0 bundles the English tiny.en model. Language choices are shown
				only when a matching on-device model is actually available.
			</p>
			<ChipRow
				chips={STYLES}
				activeIds={[stylePreset]}
				onSelect={(id) => {
					setStylePreset(id);
					applyCaptionStyleToAll({ editor, presetId: id });
				}}
			/>
			{/* Round 23 (founder: "highlighting the word ... should be
			    optional") — flips animationStyle on EVERY caption; captions
			    are a synced family. Note preset chips above reset it (a
			    preset bundles its own animationStyle). */}
			<ToggleRow
				label="Highlight spoken word"
				active={highlightEnabled}
				onToggle={() => setCaptionHighlightEnabled({ editor, enabled: !highlightEnabled })}
			/>
			{/* Round 31 (founder: "a default thin black border I can add
			    around any text or captions") — one tap, applied to the whole
			    caption family; the weight is DEFAULT_TEXT_BORDER_WIDTH. */}
			<ToggleRow
				label="Black border"
				active={borderEnabled}
				onToggle={() => setCaptionBorderEnabled({ editor, enabled: !borderEnabled })}
			/>
			<ToggleRow
				label="Drop shadow"
				active={shadowEnabled}
				onToggle={() => setCaptionShadowEnabled({ editor, enabled: !shadowEnabled })}
			/>
			<TranscriptEditor
				editor={editor}
				selectedRef={selectedCaption?.ref ?? null}
				onSelect={(ref) => onInserted(ref)}
			/>
			<button type="button" className="cc-panel-actions__btn" onClick={handleExportSrt}>
				<span>
					{srtStatus === "copied"
						? "Copied SRT to clipboard"
						: srtStatus === "error"
							? srtText
								? "Copy failed — select text below"
								: "No captions to export"
							: "Export captions as SRT"}
				</span>
			</button>
			{srtStatus === "error" && srtText && (
				<textarea className="cc-text-content-input" rows={4} value={srtText} readOnly aria-label="SRT output" />
			)}
			<div className="cc-param-row">
				<div className="cc-param-row__head">
					<span className="cc-param-row__label">Export format</span>
				</div>
				<div style={{ display: "flex", gap: "var(--cc-space-2)" }}>
					<button
						type="button"
						className="cc-panel-actions__btn"
						onClick={() => setExportFormat("srt")}
						style={{ opacity: exportFormat === "srt" ? 1 : 0.6 }}
					>
						<span>SRT</span>
					</button>
					<button
						type="button"
						className="cc-panel-actions__btn"
						onClick={() => setExportFormat("vtt")}
						style={{ opacity: exportFormat === "vtt" ? 1 : 0.6 }}
					>
						<span>VTT</span>
					</button>
				</div>
			</div>
			<button type="button" className="cc-panel-actions__btn" onClick={handleExportToFile}>
				<span>{exportStatus ?? `Save captions as ${exportFormat.toUpperCase()}`}</span>
			</button>
			<div className="cc-param-row">
				<div className="cc-param-row__head">
					<span className="cc-param-row__label">Import SRT / VTT</span>
				</div>
				<textarea
					className="cc-text-content-input"
					rows={4}
					value={importText}
					placeholder="Paste the contents of an .srt or .vtt file"
					aria-label="SRT or VTT text"
					onChange={(event) => {
						setImportText(event.target.value);
						setImportError(null);
						setImportStatus(null);
					}}
				/>
				<button
					type="button"
					className="cc-panel-actions__btn"
					disabled={importText.trim().length === 0}
					onClick={handleImport}
				>
					<span>{importStatus ?? "Add captions from subtitles"}</span>
				</button>
				<button
					type="button"
					className="cc-panel-actions__btn"
					onClick={handleImportFromFile}
				>
					<span>Import subtitles from file…</span>
				</button>
				{importError && <p className="cc-panel-note">{importError}</p>}
			</div>
		</PanelSheet>
	);
}
