// Where fields sit on a page. Every position is a fraction of the page as displayed (0–1 from its top-left corner), so a field
// lands in the same place at any zoom and on any screen. These helpers keep a field inside its page whatever happens to it.
import type { FieldType } from "@/lib/envelopes";

export type Box = { x: number; y: number; w: number; h: number };

/** A new field's size, as a fraction of a portrait US Letter page; `square` fields keep their shape on any page. */
const SIZE: Record<FieldType, { w: number; h: number; square?: boolean }> = {
  signature: { w: 0.28, h: 0.055 },
  initials: { w: 0.1, h: 0.045 },
  date: { w: 0.18, h: 0.03 },
  name: { w: 0.26, h: 0.03 },
  email: { w: 0.3, h: 0.03 },
  text: { w: 0.3, h: 0.03 },
  number: { w: 0.14, h: 0.03 },
  checkbox: { w: 0.032, h: 0.032, square: true },
  radio: { w: 0.22, h: 0.075 },
  dropdown: { w: 0.24, h: 0.03 },
};

/** The smallest a field may be drawn, so it stays something a person can tap. */
export const MIN = { w: 0.02, h: 0.015 };

const clamp01 = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 10000) / 10000;

/** A field's starting size on a page of this displayed shape (height / width). */
export function defaultSize(type: FieldType, pageRatio: number): { w: number; h: number } {
  const s = SIZE[type];
  const letter = 11 / 8.5;
  if (s.square) return { w: s.w, h: round((s.w / pageRatio)) };
  // Heights scale with the page's shape, so a field looks the same on a landscape page.
  return { w: s.w, h: round(s.h * (letter / pageRatio)) };
}

/** Keep a box wholly on its page, moving it rather than shrinking it, and never smaller than MIN. */
export function clampBox(b: Box): Box {
  const w = clamp01(Math.max(b.w, MIN.w));
  const h = clamp01(Math.max(b.h, MIN.h));
  return { x: round(clamp01(b.x, 0, 1 - w)), y: round(clamp01(b.y, 0, 1 - h)), w: round(w), h: round(h) };
}

/** A new field centred where it was dropped or tapped (fractions of the page). */
export function placeAt(type: FieldType, at: { x: number; y: number }, pageRatio: number): Box {
  const { w, h } = defaultSize(type, pageRatio);
  return clampBox({ x: at.x - w / 2, y: at.y - h / 2, w, h });
}

/** A pointer position on a page element, as fractions of it. */
export function fractionOf(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) {
  return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
}

/** Arrow-key nudging: 1% of the page, or 10% with Shift. */
export function nudge(b: Box, key: string, big: boolean): Box | null {
  const step = big ? 0.1 : 0.01;
  const d = key === "ArrowLeft" ? [-step, 0] : key === "ArrowRight" ? [step, 0] : key === "ArrowUp" ? [0, -step] : key === "ArrowDown" ? [0, step] : null;
  if (!d) return null;
  return clampBox({ ...b, x: b.x + d[0], y: b.y + d[1] });
}

/** Resize from the bottom-right corner by a fraction of the page, keeping the field on it. */
export function resize(b: Box, dw: number, dh: number): Box {
  const w = Math.min(Math.max(b.w + dw, MIN.w), 1 - b.x);
  const h = Math.min(Math.max(b.h + dh, MIN.h), 1 - b.y);
  return clampBox({ ...b, w, h });
}

/** A copy of a field just below it (or above, when there's no room below). */
export function duplicateBox(b: Box): Box {
  const below = b.y + b.h + 0.01;
  return clampBox({ ...b, y: below + b.h <= 1 ? below : b.y - b.h - 0.01 });
}
