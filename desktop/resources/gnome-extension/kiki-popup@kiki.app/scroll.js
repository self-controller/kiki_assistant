// Where Kiki's GNOME extension scrolls a window. Plain JavaScript with no imports, so the extension and the
// tests share it. Screen coordinates throughout.

/**
 * Spots to try, as shares of the window's width and height: its middle first (where a feed or a page's text
 * usually is), then around it, for when something covers the middle.
 */
const SPOTS = [
    [0.5, 0.55], [0.5, 0.35], [0.5, 0.75],
    [0.3, 0.55], [0.7, 0.55],
    [0.3, 0.3], [0.7, 0.3], [0.3, 0.8], [0.7, 0.8],
    [0.12, 0.55], [0.88, 0.55],
];

/**
 * The first spot in `frame` (the window) where `reaches(point)` says a scroll would get to the window, or
 * null when none would.
 */
export function scrollPoint(frame, reaches) {
    for (const [across, down] of SPOTS) {
        const point = {
            x: Math.round(frame.x + frame.width * across),
            y: Math.round(frame.y + frame.height * down),
        };
        if (reaches(point))
            return point;
    }
    return null;
}

/** Whether `point` is inside `rect`. */
export function inside(point, rect) {
    return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}
