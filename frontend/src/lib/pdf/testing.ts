// Small PDFs for the pdf tests, made with pdf-lib in the test itself.
import { degrees, PDFDocument } from "pdf-lib";

/** A PDF with one page per size; `rotate` turns the page at that index 90 degrees. */
export async function makePdf(sizes: [number, number][], opts: { rotate?: number; title?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(opts.title);
  sizes.forEach(([w, h], i) => {
    const page = doc.addPage([w, h]);
    if (opts.rotate === i) page.setRotation(degrees(90));
  });
  return doc.save();
}

export const fileOf = (name: string, bytes: Uint8Array) => new File([bytes as BlobPart], name, { type: "application/pdf" });

/** A 1-page PDF with an owner password only (made with pypdf): viewers open it, pdf-lib refuses it as encrypted. */
export const OWNER_PASSWORD_PDF = Uint8Array.from(atob("JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgMyAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMCAwIDQwMCAzMDAgXQo+PgplbmRvYmoKNCAwIG9iago8PAovUHJvZHVjZXIgPGE1MjM2MzYxPgovTW9kRGF0ZSA8MWZlNjUyMmMyMzNhM2NmNzM4YWU0MGNjZjA2MmY5YmQ0ZD4KL0NyZWF0b3IgPGE1MjM2MzYxPgovQ3JlYXRpb25EYXRlIDwxZmU2NTIyYzIzM2EzY2Y3MzhhZTQwY2NmMDYyZjliZDRkPgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8OTEzYjA3M2Y1YjY1OTU0YzhiNmRhMjIxNjk5NzFhMTc3YjdlNmQ5NGExMDZmZjc1YzBjMTYyOTZiYzE1NDEyZT4KL1UgPDgwMzJmYWY5MGJjNzA0M2FiNDhkNDI4YTlkZThjOGMyMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAowMDAwMDAwMTIzIDAwMDAwIG4gCjAwMDAwMDAyMTMgMDAwMDAgbiAKMDAwMDAwMDM3MiAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMSAwIFIKL0luZm8gNCAwIFIKL0lEIFsgPDYxMzczMzM1MzUzNjMwNjQ2NjYyMzIzMDM0Mzk2NjYyMzgzOTMxMzA2NTM3MzI2MjMwMzY2MTY2MzUzMDY1NjY+IDw2MTM3MzMzNTM1MzYzMDY0NjY2MjMyMzAzNDM5NjY2MjM4MzkzMTMwNjUzNzMyNjIzMDM2NjE2NjM1MzA2NTY2PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo1ODcKJSVFT0YK"), (c) => c.charCodeAt(0));
