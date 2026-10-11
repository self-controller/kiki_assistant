// Which part of the screen Kiki's GNOME extension captures for context. Plain JavaScript with no
// imports, so the extension and the tests share it. Screen coordinates throughout.

/** Share of the crop above the pointer: what explains a highlight is usually above it. */
const ABOVE = 2 / 3;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/**
 * At most `maxWidth`×`maxHeight` of `area` (the focused window) around `pointer`: centered on it
 * across, mostly above it, and moved inside the area at its edges. All of `area` when the pointer
 * is outside it.
 */
export function cropAround(pointer, area, maxWidth, maxHeight) {
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  if (pointer.x < area.x || pointer.x >= right || pointer.y < area.y || pointer.y >= bottom)
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  const width = Math.min(area.width, maxWidth);
  const height = Math.min(area.height, maxHeight);
  return {
    x: clamp(Math.round(pointer.x - width / 2), area.x, right - width),
    y: clamp(Math.round(pointer.y - height * ABOVE), area.y, bottom - height),
    width,
    height,
  };
}
