import { useState } from "react";
import type { EditorCore } from "@cutlyra/editor-core";
import { TICKS_PER_SECOND, mediaTimeToSeconds } from "@cutlyra/editor-core";
import type { CaptionElement, ElementRef } from "@cutlyra/editor-core/timeline";
import {
	getAllCaptions,
	mergeCaptionWithNext,
	setCaptionTiming,
	setCaptionWordText,
	splitCaptionAtPlayhead,
} from "../../editor/captions-actions";
import { seekToSeconds, setCaptionText } from "../../editor/actions";
import { captionText as wordsToText } from "../../editor/caption-text";

interface TranscriptEditorProps {
	editor: EditorCore;
	/** The currently selected caption, when it is one. */
	selectedRef: ElementRef | null;
	onSelect: (ref: ElementRef) => void;
}

/** `m:ss.s` — short enough for a cue row, precise enough to see a cut. */
function formatCueTime(seconds: number): string {
	const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	const minutes = Math.floor(safe / 60);
	const rest = safe - minutes * 60;
	return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

function parseSeconds(text: string): number | null {
	const value = Number.parseFloat(text);
	return Number.isFinite(value) ? value : null;
}

/**
 * Transcript editor for the Captions sheet — the part of Phase A that makes
 * imported and generated captions *editable as a transcript* rather than only
 * through the preview.
 *
 * Every mutation goes through the engine's own commands (`UpdateElementsCommand`,
 * `UpdateCaptionWordCommand`, `SplitCaptionCommand`, `MergeCaptionsCommand`), so
 * undo/redo, project persistence and the native EDL export all see the same
 * state as every other edit — there is no panel-local caption copy.
 *
 * Text fields keep a local draft and commit on blur/Enter: typing stays
 * responsive and one corrected cue is one undo step, not one per keystroke.
 */
export function TranscriptEditor({ editor, selectedRef, onSelect }: TranscriptEditorProps) {
	const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
	const [timingDrafts, setTimingDrafts] = useState<
		Record<string, { start: string; end: string }>
	>({});
	const [wordDrafts, setWordDrafts] = useState<Record<string, string>>({});
	const [notice, setNotice] = useState<string | null>(null);

	const cues = getAllCaptions({ editor }).sort(
		(a, b) => a.element.startTime - b.element.startTime,
	);
	const playheadSeconds = mediaTimeToSeconds({ time: editor.playback.getCurrentTime() });

	if (cues.length === 0) {
		return (
			<p className="cc-panel-note">
				No captions yet. Generate them, import an .srt/.vtt file, or add subtitles from
				pasted text above.
			</p>
		);
	}

	const commitText = (entry: { trackId: string; element: CaptionElement }) => {
		const draft = textDrafts[entry.element.id];
		if (draft === undefined) return;
		if (draft.trim().length === 0) return;
		if (draft === wordsToText(entry.element.words)) return;
		setCaptionText({
			editor,
			ref: { trackId: entry.trackId, elementId: entry.element.id },
			words: entry.element.words,
			text: draft,
		});
	};

	const commitTiming = (entry: { trackId: string; element: CaptionElement }) => {
		const draft = timingDrafts[entry.element.id];
		if (!draft) return;
		const start = parseSeconds(draft.start);
		const end = parseSeconds(draft.end);
		if (start === null || end === null) {
			setNotice("Enter cue times in seconds, e.g. 1.5 and 4.0.");
			return;
		}
		if (end <= start) {
			setNotice("The cue end must be after its start.");
			return;
		}
		setNotice(null);
		setCaptionTiming({
			editor,
			ref: { trackId: entry.trackId, elementId: entry.element.id },
			startSeconds: start,
			endSeconds: end,
		});
	};

	const commitWord = ({
		entry,
		index,
	}: {
		entry: { trackId: string; element: CaptionElement };
		index: number;
	}) => {
		const key = `${entry.element.id}:${index}`;
		const draft = wordDrafts[key];
		if (draft === undefined) return;
		const next = draft.trim();
		if (!next || next === entry.element.words[index]?.text) return;
		setCaptionWordText({
			editor,
			ref: { trackId: entry.trackId, elementId: entry.element.id },
			wordIndex: index,
			text: next,
		});
	};

	return (
		<div className="cc-transcript">
			<p className="cc-panel-note">
				Tap a cue to jump the playhead there. Edit its text or timing, split it at
				the playhead, or merge it with the next cue — all undoable.
			</p>
			{notice && <p className="cc-panel-note">{notice}</p>}
			{cues.map((entry) => {
				const startSeconds = entry.element.startTime / TICKS_PER_SECOND;
				const endSeconds = startSeconds + entry.element.duration / TICKS_PER_SECOND;
				const selected = selectedRef?.elementId === entry.element.id;
				const timing = timingDrafts[entry.element.id] ?? {
					start: startSeconds.toFixed(2),
					end: endSeconds.toFixed(2),
				};
				return (
					<div
						key={entry.element.id}
						className="cc-transcript__cue"
						style={{
							borderTop: "1px solid rgba(255,255,255,0.08)",
							paddingTop: "var(--cc-space-2)",
							marginTop: "var(--cc-space-2)",
						}}
					>
						<button
							type="button"
							className="cc-panel-actions__btn"
							aria-label={`Seek to cue ${formatCueTime(startSeconds)}`}
							onClick={() => {
								onSelect({ trackId: entry.trackId, elementId: entry.element.id });
								seekToSeconds({ editor, seconds: startSeconds });
							}}
						>
							<span>
								{formatCueTime(startSeconds)} – {formatCueTime(endSeconds)}
								{selected ? " · selected" : ""}
							</span>
						</button>
						<textarea
							className="cc-text-content-input"
							rows={2}
							aria-label={`Cue text at ${formatCueTime(startSeconds)}`}
							value={
								textDrafts[entry.element.id] ?? wordsToText(entry.element.words)
							}
							onChange={(event) =>
								setTextDrafts((prev) => ({
									...prev,
									[entry.element.id]: event.target.value,
								}))
							}
							onBlur={() => commitText(entry)}
						/>
						{selected && (
							<>
								<div className="cc-param-row">
									<div className="cc-param-row__head">
										<span className="cc-param-row__label">Cue timing (seconds)</span>
									</div>
									<div style={{ display: "flex", gap: "var(--cc-space-2)" }}>
										<input
											className="cc-text-content-input"
											inputMode="decimal"
											aria-label="Cue start seconds"
											value={timing.start}
											onChange={(event) =>
												setTimingDrafts((prev) => ({
													...prev,
													[entry.element.id]: { ...timing, start: event.target.value },
												}))
											}
											onBlur={() => commitTiming(entry)}
										/>
										<input
											className="cc-text-content-input"
											inputMode="decimal"
											aria-label="Cue end seconds"
											value={timing.end}
											onChange={(event) =>
												setTimingDrafts((prev) => ({
													...prev,
													[entry.element.id]: { ...timing, end: event.target.value },
												}))
											}
											onBlur={() => commitTiming(entry)}
										/>
									</div>
								</div>
								<div className="cc-param-row">
									<div className="cc-param-row__head">
										<span className="cc-param-row__label">Words</span>
									</div>
									<div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
										{entry.element.words.map((word, index) => {
											const key = `${entry.element.id}:${index}`;
											return (
												<input
													key={key}
													className="cc-text-content-input"
													style={{ width: "auto", minWidth: 64 }}
													aria-label={`Word ${index + 1} of the selected cue`}
													value={wordDrafts[key] ?? word.text}
													onChange={(event) =>
														setWordDrafts((prev) => ({
															...prev,
															[key]: event.target.value,
														}))
													}
													onBlur={() => commitWord({ entry, index })}
												/>
											);
										})}
									</div>
								</div>
								<div style={{ display: "flex", gap: "var(--cc-space-2)" }}>
									<button
										type="button"
										className="cc-panel-actions__btn"
										disabled={
											playheadSeconds <= startSeconds || playheadSeconds >= endSeconds
										}
										onClick={() => {
											const right = splitCaptionAtPlayhead({
												editor,
												ref: { trackId: entry.trackId, elementId: entry.element.id },
											});
											if (right) {
												onSelect({ trackId: entry.trackId, elementId: right });
											}
										}}
									>
										<span>Split at playhead</span>
									</button>
									<button
										type="button"
										className="cc-panel-actions__btn"
										onClick={() => {
											const merged = mergeCaptionWithNext({
												editor,
												ref: { trackId: entry.trackId, elementId: entry.element.id },
											});
											setNotice(merged ? null : "This is the last cue on the track.");
										}}
									>
										<span>Merge with next</span>
									</button>
								</div>
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}
