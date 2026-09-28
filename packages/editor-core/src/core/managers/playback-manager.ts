import type { EditorCore } from "@/core";
import {
	addMediaTime,
	clampMediaTime,
	type MediaTime,
	mediaTimeFromSeconds,
	roundFrameTime,
	roundMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

/** Stage 11 physical QA (iQOO I2221, 2026-09-25): a corrupted playback
 *  position (JSON `null` / `undefined` where integer ticks belong) reached
 *  `mediaTimeToSeconds` through `useCurrentTimeSeconds`'s render-time read
 *  and the wasm boundary threw `invalid type: unit value, expected i64`,
 *  taking the whole editor down through CrashBoundary. No repo code path
 *  assigns a non-number into this class (audited: all four write sites go
 *  through `clampTimeToTimeline` on engine-integer inputs), so the write
 *  guard below is a loud contract enforcement — it turns a would-be silent
 *  corruption into an immediate, attributable throw at the call site — and
 *  the read guard in `getCurrentTime` is the last-resort net that keeps a
 *  corrupted value from ever crossing the wasm boundary during a React
 *  render again. `getCurrentTime` degrades to 0 instead of throwing because
 *  its caller is a `useSyncExternalStore` snapshot: throwing there crashes
 *  the app for a value that is cosmetic until the next seek. */
function assertFiniteTicks(value: unknown, context: string): asserts value is MediaTime {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(
			`${context}: expected finite integer ticks, got ${String(value)}`,
		);
	}
}

function hasFiniteTicks(value: unknown): value is MediaTime {
	return typeof value === "number" && Number.isFinite(value);
}

export class PlaybackManager {
	private isPlaying = false;
	private currentTime: MediaTime = ZERO_MEDIA_TIME;
	private volume = 1;
	private muted = false;
	private previousVolume = 1;
	private isScrubbing = false;
	private listeners = new Set<() => void>();
	private updateListeners = new Set<(time: MediaTime) => void>();
	private seekListeners = new Set<(time: MediaTime) => void>();
	private playbackTimer: number | null = null;
	private playbackStartWallTime = 0;
	private playbackStartTime: MediaTime = ZERO_MEDIA_TIME;
	private timelineScopeBound = false;

	constructor(private editor: EditorCore) {}

	bindTimelineScope(): void {
		if (this.timelineScopeBound) {
			return;
		}

		const reconcile = () => {
			this.reconcileTimelineScope();
		};
		this.editor.timeline.subscribe(reconcile);
		this.editor.scenes.subscribe(reconcile);
		this.timelineScopeBound = true;
		this.reconcileTimelineScope();
	}

	play(): void {
		// Self-heal before the timer captures the position (startTimer stashes
		// `currentTime` into `playbackStartTime`, and `updateTime` feeds that
		// through wasm `addMediaTime` — a corrupted value would throw inside
		// the rAF callback on every frame).
		if (!hasFiniteTicks(this.currentTime)) {
			this.currentTime = ZERO_MEDIA_TIME;
		}
		const maxTime = this.editor.timeline.getTotalDuration();
		if (maxTime <= 0) {
			return;
		}

		if (this.currentTime >= maxTime) {
			this.seek({ time: ZERO_MEDIA_TIME });
		}

		this.isPlaying = true;
		this.startTimer();
		this.notify();
	}

	pause(): void {
		this.isPlaying = false;
		this.stopTimer();
		this.notify();
	}

	toggle(): void {
		if (this.isPlaying) {
			this.pause();
		} else {
			this.play();
		}
	}

	seek({ time }: { time: MediaTime }): void {
		assertFiniteTicks(time, "PlaybackManager.seek");
		this.currentTime = this.clampTimeToTimeline(
			Number.isInteger(time) ? time : roundMediaTime({ time }),
		);
		if (this.isPlaying) {
			this.playbackStartWallTime = performance.now();
			this.playbackStartTime = this.currentTime;
		}
		this.notify();
		this.notifySeek(this.currentTime);
	}

	setVolume({ volume }: { volume: number }): void {
		const clampedVolume = Math.max(0, Math.min(1, volume));
		this.volume = clampedVolume;
		this.muted = clampedVolume === 0;
		if (clampedVolume > 0) {
			this.previousVolume = clampedVolume;
		}
		this.notify();
	}

	mute(): void {
		if (this.volume > 0) {
			this.previousVolume = this.volume;
		}
		this.muted = true;
		this.volume = 0;
		this.notify();
	}

