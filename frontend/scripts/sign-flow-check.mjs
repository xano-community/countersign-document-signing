#!/usr/bin/env node
// Send and sign, end to end over HTTP, with no email set up (links are shared by hand):
// a demo sender uploads a PDF, adds two signers in order, places fields, sends; the second signer's link says it isn't their
// turn; the first consents, adopts a signature, fills in and finishes; the second is invited, signs, and the document moves
// to finishing. Also: characters the PDF can't draw are refused, and a session ends when someone else declines.
// Usage: node frontend/scripts/sign-flow-check.mjs --backend http://127.0.0.1:60340 [--app http://localhost:5173]
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const B = arg("backend"); const APP = arg("app", "http://localhost:5173");
if (!B) { console.error("--backend <url> is required"); process.exit(2); }
let failed = 0;
const ok = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); if (!cond) failed++; };
const call = async (verb, path, body, token, form) => {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !form) headers["content-type"] = "application/json";
  const r = await fetch(B + path, { method: verb, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function pdf() {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) { const p = doc.addPage([612, 792]); p.drawText(`Lease page ${i + 1}`, { x: 72, y: 720, size: 14, font }); if (i === 1) p.setRotation(degrees(90)); }
  return doc.save();
}

async function main() {
  const sender = (await call("POST", "/api:authn/auth/demo", { persona: "jordan" })).body.authToken;
  ok("demo sender signs in", !!sender);
  const run = Date.now();
  const fd = new FormData();
  fd.append("file", new Blob([await pdf()], { type: "application/pdf" }), "lease.pdf");
  fd.append("client_id", `flow-${run}`); fd.append("title", `Flow check ${run}`); fd.append("visibility", "team");
  const made = await call("POST", "/api:documents/envelopes", undefined, sender, fd);
  const envId = made.body?.envelope?.id ?? made.body?.envelope_id ?? made.body?.id;
  ok("upload makes a draft", made.status === 200 && made.body?.ok !== false && !!envId, JSON.stringify(made.body).slice(0, 160));

  ok("ordered signing saved", (await call("PATCH", `/api:envelopes/envelopes/${envId}`, { title: `Flow check ${run}`, subject: "", message: "Please sign.", expiry_days: 30, reminder_days: 3, visibility: "team", signing_order: "ordered" }, sender)).status === 200);
  const people = await call("PUT", `/api:envelopes/envelopes/${envId}/recipients`, { recipients: [
    { name: "Ana Flow", email: `ana-${run}@example.com`, role: "signer", step: 1, identity_check: "none" },
    { name: "Ben Flow", email: `ben-${run}@example.com`, role: "signer", step: 2, identity_check: "none" },
    { name: "Accounts", email: `acc-${run}@example.com`, role: "cc", step: 2, identity_check: "none" },
  ] }, sender);
  ok("recipients saved", people.status === 200 && people.body.length === 3, JSON.stringify(people.body).slice(0, 120));
  const [ana, ben] = people.body;
  const fields = await call("PUT", `/api:envelopes/envelopes/${envId}/fields`, { fields: [
    { recipient_id: ana.id, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.06, required: true },
    { recipient_id: ana.id, type: "date", page: 1, x: 0.1, y: 0.88, w: 0.2, h: 0.03, required: true },
    { recipient_id: ana.id, type: "text", page: 2, x: 0.1, y: 0.1, w: 0.4, h: 0.04, required: true, label: "Unit number" },
    { recipient_id: ben.id, type: "signature", page: 1, x: 0.55, y: 0.8, w: 0.3, h: 0.06, required: true },
  ] }, sender);
  ok("fields saved", fields.status === 200 && fields.body.length === 4);
  const view = await call("GET", `/api:envelopes/envelopes/${envId}/prepare`, undefined, sender);
  ok("prepare view: ready to send", view.status === 200 && view.body.problems.length === 0 && view.body.editable === true, JSON.stringify(view.body.problems));

  const sent = await call("POST", `/api:envelopes/envelopes/${envId}/send`, { app_url: APP }, sender);
  ok("send answers Ana's link to share (no email set up)", sent.status === 200 && sent.body.links?.length === 1 && sent.body.links[0].recipient_id === ana.id, JSON.stringify(sent.body).slice(0, 200));
  const anaToken = sent.body.links[0].url.split("/sign/")[1];

  const benLink = await call("POST", `/api:envelopes/envelopes/${envId}/recipients/${ben.id}/link`, { app_url: APP }, sender);
  const benToken = benLink.body.url?.split("/sign/")[1];
  const early = await call("POST", "/api:sign/sign/open", { token: benToken });
  ok("Ben's link before Ana finishes: not your turn", early.body.state === "not_your_turn" && early.body.envelope?.ahead?.length === 1, JSON.stringify(early.body).slice(0, 160));

  const opened = await call("POST", "/api:sign/sign/open", { token: anaToken });
  ok("Ana opens: consent needed, branding and pages present", opened.body.state === "active" && opened.body.needs === "consent" && opened.body.envelope?.page_count === 2, JSON.stringify(opened.body).slice(0, 160));
  ok("unknown link: not found", (await call("POST", "/api:sign/sign/open", { token: "nope" })).body.state === "not_found");
  const consent = await call("POST", "/api:sign/sign/consent", { token: anaToken, disclosure_version: opened.body.disclosure.version, agree: true });
  const anaSession = consent.body.session;
  ok("consent starts a session", !!anaSession, JSON.stringify(consent.body).slice(0, 120));
  ok("a signer session is refused on member routes", (await call("GET", "/api:authn/auth/me", undefined, anaSession)).status === 401);

  const state = await call("GET", "/api:signing/signing/state", undefined, anaSession);
  ok("signing state: Ana's three fields", state.status === 200 && state.body.fields.length === 3);
  const doc = await call("GET", "/api:signing/signing/document", undefined, anaSession);
  ok("document is reachable", doc.status === 200 && ["table", "signed"].includes(doc.body.how));
  if (doc.body.how === "table") {
    const raw = await fetch(B + "/api:signing/signing/document/raw", { headers: { authorization: `Bearer ${anaSession}` } });
    const bytes = new Uint8Array(await raw.arrayBuffer());
    ok("raw document is a PDF, no referrer leaks", raw.status === 200 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-" && raw.headers.get("referrer-policy") === "no-referrer");
  }
  const sig = state.body.fields.find((f) => f.type === "signature"); const txt = state.body.fields.find((f) => f.type === "text");
  ok("signing before adopting is refused", (await call("POST", "/api:signing/signing/fill", { field_id: sig.id, value: "adopted" }, anaSession)).status === 400);
  const adopted = await call("POST", "/api:signing/signing/adopt", { kind: "signature", method: "drawn", png_b64: `data:image/png;base64,${PNG}` }, anaSession);
  ok("adopt a signature (as a data URL)", adopted.status === 200, JSON.stringify(adopted.body).slice(0, 200));
  ok("a non-image signature is refused", (await call("POST", "/api:signing/signing/adopt", { kind: "signature", method: "uploaded", png_b64: Buffer.from("hello").toString("base64") }, anaSession)).status === 400);
  ok("sign the field", (await call("POST", "/api:signing/signing/fill", { field_id: sig.id, value: "adopted" }, anaSession)).status === 200);
  const cjk = await call("POST", "/api:signing/signing/fill", { field_id: txt.id, value: "山田" }, anaSession);
  ok("characters the PDF can't draw are refused", cjk.status === 400, JSON.stringify(cjk.body).slice(0, 120));
  ok("accented Latin is fine", (await call("POST", "/api:signing/signing/fill", { field_id: txt.id, value: "Zoë, Unit 3" }, anaSession)).status === 200);
  const early2 = await call("POST", "/api:signing/signing/finish", { agree: false }, anaSession);
  ok("finishing without agreeing is refused", early2.status === 400);
  const done = await call("POST", "/api:signing/signing/finish", { agree: true, timezone: "Australia/Sydney" }, anaSession);
  ok("Ana finishes", done.status === 200 && done.body.finishing === false, JSON.stringify(done.body));
  ok("Ana's session ends after finishing", (await call("GET", "/api:signing/signing/state", undefined, anaSession)).status === 401);

  const benOpen = await call("POST", "/api:sign/sign/open", { token: benToken });
  ok("Ben is now invited", benOpen.body.state === "active", JSON.stringify(benOpen.body).slice(0, 120));
  const benSession = (await call("POST", "/api:sign/sign/consent", { token: benToken, disclosure_version: benOpen.body.disclosure.version, agree: true })).body.session;
  const benState = await call("GET", "/api:signing/signing/state", undefined, benSession);
  ok("Ben sees Ana's filled fields", benState.body.others?.length >= 2, `${benState.body.others?.length}`);
  await call("POST", "/api:signing/signing/adopt", { kind: "signature", method: "typed", png_b64: PNG }, benSession);
  await call("POST", "/api:signing/signing/fill", { field_id: benState.body.fields[0].id, value: "adopted" }, benSession);
  const benDone = await call("POST", "/api:signing/signing/finish", { agree: true }, benSession);
  ok("Ben finishes, and the document starts finishing", benDone.status === 200 && benDone.body.finishing === true, JSON.stringify(benDone.body));
  const again = await call("POST", "/api:sign/sign/open", { token: anaToken });
  ok("Ana's link now says it's finishing", ["finishing", "completed"].includes(again.body.state), again.body.state);

  // The seal starts on its own once Ben's answer has gone, and the envelope completes.
  let detail;
  for (let i = 0; i < 30; i++) {
    detail = (await call("GET", `/api:envelopes/envelopes/${envId}`, undefined, sender)).body;
    if (detail.envelope?.status === "completed" || detail.envelope?.seal_failed) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok("the seal completes on its own", detail.envelope?.status === "completed", `${detail.envelope?.status} ${detail.envelope?.seal_error ?? ""}`);
  ok("the audit trail verifies, and the head printed on the certificate is recorded", detail.integrity?.ok === true && /^[0-9a-f]{64}$/.test(detail.envelope?.chain_head ?? ""));
  ok("the CC is completed with the envelope", detail.recipients.find((r) => r.role === "cc")?.status === "completed");
  const raw = await fetch(`${B}/api:documents/envelopes/${envId}/final/raw`, { headers: { authorization: `Bearer ${sender}` } });
  const finalBytes = Buffer.from(await raw.arrayBuffer());
  const { createHash } = await import("node:crypto");
  const finalHash = createHash("sha256").update(finalBytes).digest("hex");
  ok("the signed PDF downloads and matches its fingerprint", raw.status === 200 && finalHash === detail.envelope.final_sha256, `${raw.status} ${finalBytes.length} bytes`);
  const signedDoc = await PDFDocument.load(finalBytes);
  ok("the signed PDF has the document plus a certificate", signedDoc.getPageCount() >= 3, `${signedDoc.getPageCount()} pages`);
  const v1 = await call("POST", "/api:verify/verify", { sha256: finalHash });
  ok("verify: a match with no names for a fingerprint alone", v1.body.state === "match" && v1.body.signers == null && v1.body.signer_count === 2, JSON.stringify(v1.body).slice(0, 160));
  const v2 = await call("POST", "/api:verify/verify", { sha256: finalHash, public_id: detail.envelope.public_id });
  ok("verify: names with the matching public id", v2.body.state === "match" && v2.body.signers?.length === 2);
  const v3 = await call("POST", "/api:verify/verify", { sha256: "0".repeat(64) });
  ok("verify: an unknown fingerprint is no match", v3.body.state === "no_match");
  const queued = detail.emails.filter((e) => e.kind === "completed").length;
  ok("everyone, CC included, gets a completed email", queued === 3, `${queued}`);

  // A third envelope: correcting a signer's email ends their open session and their old link.
  const fd3 = new FormData(); fd3.append("file", new Blob([await pdf()], { type: "application/pdf" }), "offer.pdf"); fd3.append("client_id", `flow3-${run}`); fd3.append("title", `Correct check ${run}`);
  const env3 = (await call("POST", "/api:documents/envelopes", undefined, sender, fd3)).body;
  const id3 = env3?.envelope?.id ?? env3?.envelope_id ?? env3?.id;
  const [eve] = (await call("PUT", `/api:envelopes/envelopes/${id3}/recipients`, { recipients: [{ name: "Eve", email: `eve-${run}@example.com`, role: "signer", identity_check: "none" }] }, sender)).body;
  await call("PUT", `/api:envelopes/envelopes/${id3}/fields`, { fields: [{ recipient_id: eve.id, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.06 }] }, sender);
  const eveTok = (await call("POST", `/api:envelopes/envelopes/${id3}/send`, { app_url: APP }, sender)).body.links[0].url.split("/sign/")[1];
  const eveOpen = await call("POST", "/api:sign/sign/open", { token: eveTok });
  const eveSession = (await call("POST", "/api:sign/sign/consent", { token: eveTok, disclosure_version: eveOpen.body.disclosure.version, agree: true })).body.session;
  ok("Eve's session works before the correction", (await call("GET", "/api:signing/signing/state", undefined, eveSession)).status === 200);
  const fixed = await call("POST", `/api:envelopes/envelopes/${id3}/recipients/${eve.id}/correct`, { name: "Eve Fixed", email: `eve2-${run}@example.com`, app_url: APP }, sender);
  ok("the sender corrects Eve's email", fixed.status === 200, JSON.stringify(fixed.body).slice(0, 120));
  ok("Eve's open session is ended by the correction", (await call("GET", "/api:signing/signing/state", undefined, eveSession)).status === 401);
  ok("Eve's old link says it's been replaced", (await call("POST", "/api:sign/sign/open", { token: eveTok })).body.state === "replaced");

  // A second envelope: a decline ends another signer's open session.
  const fd2 = new FormData(); fd2.append("file", new Blob([await pdf()], { type: "application/pdf" }), "nda.pdf"); fd2.append("client_id", `flow2-${run}`); fd2.append("title", `Decline check ${run}`);
  const env2 = (await call("POST", "/api:documents/envelopes", undefined, sender, fd2)).body;
  const id2 = env2?.envelope?.id ?? env2?.envelope_id ?? env2?.id;
  const ppl2 = (await call("PUT", `/api:envelopes/envelopes/${id2}/recipients`, { recipients: [
    { name: "Cy", email: `cy-${run}@example.com`, role: "signer", identity_check: "none" },
    { name: "Di", email: `di-${run}@example.com`, role: "signer", identity_check: "access_code", access_code: "4821" },
  ] }, sender)).body;
  await call("PUT", `/api:envelopes/envelopes/${id2}/fields`, { fields: ppl2.map((p, i) => ({ recipient_id: p.id, type: "signature", page: 1, x: 0.1 + i * 0.45, y: 0.8, w: 0.3, h: 0.06 })) }, sender);
  const sent2 = (await call("POST", `/api:envelopes/envelopes/${id2}/send`, { app_url: APP }, sender)).body;
  const cyTok = sent2.links.find((l) => l.name === "Cy").url.split("/sign/")[1];
  const diTok = sent2.links.find((l) => l.name === "Di").url.split("/sign/")[1];
  const diOpen = await call("POST", "/api:sign/sign/open", { token: diTok });
  ok("an access code is asked for first", diOpen.body.needs === "identity");
  ok("a wrong code is refused with tries left", (await call("POST", "/api:sign/sign/identity", { token: diTok, code: "0000" })).body.state === "wrong_code");
  ok("the right code passes", (await call("POST", "/api:sign/sign/identity", { token: diTok, code: "4821" })).body.ok === true);
  const diSession = (await call("POST", "/api:sign/sign/consent", { token: diTok, disclosure_version: diOpen.body.disclosure.version, agree: true })).body.session;
  const cyOpen = await call("POST", "/api:sign/sign/open", { token: cyTok });
  const cySession = (await call("POST", "/api:sign/sign/consent", { token: cyTok, disclosure_version: cyOpen.body.disclosure.version, agree: true })).body.session;
  ok("declining needs a reason", (await call("POST", "/api:signing/signing/decline", { reason: "" }, cySession)).status === 400);
  ok("Cy declines", (await call("POST", "/api:signing/signing/decline", { reason: "Wrong start date" }, cySession)).status === 200);
  ok("Di's open session is ended by the decline", (await call("GET", "/api:signing/signing/state", undefined, diSession)).status === 401);
  ok("Di's link says declined", (await call("POST", "/api:sign/sign/open", { token: diTok })).body.state === "declined");

  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
