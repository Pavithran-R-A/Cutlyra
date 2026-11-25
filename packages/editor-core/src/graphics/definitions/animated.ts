import type { ParamDefinition } from "@/params";
import { STROKE_ALIGN_PARAM, resolveStrokeAlign, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition, GraphicRenderContext } from "../types";

function pulse(time: number, period = 1): number {
	const t = (time % period) / period;
	return 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
}

function spin(time: number, speed = 1): number {
	return (time * speed * Math.PI * 2) % (Math.PI * 2);
}

// Pulsing heart
const PULSING_HEART_PARAMS: ParamDefinition<any>[] = [
	{ key: "fill", label: "Fill", type: "color", default: "#ff3b6f" },
	{ key: "stroke", label: "Stroke", type: "color", default: "#000000", group: "stroke" },
	{ key: "strokeWidth", label: "Width", type: "number", default: 0, min: 0, max: 64, step: 1, group: "stroke" },
];

export const pulsingHeartGraphicDefinition: GraphicDefinition = {
	id: "pulsing-heart",
	name: "Pulsing heart",
	keywords: ["heart", "pulse", "animated", "love"],
	params: PULSING_HEART_PARAMS,
	animated: true,
	render({ ctx, params, width, height, time = 0 }) {
		const fill = String(params.fill ?? "#ff3b6f");
		const s = 0.7 + 0.3 * pulse(time, 0.8);
		const size = Math.min(width, height) * 0.4 * s;
		const cx = width / 2;
		const cy = height / 2;
		ctx.clearRect(0, 0, width, height);
		const path = new Path2D();
		const bottom = cy + size * 0.34;
		const notch = cy - size * 0.2;
		path.moveTo(cx, bottom);
		path.bezierCurveTo(cx + size * 0.56, cy + size * 0.02, cx + size * 0.44, cy - size * 0.44, cx, notch);
		path.bezierCurveTo(cx - size * 0.44, cy - size * 0.44, cx - size * 0.56, cy + size * 0.02, cx, bottom);
		path.closePath();
		ctx.fillStyle = fill;
		ctx.fill(path);
	},
};

// Spinning star
export const spinningStarGraphicDefinition: GraphicDefinition = {
	id: "spinning-star",
	name: "Spinning star",
	keywords: ["star", "spin", "animated", "rotate"],
	params: [
		{ key: "fill", label: "Fill", type: "color", default: "#ffd43b" },
	],
	animated: true,
	render({ ctx, params, width, height, time = 0 }) {
		const fill = String(params.fill ?? "#ffd43b");
		const cx = width / 2;
		const cy = height / 2;
		const r = Math.min(width, height) * 0.4;
		ctx.clearRect(0, 0, width, height);
		ctx.save();
		ctx.translate(cx, cy);
		ctx.rotate(spin(time, 0.5));
		// 5-point star
		ctx.beginPath();
		for (let i = 0; i < 10; i++) {
			const ang = (i * Math.PI) / 5 - Math.PI / 2;
			const rad = i % 2 === 0 ? r : r * 0.45;
			const x = Math.cos(ang) * rad;
			const y = Math.sin(ang) * rad;
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.closePath();
		ctx.fillStyle = fill;
		ctx.fill();
		ctx.restore();
	},
};

// Bouncing arrow
export const bouncingArrowGraphicDefinition: GraphicDefinition = {
	id: "bouncing-arrow",
	name: "Bouncing arrow",
	keywords: ["arrow", "bounce", "animated"],
	params: [
		{ key: "fill", label: "Fill", type: "color", default: "#4dabf7" },
	],
	animated: true,
	render({ ctx, params, width, height, time = 0 }) {
		const fill = String(params.fill ?? "#4dabf7");
		const cx = width / 2;
		const baseY = height * 0.7;
		const bounce = Math.abs(Math.sin(time * Math.PI * 2)) * height * 0.15;
		const y = baseY - bounce;
		ctx.clearRect(0, 0, width, height);
		// arrow body
		ctx.fillStyle = fill;
		ctx.fillRect(cx - width * 0.06, y - height * 0.3, width * 0.12, height * 0.3);
		// arrow head
		ctx.beginPath();
		ctx.moveTo(cx - width * 0.2, y - height * 0.3);
		ctx.lineTo(cx, y - height * 0.45);
		ctx.lineTo(cx + width * 0.2, y - height * 0.3);
		ctx.closePath();
		ctx.fill();
	},
};

// Confetti burst
export const confettiGraphicDefinition: GraphicDefinition = {
	id: "confetti",
	name: "Confetti",
	keywords: ["confetti", "celebration", "party", "animated"],
	params: [],
	animated: true,
	render({ ctx, width, height, time = 0 }) {
		ctx.clearRect(0, 0, width, height);
		const colors = ["#ff6b6b", "#ffd43b", "#51cf66", "#339af0", "#cc5de8"];
		const count = 24;
		for (let i = 0; i < count; i++) {
			const seed = i * 137.5;
			const ang = seed % (Math.PI * 2);
			const radius = ((time * 0.6 + i * 0.05) % 1) * Math.min(width, height) * 0.45;
			const x = width / 2 + Math.cos(ang) * radius;
			const y = height / 2 + Math.sin(ang) * radius - time * 20;
			const size = 4 + (i % 3) * 2;
			ctx.fillStyle = colors[i % colors.length];
			ctx.fillRect(x, ((y % height) + height) % height, size, size);
		}
	},
};

// Rotating ring (loading)
export const rotatingRingGraphicDefinition: GraphicDefinition = {
	id: "rotating-ring",
	name: "Rotating ring",
	keywords: ["ring", "loading", "spinner", "animated"],
	params: [
		{ key: "color", label: "Color", type: "color", default: "#ffffff" },
	],
	animated: true,
	render({ ctx, params, width, height, time = 0 }) {
		const color = String(params.color ?? "#ffffff");
		const cx = width / 2;
		const cy = height / 2;
		const r = Math.min(width, height) * 0.35;
		ctx.clearRect(0, 0, width, height);
		ctx.strokeStyle = color;
		ctx.lineWidth = Math.max(2, r * 0.12);
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.arc(cx, cy, r, spin(time, 1), spin(time, 1) + Math.PI * 1.2);
		ctx.stroke();
	},
};

// Fade-in checkmark
export const checkmarkPopGraphicDefinition: GraphicDefinition = {
	id: "checkmark-pop",
	name: "Checkmark pop",
	keywords: ["check", "success", "done", "animated"],
	params: [
		{ key: "color", label: "Color", type: "color", default: "#51cf66" },
	],
	animated: true,
	render({ ctx, params, width, height, time = 0 }) {
		const color = String(params.color ?? "#51cf66");
		const p = Math.min(1, time * 2);
		const scale = p < 1 ? 0.5 + 0.5 * (1 - Math.pow(1 - p, 3)) : 1;
		const cx = width / 2;
		const cy = height / 2;
		const r = Math.min(width, height) * 0.35 * scale;
		ctx.clearRect(0, 0, width, height);
		ctx.strokeStyle = color;
		ctx.lineWidth = Math.max(3, r * 0.18);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.beginPath();
		ctx.moveTo(cx - r * 0.5, cy);
		ctx.lineTo(cx - r * 0.1, cy + r * 0.4);
		ctx.lineTo(cx + r * 0.55, cy - r * 0.4);
		ctx.stroke();
	},
};