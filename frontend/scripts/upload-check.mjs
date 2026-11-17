#!/usr/bin/env node
// Uploads over real HTTP, against a deployed backend: what a workflow test can't send. A multipart PDF just under and just over the
// table-mode limit, a PNG named .pdf, a retry with the same client id, the original coming back byte for byte with its safe headers,
// and another member being refused it. Signed mode (cloud) takes up to 15 MB; on the local Engine the table limit of 5 MB applies.
//
//   node frontend/scripts/upload-check.mjs --backend <url>
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFDocument } = require("pdf-lib");

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const backend = opt("backend")?.replace(/\/$/, "");
if (!backend) { console.error("usage: upload-check.mjs --backend <url>"); process.exit(2); }

const MB = 1024 * 1024;
let failed = 0;
const check = (ok, what, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
};
const sha = (b) => createHash("sha256").update(b).digest("hex");

const http = async (verb, path, token, body) => {
  const res = await fetch(backend + path, {
    method: verb,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${verb} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const signIn = async (persona) => (await http("POST", "/api:authn/auth/demo", null, { persona })).authToken;

/** A real PDF of exactly `size` bytes: one page, padded with an unreferenced stream of random bytes. */
const pdfOfSize = async (size) => {
  const build = async (pad) => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([792, 612]);
    doc.context.register(doc.context.stream(randomBytes(pad), {}));
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  };
  // The overhead grows a little with the pad (longer lengths and offsets), so settle it in a few tries.
  let pad = size - 1000;
  for (let i = 0; i < 5; i += 1) {
    const bytes = await build(pad);
    if (bytes.length === size) return bytes;
    pad += size - bytes.length;
  }
  throw new Error(`couldn't build a PDF of exactly ${size} bytes`);
};

const stamp = Date.now();
let made = 0;
const upload = async (token, name, type, bytes, extra = {}) => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  form.append("client_id", extra.client_id ?? `upload-check-${stamp}-${++made}`);
  for (const [k, v] of Object.entries(extra)) if (k !== "client_id") form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const started = Date.now();
  const res = await fetch(`${backend}/api:documents/envelopes`, { method: "POST", body: form, headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported below */ }
  return { status: res.status, ms: Date.now() - started, ...(json ?? { raw: text.slice(0, 300) }) };
};

const jordan = await signIn("jordan");
const sam = await signIn("sam");

const storage = await http("GET", "/api:documents/document-storage", jordan);
check(["signed", "table"].includes(storage.mode), "storage mode", `${storage.mode}, up to ${storage.max_upload_bytes / MB} MB`);
const limit = storage.max_upload_bytes;
const limitMb = limit / MB;

// Just under the limit: accepted, fingerprinted, pages read.
const under = await pdfOfSize(Math.floor((limitMb - 0.1) * MB));
const sources = [{ name: "Part one.pdf", sha256: sha(Buffer.from("one")), pages: 1 }, { name: "Part two.pdf", sha256: sha(Buffer.from("two")), pages: 1 }];
const ok = await upload(jordan, "Big lease.pdf", "application/pdf", under, { title: "Big lease", sources });
check(ok.status === 200 && ok.ok === true, `${(under.length / MB).toFixed(2)} MB PDF accepted`, ok.ok ? `${ok.ms} ms` : JSON.stringify(ok).slice(0, 300));
check(ok.envelope?.original_sha256 === sha(under), "fingerprint is the SHA-256 of the uploaded bytes", ok.envelope?.original_sha256);
check(ok.envelope?.page_count === 2 && ok.envelope?.pages?.[1]?.w === 792, "page metadata from the server check", JSON.stringify(ok.envelope?.pages ?? null));
check(/^CS-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(ok.envelope?.public_id ?? ""), "random public id", ok.envelope?.public_id);
check(ok.envelope?.sources?.[1]?.name === "Part two.pdf", "client-reported sources kept from a multipart JSON field", JSON.stringify(ok.envelope?.sources ?? null));

// Just over: refused, naming the limit.
const over = await pdfOfSize(limit + 1);
const tooBig = await upload(jordan, "Too big.pdf", "application/pdf", over);
check(tooBig.status === 200 && tooBig.ok === false && tooBig.code === "too_big" && tooBig.message.includes(`${limitMb} MB`), `${(over.length / MB).toFixed(2)} MB PDF refused`, tooBig.message ?? JSON.stringify(tooBig).slice(0, 200));

// Table mode only: 6 MB, refused naming 5 MB (signed mode takes it).
if (storage.mode === "table") {
  const six = await pdfOfSize(6 * MB);
  const r = await upload(jordan, "Six.pdf", "application/pdf", six);
  check(r.ok === false && r.message === "This file is over the 5 MB limit for this deployment.", "6.00 MB PDF refused in table mode", r.message);
}

// A PNG named .pdf, with a PDF content type: the bytes decide.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fake = await upload(jordan, "Contract.pdf", "application/pdf", png);
check(fake.ok === false && fake.code === "not_pdf", "PNG named .pdf refused by its bytes", fake.message);

// A retry with the same client id answers the same draft.
const small = await pdfOfSize(20_000);
const clientId = `upload-check-${stamp}-retry`;
const first = await upload(jordan, "Retry.pdf", "application/pdf", small, { client_id: clientId });
const again = await upload(jordan, "Retry.pdf", "application/pdf", small, { client_id: clientId });
check(first.ok && again.ok && again.repeat === true && again.envelope?.id === first.envelope?.id, "retry with the same client id answers the same draft", `${first.envelope?.id} / ${again.envelope?.id}`);

// The original comes back byte for byte with safe headers, to the sender only (the draft is private).
if (ok.envelope) {
  const id = ok.envelope.id;
  const link = await http("GET", `/api:documents/envelopes/${id}/original`, jordan);
  check(link.how === storage.mode, "original link answers the storage path", link.how);
  let got;
  if (link.how === "table") {
    const res = await fetch(`${backend}/api:documents/envelopes/${id}/original/raw`, { headers: { authorization: `Bearer ${jordan}` } });
    got = Buffer.from(await res.arrayBuffer());
    const h = (k) => res.headers.get(k) ?? "";
    check(h("content-type").startsWith("application/pdf"), "Content-Type", h("content-type"));
    check(h("content-disposition").startsWith("attachment;") && h("content-disposition").includes("filename*=UTF-8''Big%20lease.pdf"), "Content-Disposition", h("content-disposition"));
    check(h("x-content-type-options") === "nosniff", "X-Content-Type-Options", h("x-content-type-options"));
    check(h("content-security-policy").startsWith("sandbox"), "Content-Security-Policy", h("content-security-policy"));
    check(h("cache-control").includes("no-store"), "Cache-Control", h("cache-control"));
  } else if (link.how === "signed") {
    got = Buffer.from(await (await fetch(link.url)).arrayBuffer());
  }
  check(got && sha(got) === sha(under), "original comes back byte for byte", got ? `${got.length} bytes` : "nothing");

  const theirs = await http("GET", `/api:documents/envelopes/${id}/original`, sam);
  check(theirs.how === "refused" && theirs.url === null, "another member is refused the link", theirs.how);
  const stolen = await fetch(`${backend}/api:documents/envelopes/${id}/original/raw`, { headers: { authorization: `Bearer ${sam}` } });
  check(stolen.status === 404, "another member gets no bytes", String(stolen.status));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
