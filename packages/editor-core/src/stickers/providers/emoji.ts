import type {
	StickerBrowseResult,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "../types";
import { buildStickerId, parseStickerId } from "../sticker-id";

const EMOJI_PROVIDER_ID = "emoji";

type EmojiPreset = {
	key: string;
	emoji: string;
	name: string;
};

const EMOJI_PRESETS: EmojiPreset[] = [
	{ key: "grinning", emoji: "😀", name: "Grinning face" },
	{ key: "laughing", emoji: "😂", name: "Face with tears of joy" },
	{ key: "heart-eyes", emoji: "😍", name: "Smiling face with heart-eyes" },
	{ key: "wink", emoji: "😉", name: "Winking face" },
	{ key: "thinking", emoji: "🤔", name: "Thinking face" },
	{ key: "thumbs-up", emoji: "👍", name: "Thumbs up" },
	{ key: "thumbs-down", emoji: "👎", name: "Thumbs down" },
	{ key: "heart", emoji: "❤️", name: "Red heart" },
	{ key: "fire", emoji: "🔥", name: "Fire" },
	{ key: "star", emoji: "⭐", name: "Star" },
	{ key: "sparkles", emoji: "✨", name: "Sparkles" },
	{ key: "rocket", emoji: "🚀", name: "Rocket" },
	{ key: "party", emoji: "🎉", name: "Party popper" },
	{ key: "clap", emoji: "👏", name: "Clapping hands" },
	{ key: "pray", emoji: "🙏", name: "Folded hands" },
	{ key: "cool", emoji: "😎", name: "Smiling face with sunglasses" },
	{ key: "sad", emoji: "😢", name: "Crying face" },
	{ key: "angry", emoji: "😠", name: "Angry face" },
	{ key: "skull", emoji: "💀", name: "Skull" },
	{ key: "rainbow", emoji: "🌈", name: "Rainbow" },
];

function buildEmojiSvg({ emoji }: { emoji: string }): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="46" font-size="48" text-anchor="middle" dominant-baseline="middle">${emoji}</text></svg>`;
}

function buildEmojiUrl({ emoji }: { emoji: string }): string {
	return `data:image/svg+xml;utf8,${encodeURIComponent(buildEmojiSvg({ emoji }))}`;
}

function toStickerItem({ preset }: { preset: EmojiPreset }): StickerItem {
	return {
		id: buildStickerId({
			providerId: EMOJI_PROVIDER_ID,
			providerValue: preset.key,
		}),
		provider: EMOJI_PROVIDER_ID,
		name: preset.name,
		previewUrl: buildEmojiUrl({ emoji: preset.emoji }),
		metadata: { emoji: preset.emoji },
	};
}

function filterByQuery({ query }: { query: string }): EmojiPreset[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return EMOJI_PRESETS;
	return EMOJI_PRESETS.filter(
		(preset) =>
			preset.name.toLowerCase().includes(normalized) ||
			preset.key.toLowerCase().includes(normalized),
	);
}

function paginate({
	items,
	options,
}: {
	items: EmojiPreset[];
	options?: { page?: number; limit?: number };
}): { items: EmojiPreset[]; hasMore: boolean; total: number } {
	const page = Math.max(1, options?.page ?? 1);
	const limit = Math.max(1, options?.limit ?? items.length);
	const startIndex = (page - 1) * limit;
	const endIndex = startIndex + limit;
	return {
		items: items.slice(startIndex, endIndex),
		hasMore: endIndex < items.length,
		total: items.length,
	};
}

export function parseEmojiStickerId({
	stickerId,
}: {
	stickerId: string;
}): EmojiPreset | null {
	try {
		const { providerValue } = parseStickerId({ stickerId });
		return EMOJI_PRESETS.find((p) => p.key === providerValue) ?? null;
	} catch {
		return null;
	}
}

export const emojiProvider: StickerProvider = {
	id: EMOJI_PROVIDER_ID,
	async search({
		query,
		options,
	}: {
		query: string;
		options?: { limit?: number };
	}): Promise<StickerSearchResult> {
		const filtered = filterByQuery({ query });
		const paged = paginate({ items: filtered, options });
		return {
			items: paged.items.map((preset) => toStickerItem({ preset })),
			total: paged.total,
			hasMore: paged.hasMore,
		};
	},
	async browse({
		options,
	}: {
		options?: { page?: number; limit?: number };
	}): Promise<StickerBrowseResult> {
		const paged = paginate({ items: EMOJI_PRESETS, options });
		return {
			sections: [
				{
					id: "all",
					items: paged.items.map((preset) => toStickerItem({ preset })),
					hasMore: paged.hasMore,
					layout: "grid",
				},
			],
		};
	},
	resolveUrl({ stickerId }: { stickerId: string }): string {
		const preset = parseEmojiStickerId({ stickerId });
		return buildEmojiUrl({ emoji: preset?.emoji ?? "😀" });
	},
};