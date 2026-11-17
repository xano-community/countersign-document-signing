import { describe, expect, it } from "vitest";
import { inspectAll, inspectPdf } from "./inspect";
import { fileOf, makePdf, OWNER_PASSWORD_PDF } from "./testing";

describe("inspectPdf", () => {
  it("reads each page's size, rotation and crop box", async () => {
    const got = await inspectPdf(fileOf("Lease.pdf", await makePdf([[612, 792], [842, 595]], { rotate: 1 })));
    expect(got).toMatchObject({ ok: true, name: "Lease.pdf" });
    if (!got.ok) return;
    expect(got.pages).toEqual([
      { w: 612, h: 792, rotation: 0, crop: { x: 0, y: 0, w: 612, h: 792 } },
      { w: 842, h: 595, rotation: 90, crop: { x: 0, y: 0, w: 842, h: 595 } },
    ]);
  });

  it("refuses a password-protected PDF by name", async () => {
    const got = await inspectPdf(fileOf("Locked.pdf", OWNER_PASSWORD_PDF));
    expect(got).toEqual({ ok: false, name: "Locked.pdf", code: "encrypted", message: "“Locked.pdf” is password-protected. Remove the password and add it again." });
  });

  it("refuses a PNG named .pdf by its bytes", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const got = await inspectPdf(fileOf("Photo.pdf", png));
    expect(got).toMatchObject({ ok: false, code: "not_pdf" });
    expect(got.ok ? "" : got.message).toContain("“Photo.pdf”");
  });

  it("refuses a damaged PDF and an empty file", async () => {
    const broken = new TextEncoder().encode("%PDF-1.7\nthis is not really a PDF\n%%EOF");
    expect(await inspectPdf(fileOf("Broken.pdf", broken))).toMatchObject({ ok: false, code: "damaged", name: "Broken.pdf" });
    expect(await inspectPdf(fileOf("Empty.pdf", new Uint8Array()))).toMatchObject({ ok: false, code: "empty" });
  });

  it("answers for every file, in order", async () => {
    const got = await inspectAll([fileOf("A.pdf", await makePdf([[100, 100]])), fileOf("B.pdf", OWNER_PASSWORD_PDF)]);
    expect(got.map((g) => [g.name, g.ok])).toEqual([["A.pdf", true], ["B.pdf", false]]);
  });
});