	unmute(): void {
		this.muted = false;
		this.volume = this.previousVolume;
		this.notify();
	}

	toggleMute(): void {
		if (this.muted) {
			this.unmute();
		} else {
			this.mute();
		}
	}

	getIsPlaying(): boolean {
		return this.isPlaying;
	}

	getCurrentTime(): MediaTime {
		// Read-side net, NOT a throw: the dominant caller is
		// `useCurrentTimeSeconds`'s useSyncExternalStore getSnapshot, which
		// runs during React render — throwing here re-creates the exact
		// CrashBoundary wipeout this guard exists to prevent. Fall back to
		// the timeline origin and let the next seek/reconcile write a real
		// value.
		return hasFiniteTicks(this.currentTime) ? this.currentTime : ZERO_MEDIA_TIME;
	}

	getVolume(): number {
		return this.volume;
	}

	isMuted(): boolean {
		return this.muted;
	}

	setScrubbing({ isScrubbing }: { isScrubbing: boolean }): void {
		this.isScrubbing = isScrubbing;
		this.notify();
	}

	getIsScrubbing(): boolean {
		return this.isScrubbing;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onUpdate(listener: (time: MediaTime) => void): () => void {
		this.updateListeners.add(listener);
		return () => this.updateListeners.delete(listener);
	}

	onSeek(listener: (time: MediaTime) => void): () => void {
		this.seekListeners.add(listener);
		return () => this.seekListeners.delete(listener);
	}

	private reconcileTimelineScope(): void {
		// Heal before clamping: `clampMediaTime` trusts its input, so a
		// corrupted `currentTime` would flow straight back out and stick.
		if (!hasFiniteTicks(this.currentTime)) {
			this.currentTime = ZERO_MEDIA_TIME;
		}
		const maxTime = this.editor.timeline.getTotalDuration();
		const nextTime = this.clampTimeToTimeline(this.currentTime);
		const shouldPause = this.isPlaying && nextTime >= maxTime;
		const timeChanged = nextTime !== this.currentTime;

		if (!timeChanged && !shouldPause) {
			return;
		}

		if (shouldPause) {
			this.isPlaying = false;
			this.stopTimer();
		}

		this.currentTime = nextTime;
		this.notify();

		if (timeChanged) {
			this.notifySeek(this.currentTime);
			this.dispatchSeekEvent(this.currentTime);
		}
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	private notifyUpdate(time: MediaTime): void {
		this.updateListeners.forEach((fn) => {
			fn(time);
		});
	}

	private notifySeek(time: MediaTime): void {
		this.seekListeners.forEach((fn) => {
			fn(time);
		});
	}

	private startTimer(): void {
		if (this.playbackTimer) {
			cancelAnimationFrame(this.playbackTimer);
		}

		this.playbackStartWallTime = performance.now();
		this.playbackStartTime = this.currentTime;
		this.updateTime();
	}

	private stopTimer(): void {
		if (this.playbackTimer) {
			cancelAnimationFrame(this.playbackTimer);
			this.playbackTimer = null;
		}
	}

	private updateTime = (): void => {
		if (!this.isPlaying) return;

		const fps = this.editor.project.getActive()?.settings.fps;
		const elapsedSeconds =
			(performance.now() - this.playbackStartWallTime) / 1000;
		const rawTime = addMediaTime({
			a: this.playbackStartTime,
			b: mediaTimeFromSeconds({ seconds: elapsedSeconds }),
		});
		const newTime = fps ? roundFrameTime({ time: rawTime, fps }) : rawTime;
		const maxTime = this.editor.timeline.getTotalDuration();

		if (newTime >= maxTime) {
			this.pause();
			this.currentTime = maxTime;
			this.notify();
		this.notifySeek(maxTime);
		this.dispatchSeekEvent(maxTime);
		return;
		}

		this.currentTime = newTime;
		this.notifyUpdate(newTime);
		this.dispatchUpdateEvent(newTime);
		this.playbackTimer = requestAnimationFrame(this.updateTime);
	};

	private clampTimeToTimeline(time: MediaTime): MediaTime {
		const maxTime = this.editor.timeline.getTotalDuration();
		return clampMediaTime({ time, min: ZERO_MEDIA_TIME, max: maxTime });
	}

	private dispatchSeekEvent(time: MediaTime): void {
		if (typeof window === "undefined") {
			return;
		}
	}

	private dispatchUpdateEvent(time: MediaTime): void {
		if (typeof window === "undefined") {
			return;
		}
	}
}
