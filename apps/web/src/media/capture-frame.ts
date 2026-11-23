/**
 * Web-side frame capture for Freeze Frame.
 *
 * Extracts a single frame from a source video at a given time (seconds) and
 * returns it as a File (PNG) suitable for registration as a media asset.
 * Uses a hidden <video> element + canvas; resolves only after the frame has
 * actually been decoded (seeked) so the captured bitmap is not a black frame.
 */
export interface CaptureFrameOptions {
	src: string;
	timeSeconds: number;
	name?: string;
}

export async function captureFrameFromFile({
	file,
	timeSeconds,
	name,
}: {
	file: File;
	timeSeconds: number;
	name?: string;
}): Promise<File> {
	const url = URL.createObjectURL(file);
	try {
		return await captureFrameFromUrl({ src: url, timeSeconds, name });
	} finally {
		URL.revokeObjectURL(url);
	}
}

export async function captureFrameFromUrl({
	src,
	timeSeconds,
	name = "freeze-frame.png",
}: CaptureFrameOptions): Promise<File> {
	return new Promise<File>((resolve, reject) => {
		const video = document.createElement("video");
		video.crossOrigin = "anonymous";
		video.preload = "auto";
		video.muted = true;
		video.playsInline = true;

		const cleanup = () => {
			video.removeAttribute("src");
			video.load();
		};

		const onSeeked = () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = video.videoWidth || 1;
				canvas.height = video.videoHeight || 1;
				const ctx = canvas.getContext("2d");
				if (!ctx) {
					cleanup();
					reject(new Error("Could not get canvas context"));
					return;
				}
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				canvas.toBlob((blob) => {
					cleanup();
					if (!blob) {
						reject(new Error("Failed to encode frame"));
						return;
					}
					resolve(new File([blob], name, { type: "image/png" }));
				}, "image/png");
			} catch (err) {
				cleanup();
				reject(err);
			}
		};

		video.addEventListener("seeked", onSeeked, { once: true });
		video.addEventListener(
			"error",
			() => {
				cleanup();
				reject(new Error("Failed to load video for frame capture"));
			},
			{ once: true },
		);

		video.src = src;
		video.currentTime = Math.max(0, timeSeconds);
	});
}