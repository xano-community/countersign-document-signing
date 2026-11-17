import { describe, expect, it } from "vitest";
import { clampBox, defaultSize, duplicateBox, fractionOf, MIN, nudge, placeAt, resize } from "./geometry";

const LETTER = 11 / 8.5;

describe("field geometry", () => {
  it("centres a new field on the tap point", () => {
    const b = placeAt("signature", { x: 0.5, y: 0.5 }, LETTER);
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 3);
    expect(b.y + b.h / 2).toBeCloseTo(0.5, 3);
  });

  it("moves a field dropped at the edge back onto the page instead of shrinking it", () => {
    const b = placeAt("signature", { x: 0.99, y: 0.995 }, LETTER);
    expect(b.x + b.w).toBeLessThanOrEqual(1);
    expect(b.y + b.h).toBeLessThanOrEqual(1);
    expect(b.w).toBeCloseTo(defaultSize("signature", LETTER).w, 4);
  });

  it("keeps a checkbox square on a landscape page", () => {
    const landscape = 8.5 / 11;
    const { w, h } = defaultSize("checkbox", landscape);
    expect(w * 1).toBeCloseTo(h * landscape, 3);
  });

  it("scales heights with the page's shape, so a field looks the same turned sideways", () => {
    const portrait = defaultSize("text", LETTER);
    const landscape = defaultSize("text", 8.5 / 11);
    expect(landscape.h).toBeGreaterThan(portrait.h);
  });

  it("never lets a box get smaller than a tappable minimum", () => {
    const b = clampBox({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 });
    expect(b.w).toBe(MIN.w);
    expect(b.h).toBe(MIN.h);
  });

  it("nudges 1% by default and 10% with Shift, and stops at the edge", () => {
    const start = { x: 0.5, y: 0.5, w: 0.1, h: 0.05 };
    expect(nudge(start, "ArrowRight", false)?.x).toBeCloseTo(0.51, 4);
    expect(nudge(start, "ArrowDown", true)?.y).toBeCloseTo(0.6, 4);
    expect(nudge({ ...start, x: 0.89 }, "ArrowRight", true)?.x).toBeCloseTo(0.9, 4);
    expect(nudge(start, "Enter", false)).toBeNull();
  });

  it("resizes from the corner without running off the page", () => {
    const b = resize({ x: 0.8, y: 0.9, w: 0.1, h: 0.05 }, 0.5, 0.5);
    expect(b.x + b.w).toBeLessThanOrEqual(1.0001);
    expect(b.y + b.h).toBeLessThanOrEqual(1.0001);
  });

  it("reads a pointer position as fractions of the page element", () => {
    expect(fractionOf({ left: 100, top: 50, width: 400, height: 500 }, 300, 300)).toEqual({ x: 0.5, y: 0.5 });
    expect(fractionOf({ left: 0, top: 0, width: 100, height: 100 }, -20, 150)).toEqual({ x: 0, y: 1 });
  });

  it("puts a duplicate below the original, or above when there's no room", () => {
    expect(duplicateBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }).y).toBeGreaterThan(0.15);
    expect(duplicateBox({ x: 0.1, y: 0.94, w: 0.2, h: 0.05 }).y).toBeLessThan(0.94);
  });
});
