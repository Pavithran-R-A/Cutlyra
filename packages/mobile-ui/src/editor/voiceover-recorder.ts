/**
 * Voiceover recording orchestration for the Audio panel.
 *
 * This is the thin, real layer between one Record button and the native
 * recorder: permission at the point of use, the take limit from the playhead,
 * the elapsed-time poll, Stop -> commit, Cancel -> delete. Everything that
 * must survive the take (the asset row, the clip, undo, custody) lives in
 * `@cutlyra/editor-core`'s `media/voiceover.ts`; everything that must survive
 * a process death (the `.wav.tmp`) lives in the native recorder.
 *
 * Defined edge behaviour:
 *  - Permission denied: no recording starts, and the message distinguishes
 *    "ask again" from "blocked in Settings".
 *  - Permission revoked mid-take (or the mic fails): the native capture
 *    thread reports the error through `voiceoverRecordingState`, this hook
 *    stops polling and shows it — no crash, no empty clip.
 *  - The target ends (playhead at the project end): Record is refused with a
 *    message instead of starting a take nobody can see.
 *  - The take hits its limit: native stops itself, the poll sees
 *    `awaitingTake`, and the take is committed from there.
 *  - The app is backgrounded (or the screen locks): recording is
 *    foreground-only. A visibility listener cancels the take, the native
 *    activity lifecycle enforces the same rule when JS is already suspended,
 *    and the poll reports a recorder that vanished — no hidden capture and no
 *    orphan file.
 *  - The sheet is closed mid-take: the take is cancelled and deleted, so the
 *    user never gets an orphan file with no clip.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getNativeBridge } from "@cutlyra/native-bridge";
import type { EditorCore } from "@cutlyra/editor-core";
import {
	commitVoiceoverTake,
	newVoiceoverTakeId,
	pruneUnusedVoiceoverTakes,
	voiceoverTakeLimit,
	VOICEOVER_MAX_TAKE_SECONDS,
	type VoiceoverSource,
} from "@cutlyra/editor-core";
import { calculateTotalDuration } from "@cutlyra/editor-core/timeline";
import { mediaTimeToSeconds } from "@cutlyra/editor-core/wasm";

const POLL_INTERVAL_MS = 150;

export type VoiceoverPhase = "idle" | "starting" | "recording" | "saving";

export interface VoiceoverRecorderState {
	phase: VoiceoverPhase;
	elapsedMs: number;
	/** Seconds this take may run (5 min, or what is left of the project). */
	limitSeconds: number;
	error: string | null;
}

const IDLE: VoiceoverRecorderState = {
	phase: "idle",
	elapsedMs: 0,
	limitSeconds: VOICEOVER_MAX_TAKE_SECONDS,
	error: null,
};

/** Turns a bridge/native failure into something a user can act on. */
function describeVoiceoverError(error: unknown): string {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: "";
	switch (code) {
		case "PERMISSION_DENIED":
			return "Microphone permission was not granted, so nothing was recorded.";
		case "LOW_STORAGE":
			return "Not enough free storage to record a voiceover. Free some space and try again.";
		case "ALREADY_RECORDING":
			return "A voiceover take is already recording.";
		case "MIC_UNAVAILABLE":
			return "The microphone is unavailable — another app may be using it.";
		case "TOO_SHORT":
			return "That take was too short to keep. Hold Record for at least a quarter second.";
		case "NO_TAKE":
			return "There was no take to save.";
		case "TIMEOUT":
			return "The recorder did not stop in time. Nothing was inserted.";
		case "CANCELLED":
			return "Recording was cancelled.";
		default:
			return error instanceof Error ? error.message : String(error);
	}
}

