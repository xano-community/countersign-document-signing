// What the browser checks before anything is sent: each file must be a PDF that opens without a password, and its pages are read.
// The server checks again with the same library the seal uses, so this is for a fast, named answer, not for trust.
import { PDFDocument } from "pdf-lib";

/** A page as stored on the envelope: size in points, rotation in degrees (0, 90, 180, 270) and the crop box. */
export type PageInfo = { w: number; h: number; rotation: number; crop: { x: number; y: number; w: number; h: number } };

export type RefusalCode = "empty" | "not_pdf" | "encrypted" | "damaged";

/** A file the browser won't send, with a message that names it. */
export class PdfRefusal extends Error {
  constructor(readonly fileName: string, readonly code: RefusalCode, message: string) {
    super(message);
    this.name = "PdfRefusal";
  }
}

export type Inspected =
  | { ok: true; name: string; size: number; pages: PageInfo[] }
  | { ok: false; name: string; code: RefusalCode; message: string };

const MESSAGES: Record<RefusalCode, (name: string) => string> = {
  empty: (name) => `“${name}” is empty.`,
  not_pdf: (name) => `“${name}” isn't a PDF. Only PDF files can be sent for signature.`,
  encrypted: (name) => `“${name}” is password-protected. Remove the password and add it again.`,
  damaged: (name) => `“${name}” is damaged and can't be read. Save or export it again, then add the new copy.`,
};

const refuse = (name: string, code: RefusalCode) => new PdfRefusal(name, code, MESSAGES[code](name));

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * Opens one file's bytes the way the server will, or throws a PdfRefusal naming it. pdf-lib refuses any encrypted PDF, an
 * owner-password one included, because the seal can't write to it.
 */
export async function openPdf(name: string, bytes: Uint8Array): Promise<PDFDocument> {
  if (bytes.length === 0) throw refuse(name, "empty");
  if (!PDF_MAGIC.every((b, i) => bytes[i] === b)) throw refuse(name, "not_pdf");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    if (doc.getPageCount() === 0) throw new Error("no pages");
  } catch (e) {
    throw refuse(name, /encrypted/i.test(String((e as Error)?.message ?? e)) ? "encrypted" : "damaged");
  }
  return doc;
}

/** Each page's size, rotation and crop box. A damaged page tree reads as a damaged file. */
export function pagesOf(name: string, doc: PDFDocument): PageInfo[] {
  try {
    return doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      const crop = p.getCropBox();
      return { w: width, h: height, rotation: ((p.getRotation().angle % 360) + 360) % 360, crop: { x: crop.x, y: crop.y, w: crop.width, h: crop.height } };
    });
  } catch {
    throw refuse(name, "damaged");
  }
}

export const fileBytes = async (file: Blob) => new Uint8Array(await file.arrayBuffer());

/** One file: its pages, or why it can't be sent. Never throws for a bad file. */
export async function inspectPdf(file: File): Promise<Inspected> {
  try {
    const bytes = await fileBytes(file);
    const doc = await openPdf(file.name, bytes);
    return { ok: true, name: file.name, size: bytes.length, pages: pagesOf(file.name, doc) };
  } catch (e) {
    if (e instanceof PdfRefusal) return { ok: false, name: e.fileName, code: e.code, message: e.message };
    throw e;
  }
}

/** Every file, in order. */
export const inspectAll = (files: readonly File[]) => Promise.all(files.map(inspectPdf));
