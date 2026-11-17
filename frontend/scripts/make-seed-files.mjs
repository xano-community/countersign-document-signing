// Makes the demo's documents and signatures, once, into xano/seed-files: four PDFs (a lease, an offer letter, a mutual NDA and a
// services agreement), where each signing field sits on them (layout.json), and handwritten signature images (signatures.json,
// drawn in Chrome with the app's own handwriting fonts). The seed reads these files; run this again only to change them.
//
//   node frontend/scripts/make-seed-files.mjs            PDFs and layout
//   node frontend/scripts/make-seed-files.mjs --marks    also the signature images (needs Google Chrome)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "xano", "seed-files");
const W = 612, H = 792, M = 72;
const INK = rgb(0.13, 0.15, 0.2), MUTED = rgb(0.42, 0.45, 0.5), RULE = rgb(0.75, 0.75, 0.75);
const FIXED_DATE = new Date("2026-10-01T09:00:00Z");
mkdirSync(OUT, { recursive: true });

/** A page writer: wrapped paragraphs top to bottom, and boxes recorded as fractions of the page, top-left origin. */
async function makeDoc(title, subtitle) {
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setAuthor("Fernhill Property Group"); doc.setCreator("Countersign"); doc.setProducer("Countersign");
  doc.setCreationDate(FIXED_DATE); doc.setModificationDate(FIXED_DATE);
  const serif = await doc.embedFont(StandardFonts.TimesRoman), bold = await doc.embedFont(StandardFonts.TimesRomanBold), sans = await doc.embedFont(StandardFonts.Helvetica);
  const boxes = {};
  let page, y, pageNo = 0;
  const newPage = () => {
    page = doc.addPage([W, H]); pageNo++; y = H - M;
    page.drawText("FERNHILL PROPERTY GROUP", { x: M, y: H - 40, size: 8, font: sans, color: MUTED });
    page.drawText(`${title} · page ${pageNo}`, { x: W - M - sans.widthOfTextAtSize(`${title} · page ${pageNo}`, 8), y: H - 40, size: 8, font: sans, color: MUTED });
    page.drawLine({ start: { x: M, y: H - 48 }, end: { x: W - M, y: H - 48 }, thickness: 0.5, color: RULE });
  };
  const wrap = (text, font, size, width) => {
    const words = text.split(/\s+/); const lines = []; let line = "";
    for (const w of words) { const next = line ? `${line} ${w}` : w; if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w; } else line = next; }
    if (line) lines.push(line); return lines;
  };
  const para = (text, { size = 10.5, font = serif, gap = 8, indent = 0 } = {}) => {
    for (const l of wrap(text, font, size, W - 2 * M - indent)) { if (y < M + 40) newPage(); page.drawText(l, { x: M + indent, y, size, font, color: INK }); y -= size * 1.42; }
    y -= gap;
  };
  const heading = (text) => { if (y < M + 80) newPage(); y -= 4; page.drawText(text, { x: M, y, size: 11.5, font: bold, color: INK }); y -= 18; };
  const clause = (n, head, text) => { if (y < M + 60) newPage(); const label = `${n}. ${head}.`; page.drawText(label, { x: M, y, size: 10.5, font: bold, color: INK }); const lw = bold.widthOfTextAtSize(label, 10.5) + 4;
    const first = wrap(text, serif, 10.5, W - 2 * M - lw)[0] ?? ""; page.drawText(first, { x: M + lw, y, size: 10.5, font: serif, color: INK }); y -= 15; const rest = text.slice(first.length).trim(); if (rest) para(rest, { gap: 6 }); else y -= 6; };
  /** Records a box in fractions: x, y (top), width, height, all in points from the page's top-left. */
  const box = (key, x, top, w, h) => { boxes[key] = { page: pageNo, x: +(x / W).toFixed(4), y: +(top / H).toFixed(4), w: +(w / W).toFixed(4), h: +(h / H).toFixed(4) }; };
  /** A signature block: a line, the party under it, and a date line. Its signature and date boxes sit on the lines. */
  const signBlock = (key, x, party, role) => {
    const lineY = y; const width = 210;
    page.drawLine({ start: { x, y: lineY }, end: { x: x + width, y: lineY }, thickness: 0.7, color: INK });
    page.drawText(party, { x, y: lineY - 13, size: 9.5, font: bold, color: INK });
    page.drawText(role, { x, y: lineY - 25, size: 9, font: serif, color: MUTED });
    page.drawText("Date", { x, y: lineY - 52, size: 9, font: serif, color: MUTED });
    page.drawLine({ start: { x: x + 28, y: lineY - 52 }, end: { x: x + 140, y: lineY - 52 }, thickness: 0.5, color: RULE });
    box(`sig.${key}`, x, H - lineY - 34, width, 32);
    box(`date.${key}`, x + 30, H - (lineY - 52) - 14, 110, 13);
  };
  newPage();
  page.drawText(title, { x: M, y, size: 20, font: bold, color: INK }); y -= 22;
  if (subtitle) { page.drawText(subtitle, { x: M, y, size: 10, font: serif, color: MUTED }); y -= 30; } else y -= 14;
  return { doc, boxes, para, heading, clause, signBlock, box, newPage, get y() { return y; }, set y(v) { y = v; }, get page() { return page; }, get pageNo() { return pageNo; }, fonts: { serif, bold, sans } };
}

