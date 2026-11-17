// Several PDFs become one document in the order the sender chose, in the browser, before upload. The server fingerprints the combined
// file itself; the per-file fingerprints here are what the browser reports, and the server records them as such.
import { PDFDocument } from "pdf-lib";
import { fileBytes, openPdf, pagesOf, type PageInfo } from "./inspect";

/** What the browser says about each file it combined. */
export type SourceFile = { name: string; sha256: string; pages: number };

export type Combined = { bytes: Uint8Array; sha256: string; pages: PageInfo[]; sources: SourceFile[] };

/** SHA-256 as lowercase hex, with Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Combines `files` in the given order. Throws a PdfRefusal naming the first file that can't be used. A single file is sent as it
 * is, byte for byte, so its fingerprint is the one its owner would compute.
 */
export async function combinePdfs(files: readonly File[]): Promise<Combined> {
  if (files.length === 0) throw new Error("Add at least one PDF.");
  const opened: { name: string; bytes: Uint8Array; doc: PDFDocument; pages: PageInfo[] }[] = [];
  for (const file of files) {
    const bytes = await fileBytes(file);
    const doc = await openPdf(file.name, bytes);
    opened.push({ name: file.name, bytes, doc, pages: pagesOf(file.name, doc) });
  }
  const sources = await Promise.all(opened.map(async (o) => ({ name: o.name, sha256: await sha256Hex(o.bytes), pages: o.pages.length })));

  if (opened.length === 1) return { bytes: opened[0].bytes, sha256: sources[0].sha256, pages: opened[0].pages, sources };

  const out = await PDFDocument.create();
  for (const o of opened) {
    const copied = await out.copyPages(o.doc, o.doc.getPageIndices());
    copied.forEach((page) => out.addPage(page));
  }
  const bytes = await out.save();
  return { bytes, sha256: await sha256Hex(bytes), pages: pagesOf("Combined document", out), sources };
}