export function useVoiceoverRecorder({
	editor,
	onInserted,
}: {
	editor: EditorCore;
	onInserted: (ref: { trackId: string; elementId: string }) => void;
}) {
	const [state, setState] = useState<VoiceoverRecorderState>(IDLE);
	const phaseRef = useRef<VoiceoverPhase>("idle");
	const startSecondsRef = useRef(0);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const stoppingRef = useRef(false);

	const setPhase = useCallback((phase: VoiceoverPhase) => {
		phaseRef.current = phase;
	}, []);

	const stopPolling = useCallback(() => {
		if (pollRef.current !== null) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	/** Collects the finished take and inserts it as project state. */
	const finishTake = useCallback(async () => {
		if (stoppingRef.current) return;
		stoppingRef.current = true;
		stopPolling();
		setPhase("saving");
		setState((previous) => ({ ...previous, phase: "saving" }));
		try {
			const bridge = await getNativeBridge();
			const take = await bridge.stopVoiceoverRecording();
			const committed = await commitVoiceoverTake({
				editor,
				projectId: editor.project.getActive().metadata.id,
				source: bridge,
				take,
				startSeconds: startSecondsRef.current,
			});
			if (!committed) {
				setState({
					...IDLE,
					error: "Voiceovers need the Cutlyra app's media storage — nothing was inserted.",
				});
				return;
			}
			// Take files whose clips were undone/deleted are garbage now; sweep
			// them off the hot path (never blocks the insert).
			void pruneUnusedVoiceoverTakes({
				editor,
				source: bridge as VoiceoverSource,
			}).catch(() => undefined);
			setState(IDLE);
			setPhase("idle");
			onInserted({ trackId: committed.trackId, elementId: committed.elementId });
		} catch (error) {
			setState({ ...IDLE, error: describeVoiceoverError(error) });
			setPhase("idle");
		} finally {
			stoppingRef.current = false;
		}
	}, [editor, onInserted, setPhase, stopPolling]);

	const poll = useCallback(() => {
		stopPolling();
		pollRef.current = setInterval(() => {
			void (async () => {
				if (phaseRef.current !== "recording") return;
				try {
					const bridge = await getNativeBridge();
					const snapshot = await bridge.voiceoverRecordingState();
					if (snapshot.errorCode || snapshot.error) {
						stopPolling();
						setState({
							...IDLE,
							error: describeVoiceoverError(
								new Error(snapshot.error ?? "voiceover recording failed"),
							),
						});
						setPhase("idle");
						return;
					}
					if (snapshot.awaitingTake) {
						await finishTake();
						return;
					}
					if (!snapshot.recording) {
						// The native recorder is gone without a take or an error —
						// the activity lifecycle cancelled it while the app was
						// backgrounded. Stop claiming to record.
						stopPolling();
						setState({
							...IDLE,
							error: "Recording stopped because Cutlyra left the foreground.",
						});
						setPhase("idle");
						return;
					}
					setState((previous) =>
						previous.phase === "recording"
							? { ...previous, elapsedMs: snapshot.elapsedMs }
							: previous,
					);
				} catch (error) {
					stopPolling();
					setState({ ...IDLE, error: describeVoiceoverError(error) });
					setPhase("idle");
				}
			})();
		}, POLL_INTERVAL_MS);
	}, [finishTake, setPhase, stopPolling]);

	const start = useCallback(async () => {
		if (phaseRef.current !== "idle") return;
		setPhase("starting");
		setState({ ...IDLE, phase: "starting" });
		try {
			const bridge = await getNativeBridge();
			const permission = await bridge.requestMicrophonePermission();
			if (!permission.granted) {
				setState({
					...IDLE,
					error: permission.canAskAgain
						? "Microphone permission is needed to record a voiceover."
						: "Microphone access is blocked. Enable it in your device settings for Cutlyra, then try again.",
				});
				setPhase("idle");
				return;
			}

			const startSeconds = mediaTimeToSeconds({ time: editor.playback.getCurrentTime() });
			const scene = editor.scenes.getActiveScene();
			const timelineEndSeconds = mediaTimeToSeconds({
				time: calculateTotalDuration({ tracks: scene.tracks }),
			});
			const limit = voiceoverTakeLimit({ startSeconds, timelineEndSeconds });
			if (limit.limitSeconds <= 0) {
				setState({
					...IDLE,
					error: "Move the playhead earlier in the timeline — there is nothing left to record over.",
				});
				setPhase("idle");
				return;
			}

			await bridge.startVoiceoverRecording({
				takeId: newVoiceoverTakeId(),
				maxDurationMs: Math.round(limit.limitSeconds * 1000),
			});
			startSecondsRef.current = startSeconds;
			setState({
				phase: "recording",
				elapsedMs: 0,
				limitSeconds: limit.limitSeconds,
				error: null,
			});
			setPhase("recording");
			poll();
		} catch (error) {
			setState({ ...IDLE, error: describeVoiceoverError(error) });
			setPhase("idle");
		}
	}, [editor, poll, setPhase]);

	const stop = useCallback(async () => {
		if (phaseRef.current !== "recording") return;
		await finishTake();
	}, [finishTake]);

	const cancel = useCallback(async () => {
		if (phaseRef.current !== "recording") return;
		stopPolling();
		setPhase("saving");
		try {
			const bridge = await getNativeBridge();
			await bridge.cancelVoiceoverRecording();
		} catch {
			// Nothing to clean up if the native side already ended the take.
		} finally {
			setState(IDLE);
			setPhase("idle");
		}
	}, [setPhase, stopPolling]);

	// Foreground-only recording. `visibilitychange` fires before the WebView is
	// suspended, so this cancels the take promptly; the native activity
	// lifecycle covers the cases where JS never gets to run (screen lock, OS
	// backgrounding). Cancelling deletes the partial file, so no hidden take
	// survives.
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onVisibilityChange = () => {
			if (document.visibilityState !== "hidden") return;
			if (phaseRef.current !== "recording") return;
			stopPolling();
			setPhase("idle");
			setState({
				...IDLE,
				error: "Recording stopped because Cutlyra left the foreground.",
			});
			void getNativeBridge()
				.then((bridge) => bridge.cancelVoiceoverRecording())
				.catch(() => undefined);
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [setPhase, stopPolling]);

	// Leaving the sheet mid-take discards it: a recorded file with no clip is
	// worse than no recording at all.
	useEffect(() => {
		return () => {
			stopPolling();
			if (phaseRef.current === "recording") {
				void getNativeBridge()
					.then((bridge) => bridge.cancelVoiceoverRecording())
					.catch(() => undefined);
			}
		};
	}, [stopPolling]);

	return {
		...state,
		/** 0..1 of the allowed take length, for the progress hint. */
		progress:
			state.limitSeconds > 0
				? Math.min(1, state.elapsedMs / (state.limitSeconds * 1000))
				: 0,
		start,
		stop,
		cancel,
	};
}
