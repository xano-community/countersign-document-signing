#!/usr/bin/env node
// Checks the Resend webhook route over real HTTP: a correctly signed event is accepted, and a tampered body, a wrong signature,
// an old timestamp and missing headers are refused. Sign with the same secret the backend has in RESEND_WEBHOOK_SECRET.
//
//   node frontend/scripts/email-hook-check.mjs --backend http://127.0.0.1:50101 --secret whsec_...
//
// Exits 1 if any case answers differently from what's expected.
import { createHmac } from "node:crypto";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const backend = (arg("backend") ?? "").replace(/\/+$/, "");
const secret = arg("secret") ?? "";
if (!backend || !secret.startsWith("whsec_")) {
  console.error("Usage: email-hook-check.mjs --backend <url> --secret <whsec_...>");
  process.exit(2);
}
const url = `${backend}/api:email_hooks/resend`;
const sign = (id, ts, body, key = secret) => createHmac("sha256", Buffer.from(key.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
const now = () => String(Math.floor(Date.now() / 1000));
const event = (type) => JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: `check-${Date.now()}`, to: ["nobody@countersign-check.example"] } });

const cases = [
  ["valid signature", () => { const b = event("email.delivered"), id = "msg_check_1", ts = now(); return { b, id, ts, sig: `v1,${sign(id, ts, b)}` }; }, 200, ""],
  ["valid among several (key rotation)", () => { const b = event("email.delivered"), id = "msg_check_2", ts = now(); return { b, id, ts, sig: `v1,AAAAAAAA v1,${sign(id, ts, b)}` }; }, 200, ""],
  ["tampered body", () => { const b = event("email.delivered"), id = "msg_check_3", ts = now(); return { b: b.replace("delivered", "bounced"), id, ts, sig: `v1,${sign(id, ts, b)}` }; }, 401, "bad_signature"],
  ["signed with another secret", () => { const b = event("email.bounced"), id = "msg_check_4", ts = now(); return { b, id, ts, sig: `v1,${sign(id, ts, b, "whsec_" + Buffer.from("not-the-secret").toString("base64"))}` }; }, 401, "bad_signature"],
  ["timestamp 10 minutes old", () => { const b = event("email.bounced"), id = "msg_check_5", ts = String(Number(now()) - 600); return { b, id, ts, sig: `v1,${sign(id, ts, b)}` }; }, 401, "stale"],
  ["no signature headers", () => ({ b: event("email.bounced"), id: "", ts: "", sig: "" }), 401, "missing_headers"],
];

let failed = 0;
for (const [label, make, wantStatus, wantState] of cases) {
  const { b, id, ts, sig } = make();
  const headers = { "content-type": "application/json" };
  if (id) Object.assign(headers, { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig });
  const res = await fetch(url, { method: "POST", headers, body: b });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  const ok = res.status === wantStatus && (body.state ?? "") === wantState;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(36)} HTTP ${res.status}  ${JSON.stringify(body)}`);
}
console.log(failed ? `${failed} case(s) failed` : "All cases behaved as expected.");
process.exit(failed ? 1 : 0);
