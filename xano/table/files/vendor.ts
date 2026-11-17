import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { f, table } from "@xano/sdk";

// The PDF libraries the seal runs, as source text. A lambda body this large overflows Xano's processing of the body, so the
// seal loads them from this table with `new Function` instead. pdf-lib and fontkit are MIT; Noto Sans is OFL.
const require = createRequire(import.meta.url);
const read = (spec: string, enc: BufferEncoding = "utf8") => readFileSync(require.resolve(spec), enc);

export const vendor = table({
  name: "vendor",
  description: "Library source and font bytes the seal loads.",
  schema: {
    name: f.text({ required: true }),
    src: f.text({ required: true }),
  },
  index: [{ type: "btree|unique", fields: [{ name: "name", op: "asc" }] }],
  seed: [
    { name: "pdf-lib", src: read("pdf-lib/dist/pdf-lib.min.js") },
    { name: "fontkit", src: read("@pdf-lib/fontkit/dist/fontkit.umd.min.js") },
    { name: "noto-sans", src: readFileSync(new URL("../../seed-files/NotoSans-Regular.ttf", import.meta.url)).toString("base64") },
  ],
});
