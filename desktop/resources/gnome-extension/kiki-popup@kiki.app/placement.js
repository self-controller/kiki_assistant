// Where Kiki's popup window opens and how its chat box sits inside it. Plain JavaScript with no imports,
// so the GNOME Shell extension, the Electron main process, the popup page and the tests all share it.
// Screen coordinates throughout; work areas can start anywhere (other monitors, the top bar).

/** The chat box's width. */
export const CARD_WIDTH = 440;
/** Transparent space around the chat box: Kiki sits on top of it, its shadow and ✕ use the rest. */
export const INSETS = { top: 40, right: 16, bottom: 16, left: 16 };
/** Gap between the pointer and the chat box's corner. */
export const GAP = 6;
const MAX_CARD = 560;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/** The tallest the chat box grows on a work area this tall, before its conversation scrolls. */
export function maxCardHeight(workAreaHeight) {
  return Math.max(160, Math.min(MAX_CARD, Math.round(workAreaHeight * 0.7)));
}

/**
 * The popup window for a chat box opening `cardHeight` tall at `pointer`. The window is sized once for
 * the tallest box, and never resizes; the box moves inside it. The box opens with its corner at the
 * pointer: below and to the right of it, or above it when there's no room below.
 * `anchorY` is where the box's bottom edge (its input) sits inside the window.
 */
export function popupGeometry(pointer, cardHeight, workArea) {
  const maxCard = maxCardHeight(workArea.height);
  const width = INSETS.left + CARD_WIDTH + INSETS.right;
  const height = INSETS.top + maxCard + INSETS.bottom;
  const right = workArea.x + workArea.width;
  const bottom = workArea.y + workArea.height;

  const x = clamp(pointer.x + GAP - INSETS.left, workArea.x, right - width);
  const fitsBelow = pointer.y + GAP + cardHeight + INSETS.bottom <= bottom;
  const cardBottom = fitsBelow ? pointer.y + GAP + cardHeight : pointer.y - GAP;
  const y = clamp(cardBottom + INSETS.bottom - height, workArea.y, bottom - height);
  return { x, y, width, height, anchorY: clamp(cardBottom - y, INSETS.top, height - INSETS.bottom), maxCard };
}

/**
 * Where the bottom of a chat box `cardHeight` tall sits in a window `windowHeight` tall. It stays at
 * `anchorY` and grows upward; once it reaches the top, it slides down as it keeps growing.
 */
export function cardBottomIn(anchorY, cardHeight, windowHeight) {
  return Math.min(Math.max(anchorY, INSETS.top + cardHeight), windowHeight - INSETS.bottom);
}

/**
 * Whether `pointer` (screen coordinates) is over the part of the popup that takes clicks: `hit`, in the
 * coordinates of a window whose frame is `frame`. A pixel of slop keeps the box's edge clickable.
 */
export function insideHitRect(pointer, frame, hit) {
  const x = pointer.x - frame.x;
  const y = pointer.y - frame.y;
  return x >= hit.x - 1 && x <= hit.x + hit.width + 1 && y >= hit.y - 1 && y <= hit.y + hit.height + 1;
}
