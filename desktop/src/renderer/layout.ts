// The chat box's motion inside the popup window. Pure functions, so they're testable. The window's
// size and where the box sits in it live in the GNOME extension's placement.js, which everything shares.
import { CARD_WIDTH, INSETS } from "../../resources/gnome-extension/kiki-popup@kiki.app/placement.js";

export { cardBottomIn, CARD_WIDTH, INSETS } from "../../resources/gnome-extension/kiki-popup@kiki.app/placement.js";

export const POPUP_WIDTH = INSETS.left + CARD_WIDTH + INSETS.right;

/** The chat box follows its content like a spring: stiffness 120, damping 18 (a soft, slight bounce). */
const STIFFNESS = 120;
const DAMPING = 18;
const OMEGA = Math.sqrt(STIFFNESS);
const ZETA = DAMPING / (2 * OMEGA);
const OMEGA_D = OMEGA * Math.sqrt(1 - ZETA * ZETA);

export interface Spring {
  value: number;
  velocity: number;
}

/**
 * Moves the spring `dtMs` toward `target`. It's the exact solution of the (underdamped) spring, so
 * the motion doesn't depend on the frame rate.
 */
export function springStep(spring: Spring, target: number, dtMs: number): Spring {
  const t = dtMs / 1000;
  const x0 = spring.value - target;
  const v0 = spring.velocity;
  const decay = Math.exp(-ZETA * OMEGA * t);
  const cos = Math.cos(OMEGA_D * t);
  const sin = Math.sin(OMEGA_D * t);
  const b = (v0 + ZETA * OMEGA * x0) / OMEGA_D;
  return {
    value: target + decay * (x0 * cos + b * sin),
    velocity: decay * (v0 * cos - (ZETA * OMEGA * b + OMEGA_D * x0) * sin),
  };
}