/** Space for signatures at the bottom of the current page, or a new page when there isn't room. */
const signaturesArea = (d) => { if (d.y < M + 170) d.newPage(); d.y -= 30; };

async function lease() {
  const d = await makeDoc("Residential Lease Agreement", "14 Alder Street, Unit 3, Fernhill · Term: 12 months from 1 December 2026");
  d.para("This Residential Lease Agreement is made between Fernhill Property Group, as agent for the owner (the “Landlord”), and the person named below as Tenant. The Landlord leases to the Tenant, and the Tenant leases from the Landlord, the premises described in this agreement on the terms that follow.");
  d.clause(1, "Premises", "Unit 3, 14 Alder Street, Fernhill, including one allocated parking space (bay 3) and the appliances listed in the inventory signed at move-in.");
  d.clause(2, "Term", "Twelve months, starting 1 December 2026 and ending 30 November 2027. After that, the tenancy continues month to month unless either party gives notice under clause 12.");
  d.clause(3, "Rent", "$2,450.00 per month, due on the first day of each month, paid by bank transfer to the account the Landlord names in writing. Rent paid more than five days late carries a fee of $50.");
  d.clause(4, "Security deposit", "$2,450.00, held in a separate trust account and returned within 21 days of the end of the tenancy, less any amounts lawfully deducted and itemised in writing.");
  d.clause(5, "Utilities", "The Tenant pays electricity, internet and gas. Water and refuse collection are included in the rent.");
  d.clause(6, "Use", "The premises are a private residence for the Tenant and the occupants named at move-in. No business open to the public may be run from them.");
  d.clause(7, "Pets", "Pets are permitted only with the Landlord's written consent, which will not be unreasonably withheld. A pet addendum may set an additional deposit.");
  d.clause(8, "Maintenance", "The Tenant keeps the premises clean and reports damage or needed repairs promptly through the Fernhill tenant portal. The Landlord makes repairs within a reasonable time.");
  const initTop = H - d.y + 6;
  d.page.drawText("Tenant's initials:", { x: W - M - 160, y: d.y - 10, size: 9, font: d.fonts.serif, color: MUTED });
  d.page.drawLine({ start: { x: W - M - 80, y: d.y - 12 }, end: { x: W - M - 10, y: d.y - 12 }, thickness: 0.5, color: RULE });
  d.box("init.a", W - M - 80, initTop, 70, 26);
  d.newPage();
  d.clause(9, "Alterations", "The Tenant makes no structural changes, and paints or fixes items to walls only with the Landlord's written consent.");
  d.clause(10, "Entry", "The Landlord may enter with 24 hours' written notice for inspections and repairs, or at any time in an emergency.");
  d.clause(11, "Insurance", "The Tenant is encouraged to hold contents insurance. The Landlord's insurance does not cover the Tenant's belongings.");
  d.clause(12, "Ending the tenancy", "Either party may end a month-to-month tenancy with 60 days' written notice. During the fixed term, the Tenant may end the lease early by paying the costs of re-letting.");
  d.clause(13, "Notices", "Notices are given in writing to the addresses above, or by email to the addresses on file, and take effect on delivery.");
  d.clause(14, "Entire agreement", "This agreement, the inventory and any signed addenda are the whole agreement between the parties. Changes must be in writing and signed by both.");
  signaturesArea(d);
  const top = d.y;
  d.signBlock("a", M, "Tenant", "Signs first");
  d.y = top;
  d.signBlock("b", M + 252, "Fernhill Property Group", "Landlord's agent");
  return d;
}

