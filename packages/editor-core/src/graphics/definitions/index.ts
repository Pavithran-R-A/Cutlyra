import { graphicsRegistry } from "../registry";
import { arrowGraphicDefinition } from "./arrow";
import {
	pulsingHeartGraphicDefinition,
	spinningStarGraphicDefinition,
	bouncingArrowGraphicDefinition,
	confettiGraphicDefinition,
	rotatingRingGraphicDefinition,
	checkmarkPopGraphicDefinition,
} from "./animated";
import { ellipseGraphicDefinition } from "./ellipse";
import { heartGraphicDefinition } from "./heart";
import { polygonGraphicDefinition } from "./polygon";
import { rectangleGraphicDefinition } from "./rectangle";
import { starGraphicDefinition } from "./star";

const defaultGraphicDefinitions = [
	rectangleGraphicDefinition,
	ellipseGraphicDefinition,
	polygonGraphicDefinition,
	starGraphicDefinition,
	heartGraphicDefinition,
	arrowGraphicDefinition,
	pulsingHeartGraphicDefinition,
	spinningStarGraphicDefinition,
	bouncingArrowGraphicDefinition,
	confettiGraphicDefinition,
	rotatingRingGraphicDefinition,
	checkmarkPopGraphicDefinition,
];

export function registerDefaultGraphics(): void {
	for (const definition of defaultGraphicDefinitions) {
		if (graphicsRegistry.has(definition.id)) {
			continue;
		}
		graphicsRegistry.register({
			key: definition.id,
			definition,
		});
	}
}

export {
	arrowGraphicDefinition,
	bouncingArrowGraphicDefinition,
	checkmarkPopGraphicDefinition,
	confettiGraphicDefinition,
	ellipseGraphicDefinition,
	heartGraphicDefinition,
	polygonGraphicDefinition,
	pulsingHeartGraphicDefinition,
	rectangleGraphicDefinition,
	rotatingRingGraphicDefinition,
	spinningStarGraphicDefinition,
	starGraphicDefinition,
};
export { STROKE_ALIGN_PARAM } from "./shared";
