// Opens a stored PDF with the same pdf-lib the seal uses, so a file the seal could not read is refused when it's uploaded, not after
// everyone has signed. pdf-lib arrives as source text from the `vendor` table. The bytes come from `$var.blob.b64` (a table-kept
// file) or from a short signed link (`$var.url`) for one in private storage: big bytes never cross into the lambda as a value.
// Only this function's body is sent to the engine, which is why everything it needs lives inside it.
type PdfPage = {
  getSize(): { width: number; height: number };
  getRotation(): { angle: number };
  getCropBox(): { x: number; y: number; width: number; height: number };
};
type PdfLib = { PDFDocument: { load(bytes: Uint8Array, options?: { updateMetadata?: boolean }): Promise<{ getPages(): PdfPage[] }> } };

export default async function ({ $var }: { $var: { lib_row?: { src?: string } | null; blob?: { b64?: string } | null; url?: string | null } }) {
  const message = (e: unknown) => String((e as { message?: string } | null)?.message ?? e);
  try {
    const holder: { PDFLib?: PdfLib } = {};
    new Function(String($var.lib_row?.src ?? "")).call(holder);
    if (!holder.PDFLib) return { ok: false, code: "unavailable", error: "The PDF library did not load." };

    let bytes: Uint8Array;
    if ($var.url) {
      const got = await fetch($var.url);
      if (!got.ok) return { ok: false, code: "unavailable", error: `Reading the stored file answered ${got.status}.` };
      bytes = new Uint8Array(await got.arrayBuffer());
    } else {
      bytes = new Uint8Array(Buffer.from(String($var.blob?.b64 ?? ""), "base64"));
    }

    // Everything from here is about the file itself: a failure means the PDF, not the service.
    try {
      // No ignoreEncryption: a PDF with any password, an owner password included, is refused, because the seal can't write to it.
      const doc = await holder.PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
      const pages = doc.getPages().map((p) => {
        const size = p.getSize();
        const crop = p.getCropBox();
        return {
          w: size.width,
          h: size.height,
          rotation: (((p.getRotation().angle % 360) + 360) % 360),
          crop: { x: crop.x, y: crop.y, w: crop.width, h: crop.height },
        };
      });
      if (pages.length === 0) return { ok: false, code: "damaged", error: "The PDF has no pages." };
      return { ok: true, code: "", page_count: pages.length, pages, error: "" };
    } catch (e) {
      const why = message(e);
      return { ok: false, code: /encrypted/i.test(why) ? "encrypted" : "damaged", error: why.slice(0, 300) };
    }
  } catch (e) {
    return { ok: false, code: "unavailable", error: message(e).slice(0, 300) };
  }
}
