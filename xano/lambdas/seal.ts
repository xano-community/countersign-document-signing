// Builds the signed PDF, or the audit trail on its own. pdf-lib, fontkit and Noto Sans arrive as text from the `vendor` table
// (`$var.libs`) and load with `new Function`, because a body that size overflows Xano's processing of it. Everything else the
// PDF says arrives in `$var.job`, built by seal/build or seal/audit_pdf.
//
// `job.mode`:
// - "seal": fetch the original from `job.get_url`, stamp every field where it was placed, put "Countersign · <id>" on each page,
//   append the certificate, then post the result to `job.put_url`. Both URLs take the one-time seal key in `X-Seal-Key`
//   (only the internal route reads it; a signed storage link ignores it). Answers { ok, sha256, size, pages, file_id }.
// - "audit": the certificate and audit trail as their own PDF, small enough to answer as base64: { ok, b64, pages }.
//
// Field positions are fractions (0-1) of the page as a person sees it: top-left origin, after the page's /Rotate and inside its
// CropBox. `frame` turns one into PDF points, and everything in a field is drawn rotated with the page so it reads upright.
// A body that throws answers its error text at HTTP 200, so the whole body is wrapped and always answers { ok }.
export default async function ({ $var }: { $var: { libs: { pdflib: string; fontkit: string; font: string }; job: any } }) {
  const why = (e: unknown) => String((e as { message?: string } | null)?.message ?? e).slice(0, 500);

  // ── Digital signing (optional): when the deployer sets a certificate, the sealed PDF carries a standard embedded signature
  // (adbe.pkcs7.detached, CMS with SHA-256), so any PDF reader can tell whether the file changed after sealing. Built here with
  // WebCrypto and a small DER encoder, because the lambda has no PKI library. Keys: PKCS#8 PEM, RSA or EC P-256/P-384.
  type Bytes = Uint8Array;
  const cat = (...parts: Bytes[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  const derLen = (n: number) => { if (n < 128) return Uint8Array.of(n); const b: number[] = []; while (n > 0) { b.unshift(n & 255); n = Math.floor(n / 256); } return Uint8Array.of(128 | b.length, ...b); };
  const tlv = (tag: number, ...content: Bytes[]) => { const c = cat(...content); return cat(Uint8Array.of(tag), derLen(c.length), c); };
  const seq = (...c: Bytes[]) => tlv(0x30, ...c);
  const set = (...c: Bytes[]) => tlv(0x31, ...c);
  const octet = (b: Bytes) => tlv(0x04, b);
  const NULL = Uint8Array.of(5, 0);
  const oid = (dotted: string) => {
    const [a, b, ...rest] = dotted.split(".").map(Number);
    const out = [40 * a + b];
    for (const n of rest) { const g: number[] = [n & 127]; let v = Math.floor(n / 128); while (v > 0) { g.unshift((v & 127) | 128); v = Math.floor(v / 128); } out.push(...g); }
    return tlv(0x06, Uint8Array.from(out));
  };
  const uint = (b: Bytes) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; const v = b.slice(i); return tlv(0x02, v[0] & 128 ? cat(Uint8Array.of(0), v) : v); };
  const small = (n: number) => tlv(0x02, Uint8Array.of(n));
  const utc = (d: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return tlv(0x17, new TextEncoder().encode(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); };
  const digestOf = (b: Bytes) => new Uint8Array(crypto.createHash("sha256").update(b).digest());
  /** One DER element at `at`: its tag, where its content starts and where it ends. */
  const read = (b: Bytes, at: number) => {
    const tag = b[at]; let len = b[at + 1]; let start = at + 2;
    if (len & 128) { const n = len & 127; len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i]; start = at + 2 + n; }
    return { tag, start, end: start + len };
  };
  const children = (b: Bytes, el: { start: number; end: number }) => { const out: { tag: number; at: number; start: number; end: number }[] = []; let at = el.start; while (at < el.end) { const c = read(b, at); out.push({ ...c, at }); at = c.end; } return out; };
  const pemBlocks = (text: string, label: string) => {
    const t = String(text ?? "").replace(/\\n/g, "\n");
    const plain = /-----BEGIN /.test(t) ? t : (() => { try { return Buffer.from(t.trim(), "base64").toString("utf8"); } catch { return ""; } })();
    const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`, "g");
    return [...plain.matchAll(re)].map((m) => new Uint8Array(Buffer.from(m[1].replace(/\s+/g, ""), "base64")));
  };
  /** A certificate's parts the signature needs, and what a person reads: who it names, who issued it, and when it's valid. */
  const certParts = (der: Bytes) => {
    const tbs = children(der, read(der, 0))[0];
    const parts = children(der, tbs);
    const i = parts[0].tag === 0xa0 ? 1 : 0;
    const serial = der.slice(parts[i].at, parts[i].end);
    const issuerEl = parts[i + 2], validityEl = parts[i + 3], subjectEl = parts[i + 4];
    const nameText = (el: { start: number; end: number }) => {
      const want: Record<string, string> = { "55 04 03": "CN", "55 04 0a": "O", "55 04 06": "C" };
      const bits: string[] = [];
      for (const rdn of children(der, el)) for (const atv of children(der, rdn)) {
        const [k, v] = children(der, atv);
        const key = Array.from(der.slice(k.start, k.end)).map((x) => x.toString(16).padStart(2, "0")).join(" ");
        if (want[key]) bits.push(`${want[key]}=${Buffer.from(der.slice(v.start, v.end)).toString("utf8")}`);
      }
      return bits.join(", ");
    };
    const time = (el: { tag: number; start: number; end: number }) => {
      const t = Buffer.from(der.slice(el.start, el.end)).toString("latin1");
      const full = el.tag === 0x17 ? (Number(t.slice(0, 2)) < 50 ? "20" : "19") + t : t;
      return Date.UTC(+full.slice(0, 4), +full.slice(4, 6) - 1, +full.slice(6, 8), +full.slice(8, 10), +full.slice(10, 12), +full.slice(12, 14));
    };
    const [from, to] = children(der, validityEl);
    const issuer = der.slice(issuerEl.at, issuerEl.end);
    const subject = der.slice(subjectEl.at, subjectEl.end);
    return {
      serial, issuer, subject: nameText(subjectEl), issuer_name: nameText(issuerEl), not_before: time(from), not_after: time(to),
      self_signed: Buffer.from(issuer).toString("hex") === Buffer.from(subject).toString("hex"),
    };
  };
  const importKey = async (pkcs8: Bytes) => {
    const tries: [string, any, any][] = [
      ["rsa", { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5" }],
      ["ec", { name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }],
      ["ec", { name: "ECDSA", namedCurve: "P-384" }, { name: "ECDSA", hash: "SHA-256" }],
    ];
    for (const [kind, alg, use] of tries) {
      try { return { kind, key: await crypto.subtle.importKey("pkcs8", pkcs8, alg, false, ["sign"]), use }; } catch { /* try the next */ }
    }
    throw new Error("The signing key isn't a PKCS#8 RSA or EC (P-256 or P-384) private key.");
  };
  /** A detached CMS SignedData over `digest`, by the certificate's key, with the certificate (and chain) inside. */
  const cms = async (digest: Bytes, signing: { key: string; cert: string; chain?: string }) => {
    const certs = [...pemBlocks(signing.cert, "CERTIFICATE"), ...pemBlocks(signing.chain ?? "", "CERTIFICATE")];
    const keyDer = pemBlocks(signing.key, "PRIVATE KEY")[0];
    if (!certs.length || !keyDer) throw new Error("The signing certificate or key is missing or not PEM.");
    const leaf = certs[0];
    const parts = certParts(leaf);
    const SHA256 = seq(oid("2.16.840.1.101.3.4.2.1"), NULL);
    const attrs = [
      seq(oid("1.2.840.113549.1.9.3"), set(oid("1.2.840.113549.1.7.1"))),
      seq(oid("1.2.840.113549.1.9.5"), set(utc(new Date()))),
      seq(oid("1.2.840.113549.1.9.4"), set(octet(digest))),
      seq(oid("1.2.840.113549.1.9.16.2.47"), set(seq(seq(seq(octet(digestOf(leaf))))))),
    ].sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; });
    const { kind, key, use } = await importKey(keyDer);
    let sig = new Uint8Array(await crypto.subtle.sign(use, key, set(...attrs)));
    if (kind === "ec") { const h = sig.length / 2; sig = seq(uint(sig.slice(0, h)), uint(sig.slice(h))); }
    const sigAlg = kind === "rsa" ? seq(oid("1.2.840.113549.1.1.11"), NULL) : seq(oid("1.2.840.10045.4.3.2"));
    const signerInfo = seq(small(1), seq(parts.issuer, parts.serial), SHA256, tlv(0xa0, ...attrs), sigAlg, octet(sig));
    const signedData = seq(small(1), set(SHA256), seq(oid("1.2.840.113549.1.7.1")), tlv(0xa0, ...certs), set(signerInfo));
    return seq(oid("1.2.840.113549.1.7.2"), tlv(0xa0, signedData));
  };

  try {
    const job = $var.job;
    // What Settings shows about the configured certificate, without touching a document.
    if (job.mode === "certinfo") {
      const der = pemBlocks(job.signing?.cert ?? "", "CERTIFICATE")[0];
      if (!der) return { ok: true, configured: false };
      const c = certParts(der);
      const keyDer = pemBlocks(job.signing?.key ?? "", "PRIVATE KEY")[0];
      let key_ok = false;
      if (keyDer) { try { await importKey(keyDer); key_ok = true; } catch { key_ok = false; } }
      const chain = pemBlocks(job.signing?.chain ?? "", "CERTIFICATE").length;
      return { ok: true, configured: true, key_ok, subject: c.subject, issuer: c.issuer_name, not_before: c.not_before, not_after: c.not_after, self_signed: c.self_signed, chain };
    }
    const holder: any = {};
    new Function(String($var.libs?.pdflib ?? "")).call(holder);
    new Function(String($var.libs?.fontkit ?? "")).call(holder);
    if (!holder.PDFLib || !holder.fontkit) return { ok: false, error: "The PDF libraries did not load." };
    const { PDFDocument, rgb, degrees } = holder.PDFLib;
    const seal = job.mode === "seal";
    const headers: Record<string, string> = job.key ? { "X-Seal-Key": String(job.key) } : {};

    let doc: any;
    let originalPages = 0;
    if (seal) {
      const got = await fetch(job.get_url, { headers: job.get_key ? headers : {} });
      if (!got.ok) return { ok: false, error: `Reading the original answered ${got.status}.` };
      doc = await PDFDocument.load(new Uint8Array(await got.arrayBuffer()), { updateMetadata: false });
      originalPages = doc.getPageCount();
    } else {
      doc = await PDFDocument.create();
    }
    doc.registerFontkit(holder.fontkit);
    const font = await doc.embedFont(Buffer.from(String($var.libs.font ?? ""), "base64"), { subset: true });
    const glyphs = new Set<number>(font.getCharacterSet());
    // Text the app doesn't control (a user agent, an old row) may hold characters the font can't draw: they print as "?".
    const clean = (v: unknown) => Array.from(String(v ?? "").replace(/[\t\r\n]+/g, " ")).map((ch) => (ch === " " || glyphs.has(ch.codePointAt(0) ?? 0) ? ch : "?")).join("");
    const width = (t: string, size: number) => font.widthOfTextAtSize(t, size);
    const ink = rgb(0.09, 0.09, 0.11);
    const muted = rgb(0.42, 0.42, 0.46);
    const rule = rgb(0.85, 0.85, 0.87);
    const footerFor = `Countersign · ${clean(job.envelope.public_id)}`;

    // A box on a page, given as fractions of the displayed page. `at(dx, dy)` is a point dx right and dy up from the box's
    // bottom-left corner as the viewer sees it, in PDF user space; `rot` is the angle that draws upright there.
    const frame = (page: any, b: { x: number; y: number; w: number; h: number }) => {
      const r = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
      const cb = page.getCropBox();
      const turned = r === 90 || r === 270;
      const dw = turned ? cb.height : cb.width;
      const dh = turned ? cb.width : cb.height;
      const u = b.x * dw;
      const v = (b.y + b.h) * dh;
      const ox = r === 0 ? cb.x + u : r === 90 ? cb.x + v : r === 180 ? cb.x + cb.width - u : cb.x + cb.width - v;
      const oy = r === 0 ? cb.y + cb.height - v : r === 90 ? cb.y + u : r === 180 ? cb.y + v : cb.y + cb.height - u;
      const cos = r === 0 ? 1 : r === 180 ? -1 : 0;
      const sin = r === 90 ? 1 : r === 270 ? -1 : 0;
      return { w: b.w * dw, h: b.h * dh, rot: degrees(r), at: (dx: number, dy: number) => ({ x: ox + dx * cos - dy * sin, y: oy + dx * sin + dy * cos }) };
    };
    const PAD = 2;
    // One line, as large as the box allows (at most 12 pt), shrunk to fit its width, then cut short with "…" below 5 pt.
    const fitText = (page: any, box: any, raw: string) => {
      let text = clean(raw);
      if (!text) return;
      const f = frame(page, box);
      let size = Math.max(4, Math.min(12, f.h * 0.7));
      while (size > 5 && width(text, size) > f.w - 2 * PAD) size -= 0.25;
      while (text.length > 1 && width(text, size) > f.w - 2 * PAD) text = text.slice(0, -2) + "…";
      // The baseline sits so the text is centred in the box: 0.35 of the size below the middle.
      page.drawText(text, { ...f.at(PAD, f.h / 2 - size * 0.35), size, font, color: ink, rotate: f.rot });
    };
    const images = new Map<string, any>();
    const png = async (b64: string) => {
      if (!images.has(b64)) images.set(b64, await doc.embedPng(b64));
      return images.get(b64);
    };
    const fitImage = async (page: any, box: any, b64: string) => {
      const img = await png(b64);
      const f = frame(page, box);
      const scale = Math.min(f.w / img.width, f.h / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { ...f.at((f.w - w) / 2, (f.h - h) / 2), width: w, height: h, rotate: f.rot });
    };
    const tick = (page: any, box: any) => {
      const f = frame(page, box);
      const s = Math.min(f.w, f.h);
      const ox = (f.w - s) / 2;
      const oy = (f.h - s) / 2;
      const line = (a: number[], b: number[]) => page.drawLine({ start: f.at(ox + a[0] * s, oy + a[1] * s), end: f.at(ox + b[0] * s, oy + b[1] * s), thickness: Math.max(1, s * 0.1), color: ink });
      line([0.18, 0.5], [0.42, 0.24]);
      line([0.42, 0.24], [0.84, 0.8]);
    };

    if (seal) {
      const pages = doc.getPages();
      const sigs: Record<string, string> = job.signatures ?? {};
      for (const fld of job.fields ?? []) {
        const page = pages[Number(fld.page) - 1];
        if (!page) throw new Error(`A field is on page ${fld.page}, which this document doesn't have.`);
        const box = { x: Number(fld.x), y: Number(fld.y), w: Number(fld.w), h: Number(fld.h) };
        const value = fld.value == null ? "" : String(fld.value);
        if (fld.type === "signature" || fld.type === "initials") {
          const b64 = sigs[`${fld.recipient_id}:${fld.type}`];
          if (value && b64) await fitImage(page, box, b64);
          else if (value) throw new Error(`A ${fld.type} field has no adopted ${fld.type} to stamp.`);
        } else if (fld.type === "checkbox") {
          if (/^(true|1|yes|on|checked)$/i.test(value)) tick(page, box);
        } else if (value) {
          fitText(page, box, value);
        }
      }
      for (const page of pages) {
        const f = frame(page, { x: 0, y: 0, w: 1, h: 1 });
        const size = 7;
        page.drawText(footerFor, { ...f.at((f.w - width(footerFor, size)) / 2, 10), size, font, color: muted, rotate: f.rot });
      }
    }

    // The certificate: US Letter pages, laid out top to bottom, a new page whenever the next block won't fit.
    const W = 612, H = 792, M = 48;
    const cert: any[] = [];
    let page: any = null;
    let y = 0;
    const newPage = () => {
      page = doc.addPage([W, H]);
      cert.push(page);
      page.drawText(clean(job.envelope.org_name), { x: M, y: H - M, size: 9, font, color: muted });
      page.drawText(seal ? "Certificate of completion" : "Audit trail", { x: M, y: H - M - 24, size: 18, font, color: ink });
      page.drawLine({ start: { x: M, y: H - M - 36 }, end: { x: W - M, y: H - M - 36 }, thickness: 0.75, color: rule });
      y = H - M - 56;
    };
    const room = (h: number) => { if (!page || y - h < M + 24) newPage(); };
    const wrap = (raw: unknown, size: number, max: number) => {
      const out: string[] = [];
      let line = "";
      for (const word of clean(raw).split(" ")) {
        let w = word;
        while (width(w, size) > max) {
          let cut = w.length - 1;
          while (cut > 1 && width(w.slice(0, cut), size) > max) cut -= 1;
          if (line) { out.push(line); line = ""; }
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        const next = line ? `${line} ${w}` : w;
        if (width(next, size) > max && line) { out.push(line); line = w; } else line = next;
      }
      if (line) out.push(line);
      return out.length ? out : [""];
    };
    const pair = (label: string, value: unknown, x = M, max = W - 2 * M) => {
      const lines = wrap(value || "—", 9, max - 130);
      room(lines.length * 12 + 2);
      page.drawText(label, { x, y, size: 8, font, color: muted });
      lines.forEach((l, i) => page.drawText(l, { x: x + 130, y: y - i * 12, size: 9, font, color: ink }));
      y -= lines.length * 12 + 2;
    };
    const heading = (t: string) => {
      room(40);
      y -= 8;
      page.drawText(t, { x: M, y, size: 12, font, color: ink });
      y -= 18;
    };
    const when = (ms: unknown) => {
      const n = Number(ms);
      return ms && n > 0 ? new Date(n).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "";
    };
    const env = job.envelope;
    const events: any[] = (job.events ?? []).map((e: any) => {
      let data: any = {};
      try { data = e.data ? JSON.parse(e.data) : {}; } catch { data = {}; }
      return { ...e, data };
    });
    const firstEvent = (kind: string, rid: number) => events.find((e) => e.kind === kind && Number(e.data?.recipient_id) === Number(rid));

    newPage();
    heading("Document");
    pair("Title", env.title);
    pair("Envelope ID", env.public_id);
    pair("Sent by", env.sender);
    pair("Pages", env.page_count);
    pair("Original SHA-256", env.original_sha256);
    if (!seal) pair("Signed copy SHA-256", env.final_sha256 || "Not sealed yet");
    pair("Audit chain head", env.chain_head);
    pair("Completed", when(env.completed_at) || "Not completed");
    if (seal) {
      const signer = job.signing?.cert && job.signing?.key ? (() => { const der = pemBlocks(job.signing.cert, "CERTIFICATE")[0]; return der ? certParts(der).subject : ""; })() : "";
      pair("Digital signature", signer
        ? `Embedded in this file, signed as ${signer}. A PDF reader shows whether the file has changed since it was sealed.`
        : "None embedded. Check this file on the verify page: its fingerprint is in every party's completion email.");
    }
    if (!seal) pair("Integrity check", env.chain_ok ? `Passed: ${events.length} events, each chained to the one before` : `Failed at event ${env.broken_at}`);
    if (seal) {
      for (const l of wrap("This file's own SHA-256 fingerprint can't be printed inside it. It's in each party's completion email, and anyone can check this file on the verify page.", 8, W - 2 * M)) {
        room(11);
        page.drawText(l, { x: M, y, size: 8, font, color: muted });
        y -= 11;
      }
    }

    const ROLE: Record<string, string> = { signer: "Signer", approver: "Approver", viewer: "Viewer", cc: "Receives a copy" };
    const IDENTITY: Record<string, string> = { none: "Email link", access_code: "Access code", email_code: "One-time code by email" };
    heading("Parties");
    for (const r of job.recipients ?? []) {
      room(120);
      y -= 4;
      page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.5, color: rule });
      const title = `${clean(r.name || r.email)}  ·  ${ROLE[r.role] ?? r.role}${r.role_name ? ` (${clean(r.role_name)})` : ""}`;
      page.drawText(title, { x: M, y: y - 4, size: 10.5, font, color: ink });
      y -= 20;
      const top = y;
      const sig = (job.signatures ?? {})[`${r.id}:signature`];
      if (sig && r.status === "completed") {
        const img = await png(sig);
        const scale = Math.min(150 / img.width, 44 / img.height);
        page.drawImage(img, { x: W - M - img.width * scale, y: top - img.height * scale, width: img.width * scale, height: img.height * scale });
      }
      const max = W - 2 * M - 160;
      pair("Email", r.email, M, max);
      if (r.role !== "cc") {
        pair("Identity check", IDENTITY[r.identity_check] ?? r.identity_check, M, max);
        pair("Consent", r.consented_at ? `${when(r.consented_at)}, disclosure version ${r.disclosure_version ?? "—"}` : "", M, max);
        pair("IP address", r.ip, M, max);
        pair("Device", r.user_agent, M, max);
        pair("Sent", when((firstEvent("recipient.invited", r.id) ?? firstEvent("recipient.sent", r.id))?.at), M, max);
        pair("Opened", when(r.opened_at), M, max);
        pair(r.role === "approver" ? "Approved" : "Signed", when(r.completed_at), M, max);
        if (r.host_name) pair("In person", `Signed in person, hosted by ${clean(r.host_name)}`, M, max);
      }
      y = Math.min(y, top - 50) - 6;
    }

    const KIND: Record<string, string> = {
      "envelope.created": "Document uploaded", "envelope.in_progress": "Sent for signature", "envelope.sealing": "Everyone finished",
      "envelope.completed": "Completed", "envelope.declined": "Declined", "envelope.voided": "Voided", "envelope.expired": "Expired",
      "envelope.seal_failed": "Signed copy couldn't be made", "envelope.seal_retried": "Signed copy retried", "link.created": "Signing link made",
      "recipient.sent": "Invitation sent", "recipient.opened": "Opened", "recipient.completed": "Finished", "recipient.declined": "Declined",
    };
    const plain = (k: string) => KIND[k] ?? (k.replace(/^[a-z]+\./, "").replace(/[._]+/g, " ").replace(/^./, (c) => c.toUpperCase()));
    const COLS = [M, M + 112, M + 300, M + 436];
    const header = () => {
      room(40);
      ["Time (UTC)", "Event", "By", "IP address"].forEach((t, i) => page.drawText(t, { x: COLS[i], y, size: 8, font, color: muted }));
      y -= 14;
    };
    heading("Audit trail");
    header();
    for (const e of events) {
      const what = wrap(plain(e.kind) + (e.data?.recipient_email ? ` · ${e.data.recipient_email}` : ""), 8, 180);
      const who = wrap(e.actor_name || e.actor_email || (e.actor_type === "system" || !e.actor_type ? "Countersign" : e.actor_type), 8, 128);
      const lines = Math.max(what.length, who.length);
      if (y - lines * 10 < M + 24) { newPage(); header(); }
      page.drawText(when(e.at).replace(" UTC", ""), { x: COLS[0], y, size: 8, font, color: ink });
      what.forEach((l, i) => page.drawText(l, { x: COLS[1], y: y - i * 10, size: 8, font, color: ink }));
      who.forEach((l, i) => page.drawText(l, { x: COLS[2], y: y - i * 10, size: 8, font, color: ink }));
      page.drawText(clean(e.ip).slice(0, 40), { x: COLS[3], y, size: 8, font, color: ink });
      y -= lines * 10 + 4;
    }
    cert.forEach((p, i) => {
      const t = `${footerFor} · ${seal ? "Certificate" : "Audit trail"} page ${i + 1} of ${cert.length}`;
      p.drawText(t, { x: (W - width(t, 7)) / 2, y: 20, size: 7, font, color: muted });
    });

    doc.setTitle(clean(env.title));
    doc.setProducer("Countersign");
    doc.setCreator("Countersign");
    const signing = seal && job.signing?.cert && job.signing?.key ? job.signing : null;
    let bytes: Uint8Array;
    if (!signing) bytes = await doc.save();
    else {
      // An invisible signature field on the certificate's last page, its value a signature dictionary whose /Contents is filled
      // after saving: every byte of the file except that hex string is what the signature covers.
      const { PDFName, PDFNumber, PDFHexString, PDFString, PDFArray, PDFDict } = holder.PDFLib;
      const ctx = doc.context;
      const ROOM = 16384;
      const range = PDFArray.withContext(ctx);
      range.push(PDFNumber.of(0));
      for (let i = 0; i < 3; i++) range.push(PDFName.of("**********"));
      const sigDict = ctx.obj({
        Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: range,
        Contents: PDFHexString.of("0".repeat(ROOM * 2)), M: PDFString.fromDate(new Date()),
        Name: PDFString.of(clean(signing.name || env.org_name)), Reason: PDFString.of(clean(`Sealed by Countersign after every party signed. Document ID ${env.public_id}.`)),
      });
      const sigRef = ctx.register(sigDict);
      const last = doc.getPages()[doc.getPageCount() - 1];
      const widgetRef = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", Rect: [0, 0, 0, 0], V: sigRef, T: PDFString.of("Countersign seal"), F: 132, P: last.ref }));
      last.node.addAnnot(widgetRef);
      const form = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
      if (form) {
        const fields = form.lookupMaybe(PDFName.of("Fields"), PDFArray);
        if (fields) fields.push(widgetRef); else form.set(PDFName.of("Fields"), ctx.obj([widgetRef]));
        form.set(PDFName.of("SigFlags"), PDFNumber.of(3));
      } else doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ SigFlags: 3, Fields: [widgetRef] }));
      const out: Uint8Array = await doc.save({ useObjectStreams: false });
      const text = Buffer.from(out).toString("latin1");
      const hole = text.lastIndexOf(`<${"0".repeat(ROOM * 2)}>`);
      const br = text.lastIndexOf("/ByteRange [");
      if (hole < 0 || br < 0) throw new Error("The signature's place in the file couldn't be found.");
      const brEnd = text.indexOf("]", br);
      const holeEnd = hole + ROOM * 2 + 2;
      const nums = [0, hole, holeEnd, out.length - holeEnd];
      const filled = `/ByteRange [${nums.join(" ")}`;
      const width = brEnd - br;
      if (filled.length > width) throw new Error("The signature's byte range didn't fit.");
      out.set(new TextEncoder().encode(filled + " ".repeat(width - filled.length)), br);
      const signed = await cms(digestOf(cat(out.slice(0, hole), out.slice(holeEnd))), signing);
      const hex = Buffer.from(signed).toString("hex");
      if (hex.length > ROOM * 2) throw new Error("The signature is larger than the room left for it; use a shorter certificate chain.");
      out.set(new TextEncoder().encode(hex), hole + 1);
      bytes = out;
    }
    const pagesOut = doc.getPageCount();
    if (!seal) return { ok: true, b64: Buffer.from(bytes).toString("base64"), pages: pagesOut };

    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    // FormData and Blob are Node globals the lambda typings don't declare.
    const web = globalThis as unknown as { FormData: new () => any; Blob: new (parts: unknown[], o: { type: string }) => unknown };
    const form = new web.FormData();
    form.append("file", new web.Blob([bytes], { type: "application/pdf" }), "signed.pdf");
    const put = await fetch(job.put_url, { method: "POST", headers, body: form });
    const said = await put.text();
    if (!put.ok) return { ok: false, error: `Storing the signed copy answered ${put.status}: ${said.slice(0, 200)}` };
    const stored = JSON.parse(said);
    return { ok: true, sha256, size: bytes.length, pages: pagesOut, original_pages: originalPages, file_id: stored.file_id, stored_sha256: stored.sha256, digitally_signed: !!signing };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
}
