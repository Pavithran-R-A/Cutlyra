import { FolderOpen, Mic, Music, Square, X } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import type { EditorCore } from "@cutlyra/editor-core";
import { getLocalSounds } from "@cutlyra/editor-core/sounds/local-sounds";
import { importAndPlaceAudio, insertLocalSound } from "../../editor/actions";
import { useVoiceoverRecorder } from "../../editor/voiceover-recorder";
import { useState } from "react";

interface AudioPanelProps {
	editor: EditorCore;
	onClose: () => void;
	onInserted: (ref: { trackId: string; elementId: string }) => void;
}

function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * M8 Audio panel — plan M8 item 3: "The Freesound proxy... is cut... Ship
 * a small bundled local sound set instead." Lists `getLocalSounds()`
 * (real, zero-network, procedurally-synthesized WAV data URIs — see
 * `sounds/local-sounds.ts`). Per-clip volume/speed/reverse for an inserted
 * sound are the SAME retimable controls the Edit panel exposes once the
 * clip is selected — not duplicated here.
 *
 * The Record row is the voiceover recorder: RECORD_AUDIO at the point of
 * use, a live elapsed clock against the allowed take length, Stop to insert
 * and Cancel to discard. The take is recorded into media custody by the
 * native recorder and committed as an ordinary audio clip, so it mixes into
 * the export through the same audio lane as any other clip (see
 * `media/voiceover.ts` for the documented unity-gain, no-ducking policy).
 */
export function AudioPanel({ editor, onClose, onInserted }: AudioPanelProps) {
	const sounds = getLocalSounds();
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const voiceover = useVoiceoverRecorder({
		editor,
		onInserted: (ref) => {
			onInserted(ref);
			onClose();
		},
	});
	const recording = voiceover.phase === "recording";
	const voiceoverBusy = voiceover.phase === "starting" || voiceover.phase === "saving";
	const busy = importing || recording || voiceoverBusy;
	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			{/* Voiceover: the take is captured by the native recorder into
			    media custody and inserted as a real audio clip. */}
			{recording ? (
				<>
					<div className="cc-voiceover-status">
						<span className="cc-voiceover-status__dot" aria-hidden="true" />
						<span className="cc-voiceover-status__time">
							{formatClock(voiceover.elapsedMs)} / {formatClock(voiceover.limitSeconds * 1000)}
						</span>
						<span className="cc-voiceover-status__label">Recording voiceover</span>
					</div>
					<div className="cc-panel-actions">
						<button
							type="button"
							className="cc-panel-actions__btn"
							onClick={() => void voiceover.stop()}
						>
							<Square size={20} strokeWidth={CC_ICON_STROKE} />
							<span>Stop &amp; add</span>
						</button>
						<button
							type="button"
							className="cc-panel-actions__btn"
							onClick={() => void voiceover.cancel()}
						>
							<X size={20} strokeWidth={CC_ICON_STROKE} />
							<span>Cancel</span>
						</button>
					</div>
				</>
			) : (
				<button
					type="button"
					className="cc-panel-cta"
					disabled={busy}
					onClick={() => void voiceover.start()}
				>
					<Mic size={20} strokeWidth={CC_ICON_STROKE} className="cc-panel-cta__icon" />
					<span>
						{voiceover.phase === "starting"
							? "Opening microphone…"
							: voiceover.phase === "saving"
								? "Adding voiceover…"
								: "Record voiceover"}
					</span>
				</button>
			)}
			{voiceover.phase === "idle" && !voiceover.error && (
				<p className="cc-panel-note">
					Records from the playhead. Recording continues if you switch apps and stops at
					the end of the clip.
				</p>
			)}
			{voiceover.error && <p className="cc-panel-note">{voiceover.error}</p>}
			{/* Round 22 (founder): Files-picker audio import onto the audio
			    track. Native shells open the real document picker; the web
			    harness's fallback bridge reports its own honest error. */}
			<button
				type="button"
				className="cc-panel-actions__btn"
				disabled={busy}
				onClick={() => {
					setImporting(true);
					setImportError(null);
					importAndPlaceAudio({ editor })
						.then((count) => {
							if (count > 0) onClose();
						})
						.catch((error: unknown) =>
							setImportError(error instanceof Error ? error.message : String(error)),
						)
						.finally(() => setImporting(false));
				}}
			>
				<FolderOpen size={20} strokeWidth={CC_ICON_STROKE} />
				<span>{importing ? "Importing…" : "Import audio from Files"}</span>
			</button>
			{importError && <p className="cc-panel-note">{importError}</p>}
			<p className="cc-panel-note">Bundled local sounds — no network, no CapCut library clone.</p>
			<div className="cc-panel-actions">
				{sounds.map((sound) => (
					<button
						key={sound.id}
						type="button"
						className="cc-panel-actions__btn"
						disabled={busy}
						onClick={() => {
							// #63: insertion materializes the sound into native custody
							// before placing it, so the export sees the same rows.
							setImporting(true);
							setImportError(null);
							insertLocalSound({
								editor,
								sourceUrl: sound.sourceUrl,
								name: sound.name,
								durationSeconds: sound.durationSeconds,
							})
								.then((ref) => {
									if (ref) onInserted(ref);
								})
								.catch((error: unknown) =>
									setImportError(error instanceof Error ? error.message : String(error)),
								)
								.finally(() => setImporting(false));
						}}
					>
						<Music size={20} strokeWidth={CC_ICON_STROKE} />
						<span>{importing ? "Adding…" : sound.name}</span>
					</button>
				))}
			</div>
		</PanelSheet>
	);
}
