import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { combinePdfs, sha256Hex } from "./combine";
import { PdfRefusal } from "./inspect";
import { fileOf, makePdf, OWNER_PASSWORD_PDF } from "./testing";

const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("combinePdfs", () => {
  it("combines a 3-page and a 1-page PDF into 4 pages in the chosen order", async () => {
    const three = await makePdf([[612, 792], [612, 792], [595, 842]], { rotate: 1 });
    const one = await makePdf([[400, 300]]);
    const got = await combinePdfs([fileOf("One.pdf", one), fileOf("Three.pdf", three)]);

    expect(got.pages.map((p) => [p.w, p.h, p.rotation])).toEqual([[400, 300, 0], [612, 792, 0], [612, 792, 90], [595, 842, 0]]);
    expect(got.sources).toEqual([
      { name: "One.pdf", sha256: nodeSha(one), pages: 1 },
      { name: "Three.pdf", sha256: nodeSha(three), pages: 3 },
    ]);
    expect(got.sha256).toBe(nodeSha(got.bytes));
    const reopened = await PDFDocument.load(got.bytes);
    expect(reopened.getPageCount()).toBe(4);
    expect(reopened.getPage(0).getSize()).toEqual({ width: 400, height: 300 });
  });

  it("sends a single file byte for byte", async () => {
    const only = await makePdf([[612, 792]], { title: "Keep me" });
    const got = await combinePdfs([fileOf("Only.pdf", only)]);
    expect(got.bytes).toEqual(only);
    expect(got.sha256).toBe(nodeSha(only));
    expect(got.sources).toEqual([{ name: "Only.pdf", sha256: nodeSha(only), pages: 1 }]);
  });

  it("refuses the whole set, naming the password-protected file", async () => {
    const good = await makePdf([[612, 792]]);
    const attempt = combinePdfs([fileOf("Good.pdf", good), fileOf("Locked.pdf", OWNER_PASSWORD_PDF)]);
    await expect(attempt).rejects.toBeInstanceOf(PdfRefusal);
    await expect(attempt).rejects.toMatchObject({ fileName: "Locked.pdf", code: "encrypted" });
  });

  it("hashes with Web Crypto the same as Node", async () => {
    const bytes = new TextEncoder().encode("countersign");
    expect(await sha256Hex(bytes)).toBe(nodeSha(bytes));
  });
});