async function offer() {
  const d = await makeDoc("Offer of Employment", "Leasing Coordinator · Fernhill Property Group");
  d.para("Dear Alex,");
  d.para("We're delighted to offer you the position of Leasing Coordinator at Fernhill Property Group, reporting to Jordan Lee, Leasing Manager. This letter sets out the main terms of the offer.");
  d.clause(1, "Start date", "Monday 4 January 2027, or another date we agree in writing.");
  d.clause(2, "Salary", "$62,000 per year, paid fortnightly, reviewed each January.");
  d.clause(3, "Hours", "Full time, 38 hours a week, Monday to Friday, with one Saturday a month for open homes, given back as a weekday off.");
  d.clause(4, "Benefits", "Four weeks' paid leave a year, health cover from your first month, and a $1,200 yearly learning budget.");
  d.clause(5, "Probation", "The first three months are a probation period, with a check-in at six and twelve weeks.");
  d.clause(6, "Conditions", "This offer depends on a satisfactory reference check and your right to work.");
  d.para("To accept, please sign below. We look forward to welcoming you to the team.");
  d.para("Sam Okafor, People Lead, Fernhill Property Group", { font: d.fonts.bold, size: 10 });
  signaturesArea(d);
  d.signBlock("a", M, "Accepted by", "Candidate");
  return d;
}

async function nda() {
  const d = await makeDoc("Mutual Non-Disclosure Agreement", "Between Fernhill Property Group and the company named below");
  d.para("The parties wish to discuss a possible arrangement for occupancy analytics across Fernhill's managed buildings (the “Purpose”), and to protect the confidential information each shares for it.");
  d.clause(1, "Confidential information", "Any non-public information one party discloses to the other for the Purpose, in any form, that is marked confidential or would reasonably be understood to be confidential.");
  d.clause(2, "Obligations", "Each party uses the other's confidential information only for the Purpose, shares it only with people who need it for the Purpose and are bound by similar duties, and protects it with at least reasonable care.");
  d.clause(3, "Exclusions", "These duties don't apply to information that is or becomes public through no fault of the receiver, was already known to it, is independently developed, or is rightfully received from a third party.");
  d.clause(4, "Required disclosure", "A party may disclose information when the law requires, after giving the other prompt notice where allowed.");
  d.clause(5, "Term", "This agreement lasts two years from the date of the last signature. Duties for information disclosed during that time last three years after it ends.");
  d.clause(6, "Return of information", "On request, each party returns or destroys the other's confidential information, except copies kept by automatic backup.");
  d.clause(7, "No licence", "Nothing in this agreement grants any licence or obliges either party to enter into any further agreement.");
  d.clause(8, "Governing law", "This agreement is governed by the laws of the state in which Fernhill Property Group is registered.");
  d.newPage();
  d.para("Signed by the parties' authorised representatives.");
  signaturesArea(d);
  const top = d.y;
  d.signBlock("a", M, "Harbor Analytics", "Authorised signatory");
  d.y = top;
  d.signBlock("b", M + 252, "Fernhill Property Group", "Authorised signatory");
  return d;
}

