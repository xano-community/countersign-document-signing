// The characters the signed PDF can draw: everything the bundled Noto Sans font has a glyph for (Latin, Greek and
// Cyrillic). Worked out from the font at build time, so it can't drift from the font the seal embeds. Every text that
// ends up on the PDF is checked against it when it's typed, so a seal never fails, or draws empty boxes, after everyone
// has signed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { c, expr, fl, guard, withFilters, type Value } from "@xano/sdk";

const require = createRequire(import.meta.url);
const fontkit = require("@pdf-lib/fontkit") as { create: (b: Buffer) => { characterSet: number[] } };
const font = fontkit.create(readFileSync(new URL("../../seed-files/NotoSans-Regular.ttf", import.meta.url)));

/** The font's code points as merged ranges, plus the whitespace a field may hold. */
const ranges: [number, number][] = [];
for (const cp of [...font.characterSet, 9, 10, 13].sort((a, b) => a - b)) {
  const last = ranges[ranges.length - 1];
  if (last && cp <= last[1] + 1) last[1] = Math.max(last[1], cp);
  else ranges.push([cp, cp]);
}
// Literal characters, escaped where a class needs it: both JavaScript and the server's regex engine read them the same.
const ch = (n: number) => (n === 9 ? "\\t" : n === 10 ? "\\n" : n === 13 ? "\\r" : /[\\\]\[^-]/.test(String.fromCodePoint(n)) ? `\\${String.fromCodePoint(n)}` : String.fromCodePoint(n));
/** Matches text made only of drawable characters. */
export const DRAWABLE = new RegExp(`^[${ranges.map(([a, b]) => (a === b ? ch(a) : `${ch(a)}-${ch(b)}`)).join("")}]*$`, "u");

export const CHARSET_MESSAGE = "Some of these characters can't be printed on the signed PDF. Use Latin, Greek or Cyrillic letters.";

/** A guard: refuse `v` unless every character can be drawn. */
export const requireDrawable = (v: Value, message = CHARSET_MESSAGE) =>
  guard.require(expr(withFilters(c.regex(DRAWABLE), fl.regex_test(withFilters(v, fl.first_notnull(c.text(""))))), "=", c.bool(true)), { errorType: "badrequest", message });
