import type { Point, Rect } from "./placement.js";

export function scrollPoint(frame: Rect, reaches: (point: Point) => boolean): Point | null;
export function inside(point: Point, rect: Rect): boolean;
