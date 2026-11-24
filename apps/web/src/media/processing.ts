import { toast } from "sonner";
import { getMediaTypeFromFile } from "@/media/media-utils";
import { formatStorageBytes } from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import type { MediaAsset } from "@/media/types";
import { readVideoFile } from "./mediabunny";
import type { VideoFileData } from "./mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";
import {
	gifMetadataFromDecode,
	gifPlaybackDurationSeconds,
	type GifAssetMetadata,
} from "@/media/gif-asset";
import { decodeGif } from "@/media/gif-decoder";
import { gifFrameImageData } from "@/media/gif-frames";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

const getUnsupportedVideoDescription = ({
	codec,
}: {
	codec: VideoFileData["codec"];
}): string => {
	const codecLabel = codec ? codec.toUpperCase() : "this video codec";

	return codec === "hevc"
		? `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 or try importing it in Safari.`
		: `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 and reimport it.`;
};

const getStorageLimitDescription = ({
	fileSize,
	availableBytes,
}: {
	fileSize: number;
	availableBytes: number | null;
}): string => {
	const fileSizeLabel = formatStorageBytes({ bytes: fileSize });

	if (availableBytes === null) {
		return `File size is ${fileSizeLabel}.`;
	}

	return `File size is ${fileSizeLabel}, but only ${formatStorageBytes({
		bytes: availableBytes,
	})} is safely available in browser storage.`;
};

async function generateImageThumbnail({
	imageFile,
}: {
	imageFile: File;
}): Promise<{ thumbnailUrl: string; width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		const objectUrl = URL.createObjectURL(imageFile);

		image.addEventListener("load", () => {
			try {
				const thumbnailUrl = renderThumbnailDataUrl({
					width: image.naturalWidth,
					height: image.naturalHeight,
					draw: ({ context, width, height }) => {
						context.drawImage(image, 0, 0, width, height);
					},
				});
				resolve({
					thumbnailUrl,
					width: image.naturalWidth,
					height: image.naturalHeight,
				});
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			} finally {
				URL.revokeObjectURL(objectUrl);
				image.remove();
			}
		});

		image.addEventListener("error", () => {
			URL.revokeObjectURL(objectUrl);
			image.remove();
			reject(new Error("Could not load image"));
		});

		image.src = objectUrl;
	});
}

const isGifFile = ({ file }: { file: File }): boolean =>
	file.type === "image/gif" || /\.gif$/i.test(file.name);

/**
 * Decodes an animated GIF into the metadata the renderer needs to play it and
 * a thumbnail of its first frame. Returns null for single-frame GIFs, which
 * the ordinary image path already handles.
 */
async function readAnimatedGif({
	file,
}: {
	file: File;
}): Promise<{
	gif: GifAssetMetadata;
	thumbnailUrl: string;
	width: number;
	height: number;
	duration: number;
} | null> {
	const decoded = await decodeGif(await file.arrayBuffer());
	if (decoded.frames.length < 2) return null;

	const gif = gifMetadataFromDecode(decoded);
	const firstFrame = decoded.frames[0];
	const thumbnailUrl = renderThumbnailDataUrl({
		width: decoded.width,
		height: decoded.height,
		draw: ({ context, width, height }) => {
			const frameCanvas = document.createElement("canvas");
			frameCanvas.width = decoded.width;
			frameCanvas.height = decoded.height;
			const frameContext = frameCanvas.getContext("2d");
			if (!frameContext) throw new Error("Could not get canvas context");
			frameContext.putImageData(
				gifFrameImageData({
					rgba: firstFrame.rgba,
					width: decoded.width,
					height: decoded.height,
				}),
				0,
				0,
			);
			context.drawImage(frameCanvas, 0, 0, width, height);
		},
	});

	return {
		gif,
		thumbnailUrl,
		width: decoded.width,
		height: decoded.height,
		duration: gifPlaybackDurationSeconds(gif),
	};
}

export async function processMediaAssets({
	files,
	onProgress,
}: {
	files: FileList | File[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const fileArray = Array.from(files);
	const processedAssets: ProcessedMediaAsset[] = [];

	const total = fileArray.length;
	let completed = 0;

	for (const file of fileArray) {
		const fileType = getMediaTypeFromFile({ file });

		if (!fileType) {
			toast.error(`Unsupported file type: ${file.name}`);
			continue;
		}

		const storageCheck = await storageService.canStoreFile({
			size: file.size,
		});

		if (!storageCheck.canStore) {
			toast.error(`Not enough browser storage for ${file.name}`, {
				description: getStorageLimitDescription({
					fileSize: file.size,
					availableBytes: storageCheck.availableBytes,
				}),
			});
			continue;
		}

		const url = URL.createObjectURL(file);
		let thumbnailUrl: string | undefined;
		let duration: number | undefined;
		let width: number | undefined;
		let height: number | undefined;
		let fps: number | undefined;
		let hasAudio: boolean | undefined;
		let gif: GifAssetMetadata | undefined;

		try {
			if (fileType === "image") {
				if (isGifFile({ file })) {
					try {
						const animated = await readAnimatedGif({ file });
						if (animated) {
							gif = animated.gif;
							thumbnailUrl = animated.thumbnailUrl;
							width = animated.width;
							height = animated.height;
							duration = animated.duration;
						}
					} catch (error) {
						console.error("Could not decode GIF animation:", file.name, error);
						toast.error(`Couldn't animate ${file.name}`, {
							description: "Importing it as a still image instead.",
						});
					}
				}

				if (!gif) {
					const result = await generateImageThumbnail({ imageFile: file });
					thumbnailUrl = result.thumbnailUrl;
					width = result.width;
					height = result.height;
				}
			} else if (fileType === "video") {
				try {
					const videoData = await readVideoFile({ file });
					duration = videoData.duration;
					width = videoData.width;
					height = videoData.height;
					fps = Number.isFinite(videoData.fps)
						? Math.round(videoData.fps)
						: undefined;
					hasAudio = videoData.hasAudio;
					thumbnailUrl = videoData.thumbnailUrl ?? undefined;

					if (!videoData.canDecode) {
						toast.error(`Can't preview ${file.name}`, {
							description: getUnsupportedVideoDescription({
								codec: videoData.codec,
							}),
						});
					}
				} catch (error) {
					const message =
						error instanceof Error
							? error.message
							: "Could not process video";

					toast.error(`Couldn't process ${file.name}`, {
						description: message,
					});
				}
			} else if (fileType === "audio") {
				duration = await getMediaDuration({ file });
			}

			processedAssets.push({
				name: file.name,
				type: fileType,
				file,
				url,
				thumbnailUrl,
				duration,
				width,
				height,
				fps,
				hasAudio,
				...(gif && { gif }),
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			completed += 1;
			if (onProgress) {
				const percent = Math.round((completed / total) * 100);
				onProgress({ progress: percent });
			}
		} catch (error) {
			console.error("Error processing file:", file.name, error);
			toast.error(`Failed to process ${file.name}`);
			URL.revokeObjectURL(url);
		}
	}

	return processedAssets;
}

const getMediaDuration = ({ file }: { file: File }): Promise<number> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement(
			file.type.startsWith("video/") ? "video" : "audio",
		);
		if (!(element instanceof HTMLMediaElement)) {
			reject(new Error("Unsupported media element"));
			return;
		}
		const objectUrl = URL.createObjectURL(file);

		element.addEventListener("loadedmetadata", () => {
			resolve(element.duration);
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.addEventListener("error", () => {
			reject(new Error("Could not load media"));
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.src = objectUrl;
		element.load();
	});
};