async function services() {
  const d = await makeDoc("Services Agreement", "Commercial cleaning for Fernhill's managed buildings");
  d.para("This Services Agreement is between Fernhill Property Group (the “Client”) and the contractor named below (the “Contractor”).");
  d.clause(1, "Services", "Cleaning of common areas, lobbies and stairwells at the buildings listed in Schedule A, three times a week, and a deep clean of each building every quarter.");
  d.clause(2, "Fees", "$4,800 per month, invoiced monthly in arrears and paid within 30 days of a correct invoice.");
  d.clause(3, "Standards", "The Contractor follows the cleaning checklist in Schedule B, and the Client may inspect the work at any time.");
  d.clause(4, "Staff", "The Contractor's staff are its employees or subcontractors, not the Client's, and the Contractor is responsible for their pay, supervision and safety training.");
  d.clause(5, "Insurance", "The Contractor holds public liability insurance of at least $5,000,000 and gives the Client a certificate of currency on request.");
  d.clause(6, "Term", "Twelve months from 1 November 2026, renewing for further twelve-month terms unless either party gives 60 days' notice.");
  const initTop = H - d.y + 6;
  d.page.drawText("Contractor's initials:", { x: W - M - 170, y: d.y - 10, size: 9, font: d.fonts.serif, color: MUTED });
  d.page.drawLine({ start: { x: W - M - 80, y: d.y - 12 }, end: { x: W - M - 10, y: d.y - 12 }, thickness: 0.5, color: RULE });
  d.box("init.a", W - M - 80, initTop, 70, 26);
  d.newPage();
  d.clause(7, "Termination", "Either party may end this agreement for a material breach not fixed within 14 days of written notice.");
  d.clause(8, "Liability", "Neither party is liable for indirect loss. Each party's total liability is limited to the fees paid in the 12 months before the claim.");
  d.clause(9, "Entire agreement", "This agreement and its schedules are the whole agreement between the parties.");
  signaturesArea(d);
  const top = d.y;
  d.signBlock("a", M, "Contractor", "Authorised signatory");
  d.y = top;
  d.signBlock("b", M + 252, "Fernhill Property Group", "Operations");
  return d;
}

const layout = {};
for (const [name, make] of [["lease", lease], ["offer", offer], ["nda", nda], ["services", services]]) {
  const d = await make();
  const bytes = await d.doc.save({ useObjectStreams: false });
  writeFileSync(join(OUT, `${name}.pdf`), bytes);
  layout[name] = { pages: d.doc.getPages().map((p) => ({ w: p.getWidth(), h: p.getHeight(), rotation: 0 })), boxes: d.boxes };
  console.log(`${name}.pdf  ${d.doc.getPageCount()} pages  ${bytes.length} bytes`);
}
writeFileSync(join(OUT, "layout.json"), JSON.stringify(layout, null, 1) + "\n");

if (process.argv.includes("--marks")) {
  const { default: puppeteer } = await import(join(ROOT, "node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"));
  const font = (rel) => `data:font/woff2;base64,${readFileSync(join(ROOT, "node_modules", rel)).toString("base64")}`;
  const fonts = {
    flowing: font("@fontsource/mrs-saint-delafield/files/mrs-saint-delafield-latin-400-normal.woff2"),
    handwritten: font("@fontsource/homemade-apple/files/homemade-apple-latin-400-normal.woff2"),
  };
  const people = [
    ["Maya Chen", "flowing"], ["Jordan Lee", "handwritten"], ["Dana Okoye", "flowing"], ["Priya Shah", "handwritten"],
    ["Luis Ortega", "flowing"], ["Kim Park", "handwritten"], ["Alex Rivera", "flowing"], ["Ben Walsh", "handwritten"], ["Ana Ruiz", "flowing"],
  ];
  const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new" });
  const page = await browser.newPage();
  const marks = {};
  for (const [name, style] of people) {
    for (const [kind, text, size] of [["signature", name, style === "flowing" ? 64 : 34], ["initials", name.split(" ").map((w) => w[0]).join(""), style === "flowing" ? 56 : 30]]) {
      marks[`${name}:${kind}`] = await page.evaluate(async (fontUrl, text, size) => {
        const face = new FontFace("Hand", `url(${fontUrl})`); await face.load(); document.fonts.add(face);
        const c = document.createElement("canvas"); const g = c.getContext("2d"); g.font = `${size}px Hand`;
        const w = Math.ceil(g.measureText(text).width + size * 0.6), h = Math.ceil(size * 1.6);
        c.width = w * 2; c.height = h * 2; const d = c.getContext("2d"); d.scale(2, 2); d.font = `${size}px Hand`; d.fillStyle = "#1d2a5c"; d.textBaseline = "middle"; d.fillText(text, size * 0.3, h / 2);
        return c.toDataURL("image/png").split(",")[1];
      }, fonts[style], text, size);
    }
  }
  await browser.close();
  writeFileSync(join(OUT, "signatures.json"), JSON.stringify(marks) + "\n");
  console.log(`signatures.json  ${Object.keys(marks).length} marks`);
}
