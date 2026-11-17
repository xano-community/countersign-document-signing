// What the over-HTTP checks share: arguments, calls as a demo person, a lease PDF, a document made and sent like the app makes
// one, a pass/fail line, and Chrome for the browser checks. Not a check on its own.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib");

const argv = process.argv.slice(2);
export const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
export const backend = opt("backend")?.replace(/\/$/, "");
/** The app's address, for links a check opens in a browser. */
export const frontend = (opt("frontend") ?? opt("app") ?? "http://localhost:5173").replace(/\/$/, "");
export function needBackend(script) {
  if (!backend) { console.error(`usage: node frontend/scripts/${script} --backend <url> [--frontend <url>]`); process.exit(2); }
}

let failed = 0;
export const ok = (pass, message) => { console.log(`${pass ? "PASS" : "FAIL"}  ${message}`); if (!pass) failed++; };
export const finish = () => { console.log(failed ? `\n${failed} failed` : "\nall passed"); process.exit(failed ? 1 : 0); };

/** A JSON call; `token` is a member's session or an API key. Answers { status, body }. */
export async function call(verb, path, body, token, form) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !form) headers["content-type"] = "application/json";
  const r = await fetch(backend + path, { method: verb, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
/** Like call, but throws on anything but 2xx, with the server's message. */
export async function must(verb, path, body, token, form) {
  const r = await call(verb, path, body, token, form);
  if (r.status < 200 || r.status > 299) throw new Error(`${verb} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}
export const signIn = async (persona) => (await must("POST", "/api:authn/auth/demo", { persona })).authToken;

/** A two-page lease with signature lines, made fresh. */
export async function leasePdf(title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(title, { x: 72, y: 710, size: 20, font });
    for (let k = 0; k < 20; k++) p.drawText("The tenant shall pay rent on the first day of each month, by bank transfer.", { x: 72, y: 660 - k * 20, size: 10, font });
  }
  return doc.save();
}

/** Upload, add people, place fields, and (with send) send: the app's own calls, as `token`. Answers { id, people, sent }. */
export async function makeEnvelope(token, { title, people, fields, send = true, run = Date.now() }) {
  const fd = new FormData();
  fd.append("file", new Blob([await leasePdf(title)], { type: "application/pdf" }), "lease.pdf");
  fd.append("client_id", `check-${run}-${Math.random().toString(36).slice(2)}`); fd.append("title", title); fd.append("visibility", "team");
  const id = (await must("POST", "/api:documents/envelopes", undefined, token, fd)).envelope.id;
  await must("PATCH", `/api:envelopes/envelopes/${id}`, { title, subject: "", message: "Please sign.", expiry_days: 14, reminder_days: 3, visibility: "team", signing_order: "ordered" }, token);
  const saved = await must("PUT", `/api:envelopes/envelopes/${id}/recipients`, { recipients: people }, token);
  await must("PUT", `/api:envelopes/envelopes/${id}/fields`, { fields: fields(saved) }, token);
  const sent = send ? await must("POST", `/api:envelopes/envelopes/${id}/send`, { app_url: frontend }, token) : null;
  return { id, people: saved, sent };
}
/** A signature and a date for one person, on page 1. */
export const signHere = (rid, y = 0.7) => [
  { recipient_id: rid, type: "signature", page: 1, x: 0.12, y, w: 0.34, h: 0.06, required: true },
  { recipient_id: rid, type: "date", page: 1, x: 0.12, y: y + 0.08, w: 0.2, h: 0.03, required: true },
];

/** Google Chrome or Chromium for the browser checks: CHROME_PATH, or the usual places. */
export function chromePath() {
  const found = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    .find((p) => p && existsSync(p));
  if (!found) { console.error("Set CHROME_PATH to a Chrome or Chromium binary."); process.exit(2); }
  return found;
}
export async function browser() {
  const { default: puppeteer } = await import("puppeteer-core");
  return puppeteer.launch({ executablePath: chromePath(), headless: "new", args: ["--disable-features=EnergySaver"] });
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A one-pixel PNG: enough of a signature for the server's checks. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Sign every field a link's person has, the way the signing page does: open, agree, adopt, fill, finish. Answers the finish
 * (`{ ok, finishing }`), or `{ state }` when the link isn't theirs to sign right now.
 */
export async function signThrough(linkToken) {
  const opened = await must("POST", "/api:sign/sign/open", { token: linkToken });
  if (opened.state !== "active") return { state: opened.state };
  let session = opened.session;
  if (opened.needs === "consent") session = (await must("POST", "/api:sign/sign/consent", { token: linkToken, disclosure_version: opened.disclosure.version, agree: true })).session;
  if (!session) return { state: `needs ${opened.needs}` };
  const state = await must("GET", "/api:signing/signing/state", undefined, session);
  const kinds = new Set(state.fields.map((f) => f.type));
  for (const kind of ["signature", "initials"]) if (kinds.has(kind) && !state.marks.some((m) => m.kind === kind)) await must("POST", "/api:signing/signing/adopt", { kind, method: "typed", png_b64: PNG }, session);
  for (const f of state.fields) {
    if (f.filled_at || ["name", "email", "date"].includes(f.type)) continue;
    const value = f.type === "signature" || f.type === "initials" ? "adopted" : f.type === "checkbox" ? "true" : f.type === "number" ? "1" : f.options?.[0] ?? "Checked";
    await must("POST", "/api:signing/signing/fill", { field_id: f.id, value }, session);
  }
  return must("POST", "/api:signing/signing/finish", { agree: true, timezone: "UTC" }, session);
}
export const tokenOf = (url) => new URL(url, "http://x").pathname.split("/").pop();
