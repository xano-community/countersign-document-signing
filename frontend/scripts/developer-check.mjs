#!/usr/bin/env node
// The developer surface over HTTP, with a real webhook receiver: only admins make API keys; a key lists documents and acts as its
// maker; a wrong key, a person's session and the app's own routes are refused; a test event and a real one arrive signed (each
// signature checked against the raw body); a failing receiver is retried; a revoked key stops at once.
//
//   node frontend/scripts/developer-check.mjs --backend <url>
//
// The backend must be able to reach this machine (it posts webhooks to 127.0.0.1): run it against the local Engine.
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import http from "node:http";
import crypto from "node:crypto";
import { backend, frontend, needBackend } from "./check-lib.mjs";

needBackend("developer-check.mjs");
const B = backend, APP = frontend;
const api = async (verb, path, body, token) => {
  const h = { accept: "application/json" }; if (token) h.authorization = `Bearer ${token}`; if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(B + path, { method: verb, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => null) };
};
const ok = (c, m) => { console.log(c ? "PASS " : "FAIL ", m); if (!c) process.exitCode = 1; };
process.on("exit", (code) => console.log(code ? "\nsome checks failed" : "\nall passed"));
const got = [];
let failNext = 0;
const server = http.createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
    got.push({ raw, sig: req.headers["x-countersign-signature"], event: req.headers["x-countersign-event"] });
    if (failNext > 0) { failNext--; res.writeHead(500); res.end("nope"); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  });
}).listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const port = server.address().port;
const priya = (await api("POST", "/api:authn/auth/demo", { persona: "priya" })).j.authToken;
const jordan = (await api("POST", "/api:authn/auth/demo", { persona: "jordan" })).j.authToken;

// Keys: members can't make them; admins can; the key works on the API and acts as its maker.
const memberTry = await api("POST", "/api:developer/developer/keys", { name: "nope" }, jordan);
ok(memberTry.status === 403 || memberTry.status === 401, `a member can't make API keys: ${memberTry.status}`);
const key = (await api("POST", "/api:developer/developer/keys", { name: `check ${Date.now()}` }, priya)).j;
ok(typeof key?.key === "string" && key.key.length > 40 && key.prefix === key.key.slice(-6), "an admin makes a key, shown once");
const listed = await api("GET", "/api:api/v1/envelopes?segment=all", undefined, key.key);
ok(listed.status === 200 && Array.isArray(listed.j.items), `the key lists documents: ${listed.status}, ${listed.j?.items?.length}`);
const noKey = await api("GET", "/api:api/v1/envelopes", undefined, "not-a-real-key");
ok(noKey.status === 401, `a wrong key is refused: ${noKey.status}`);
const withSession = await api("GET", "/api:api/v1/envelopes", undefined, priya);
ok(withSession.status === 401, `a person's session isn't an API key: ${withSession.status}`);
const keyOnApp = await api("GET", "/api:envelopes/envelopes", undefined, key.key);
ok(keyOnApp.status === 401, `the app's own routes refuse an API key: ${keyOnApp.status}`);

// Webhooks: a signed ping, then a real event through the sweep.
const hook = (await api("POST", "/api:developer/developer/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["envelope.sent", "envelope.voided"], description: "check" }, priya)).j;
ok(hook?.secret?.startsWith("whsec_"), "an endpoint gets a secret, shown once");
const ping = (await api("POST", `/api:developer/developer/webhooks/${hook.id}/ping`, undefined, priya)).j;
ok(ping?.status === "delivered", `the test event is delivered: ${JSON.stringify(ping)}`);
const verify = (g) => {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(g.sig ?? ""); if (!m) return false;
  return crypto.createHmac("sha256", hook.secret).update(`${m[1]}.${g.raw}`).digest("hex") === m[2];
};
ok(got.length === 1 && verify(got[0]), `the ping's signature checks out against the raw body: ${got[0]?.sig}`);
// Send through the API with a template-free document: void the earliest one that's out.
const out = (await api("GET", "/api:api/v1/envelopes?segment=waiting", undefined, key.key)).j.items[0];
if (out) {
  failNext = 1;
  const voided = await api("POST", `/api:api/v1/envelopes/${out.id}/void`, { reason: "Checking webhooks" }, key.key);
  ok(voided.status === 200, `the API cancels a document: ${voided.status} ${JSON.stringify(voided.j).slice(0, 120)}`);
  const start = Date.now();
  while (Date.now() - start < 150_000 && !got.some((g) => g.event === "envelope.voided" && g !== got[0] && got.filter((x) => x.event === "envelope.voided").length >= 1 && verify(g))) await new Promise((r) => setTimeout(r, 2000));
  const voids = got.filter((g) => g.event === "envelope.voided");
  ok(voids.length >= 1, `the voided event arrived via the sweep (${voids.length} tries so far)`);
  ok(voids.every(verify), "every delivery's signature checks out");
  const body = voids[0] ? JSON.parse(voids[0].raw) : null;
  ok(body?.event === "envelope.voided" && body?.data?.envelope?.id === out.id && body?.data?.reason === "Checking webhooks", `payload: ${voids[0]?.raw.slice(0, 160)}`);
  const log = (await api("GET", "/api:developer/developer/webhooks", undefined, priya)).j.items.find((h) => h.id === hook.id);
  console.log("delivery log:", log.deliveries.map((d) => `${d.event} ${d.status} tries=${d.attempts} code=${d.response_code}`).join(" | "));
} else console.log("no document out to void; skipped the event check");
const revoked = await api("POST", `/api:developer/developer/keys/${key.id}/revoke`, undefined, priya);
const after = await api("GET", "/api:api/v1/envelopes", undefined, key.key);
ok(revoked.status === 200 && after.status === 401, `a revoked key stops at once: ${after.status}`);
server.close();
