export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export interface PopupGeometry extends Rect {
  /** Where the chat box's bottom edge sits inside the window. */
  anchorY: number;
  /** The tallest the chat box grows. */
  maxCard: number;
}

export const CARD_WIDTH: number;
export const INSETS: { top: number; right: number; bottom: number; left: number };
export const GAP: number;

export function maxCardHeight(workAreaHeight: number): number;

export function popupGeometry(pointer: Point, cardHeight: number, workArea: Rect): PopupGeometry;

export function cardBottomIn(anchorY: number, cardHeight: number, windowHeight: number): number;
