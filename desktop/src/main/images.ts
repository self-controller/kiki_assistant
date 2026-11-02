// Screenshots with their size, for clicks at coordinates: the model sees the screenshot, so its coordinates are
// pixels in it, and Kiki maps them back to the window or page.
import type { Screenshot } from "@kiki/shared";
import { nativeImage, type NativeImage } from "electron";
import { toScreenshot } from "./capture/common.ts";

export interface ScreenshotSize {
  width: number;
  height: number;
}

export interface SizedScreenshot {
  screenshot: Screenshot;
  size: ScreenshotSize;
}

/** Downscales and encodes `image` like `toScreenshot`, and says how big the result is. */
export function sizedScreenshot(image: NativeImage): SizedScreenshot | undefined {
  const screenshot = toScreenshot(image);
  if (!screenshot) return undefined;
  const scaled = nativeImage.createFromBuffer(Buffer.from(screenshot.data, "base64"));
  const size = scaled.isEmpty() ? image.getSize() : scaled.getSize();
  return { screenshot, size: { width: size.width, height: size.height } };
}

/** A screenshot Kiki already has (base64), with its size. */
export function measure(screenshot: Screenshot): SizedScreenshot | undefined {
  const image = nativeImage.createFromBuffer(Buffer.from(screenshot.data, "base64"));
  if (image.isEmpty()) return undefined;
  const { width, height } = image.getSize();
  return { screenshot, size: { width, height } };
}

/** A point in a screenshot as a fraction (0 to 1) of its width and height. */
export function fractionOf(point: { x: number; y: number }, size: ScreenshotSize): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp(point.x / Math.max(1, size.width)), y: clamp(point.y / Math.max(1, size.height)) };
}
