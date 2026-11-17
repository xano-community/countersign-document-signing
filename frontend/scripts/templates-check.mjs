#!/usr/bin/env node
// Templates and the ways to send without email, over HTTP: signing your own document (no invite to yourself), signing in person
// (the trail names the host), saving a document as a template and using it, a template-made draft that asks for its people, a bulk
// send with a bad row, and a public link that waits for email.
//
//   node frontend/scripts/templates-check.mjs --backend <url> [--frontend <url>]
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { finish, frontend as APP, makeEnvelope, must, needBackend, ok, signIn } from "./check-lib.mjs";

needBackend("templates-check.mjs");
const run = Date.now();
const jordan = await signIn("jordan");
/** Throws on anything but 2xx, like must(); the checks below read its message when a call is meant to be refused. */
const api = (verb, path, body, token) => must(verb, path, body, token);
const makeEnv = async (title, people, fieldsFor, send) => makeEnvelope(jordan, { title, people, fields: fieldsFor, send, run });
const lease = (p) => [
  { recipient_id: p[0].id, type: "signature", page: 1, x: 0.118, y: 0.74, w: 0.34, h: 0.06, required: true },
  { recipient_id: p[0].id, type: "date", page: 1, x: 0.118, y: 0.835, w: 0.2, h: 0.028, required: true },
  { recipient_id: p[0].id, type: "initials", page: 1, x: 0.75, y: 0.3, w: 0.09, h: 0.04, required: true },
  { recipient_id: p[0].id, type: "checkbox", page: 1, x: 0.118, y: 0.47, w: 0.03, h: 0.023, required: false, label: "I have a pet" },
  { recipient_id: p[0].id, type: "text", page: 2, x: 0.118, y: 0.5, w: 0.35, h: 0.03, required: true, label: "Vehicle registration" },
  ...(p[1] ? [{ recipient_id: p[1].id, type: "signature", page: 1, x: 0.54, y: 0.74, w: 0.34, h: 0.06, required: true }] : []),
];
const people = [{ name: "Maya Chen", email: `maya-${run}@example.com`, role: "signer", step: 1, identity_check: "none" }, { name: "Jordan Lee", email: "jordan@fernhill.example", role: "signer", step: 2, identity_check: "none" }, { name: "Accounts", email: `accounts-${run}@example.com`, role: "cc", step: 2, identity_check: "none" }];
const out = await makeEnv("Lease renewal — 220 Harbor Rd, Apt 12", people, lease, true);

// Self-sign: Jordan is the only signer.
const solo = await makeEnv(`Just me ${run}`, [{ name: "Jordan Lee", email: "jordan@fernhill.example", role: "signer", step: 1, identity_check: "none" }], (p) => [{ recipient_id: p[0].id, type: "signature", page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.06, required: true }], true);
ok(solo.sent?.ok && solo.sent.links.length === 0, `self-sign sends with no links to share: ${JSON.stringify(solo.sent?.links)}`);
const soloDet = await api("GET", `/api:envelopes/envelopes/${solo.id}`, undefined, jordan);
ok(!soloDet.emails.some((m) => m.kind === "invite"), `no invite email to myself: ${soloDet.emails.map((m) => m.kind).join(",") || "none"}`);
const mine = await api("POST", `/api:envelopes/envelopes/${solo.id}/sign`, { app_url: APP }, jordan);
ok(/\/sign\//.test(mine.url), "Sign now opens my signing link");
// In person: host Maya on the sent lease.
const outDet = await api("GET", `/api:envelopes/envelopes/${out.id}`, undefined, jordan);
const maya = outDet.recipients.find((r) => r.status === "sent" || r.status === "opened");
const hosted = await api("POST", `/api:envelopes/envelopes/${out.id}/recipients/${maya.id}/host`, { app_url: APP }, jordan);
ok(/\/sign\//.test(hosted.url), `in-person link for ${hosted.name}`);
const after = await api("GET", `/api:envelopes/envelopes/${out.id}`, undefined, jordan);
ok(after.events.some((e) => e.kind === "recipient.hosted"), "the trail records the host");
const made = await api("POST", "/api:templates/templates", { envelope_id: out.id, title: `Lease template ${run}` }, jordan);
const tpls = await api("GET", "/api:templates/templates", undefined, jordan);
const t = tpls.items.find((x) => x.id === made.template_id);
ok(!!t, "the saved template is listed");
ok(t.roles.length === 3 && t.roles.every((r) => r.role_name && !r.email), `roles have names and no people: ${t.roles.map((r) => r.role_name).join(", ")}`);
ok(t.field_count === 6, `fields copied: ${t.field_count}`);
const docs = await api("GET", "/api:envelopes/envelopes?segment=all", undefined, jordan);
ok(!docs.items.some((e) => e.id === t.id), "templates stay out of Documents");
const fill = t.roles.map((r, i) => ({ role_id: r.id, name: `Person ${i + 1}`, email: `p${i + 1}-${run}@example.com` }));
const used = await api("POST", `/api:templates/templates/${t.id}/use`, { people: fill, send: true, app_url: APP }, jordan);
ok(used.envelope_id > 0 && used.sent?.ok, `used and sent: envelope ${used.envelope_id}, ${used.sent?.links?.length ?? 0} links to share`);
const det = await api("GET", `/api:envelopes/envelopes/${used.envelope_id}`, undefined, jordan);
ok(det.envelope.status === "in_progress", `copy is out: ${det.envelope.status}`);
ok(det.recipients.map((r) => r.name).join(",") === "Person 1,Person 2,Person 3", `people in their roles: ${det.recipients.map((r) => `${r.role_name}=${r.name}`).join(", ")}`);
const draftOnly = await api("POST", `/api:templates/templates/${t.id}/use`, { people: [], send: false, app_url: APP }, jordan);
const prep = await api("GET", `/api:envelopes/envelopes/${draftOnly.envelope_id}/prepare`, undefined, jordan);
ok(prep.envelope.status === "draft" && prep.problems.length > 0, `"check it first" makes a draft that asks for people: ${prep.problems.map((p) => p.code).join(",")}`);
const rows = [1, 2, 3].map((n) => ({ line: n + 1, people: fill.map((p) => ({ ...p, email: n === 2 && p === fill[0] ? "broken" : p.email.replace("@", `+b${n}@`) })) }));
const bulk = await api("POST", `/api:templates/templates/${t.id}/bulk`, { rows, app_url: APP }, jordan);
ok(bulk.failed === 1, `one bad row caught: ${bulk.failed}`);
let d; for (let i = 0; i < 20; i++) { d = await api("GET", `/api:templates/bulk/${bulk.bulk_send_id}`, undefined, jordan); if (d.bulk.status !== "running") break; await new Promise((r) => setTimeout(r, 1000)); }
ok(d.bulk.status === "done" && d.bulk.sent === 2, `bulk done: ${d.bulk.status}, ${d.bulk.sent} sent, ${d.bulk.failed} failed: ${d.failed_rows.map((r) => `line ${r.line}: ${r.error}`).join("; ")}`);
const pp = await api("GET", `/api:templates/templates/${t.id}/public_problems`, undefined, jordan);
console.log("public link blockers:", pp);
let refused = ""; try { await api("POST", `/api:templates/templates/${t.id}/public_link`, { enabled: true, app_url: APP }, jordan); } catch (e) { refused = e.message; }
ok(/connect email|isn't ready/.test(refused), `a public link waits for email (or for the template to be ready): ${refused.slice(0, 120)}`);
const brief = await api("GET", "/api:public/public/nope");
ok(brief.state === "not_found", `unknown public link: ${brief.state}`);
finish();
