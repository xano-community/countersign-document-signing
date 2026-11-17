#!/usr/bin/env node
// F1 on a fresh demo deploy, with no email key: the demo's history is written and verifies, its two signed documents seal through
// the real seal, a sealed file matches its fingerprint and the verify page, the demo signer's page opens with no account, and
// Jordan's countersignature on the plumbing contract seals it.
//
//   node frontend/scripts/first-run-check.mjs --backend <url> [--frontend <url>]
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { createHash } from "node:crypto";
import { backend, call, finish, frontend, must, needBackend, ok, signIn, signThrough, sleep, tokenOf } from "./check-lib.mjs";

needBackend("first-run-check.mjs");

// --no-seed: a backend deployed without the demo. Nothing is seeded, nobody can sign in as a demo person, and the public pages answer.
if (process.argv.includes("--no-seed")) {
  const demo = await call("POST", "/api:authn/auth/demo", { persona: "jordan" });
  ok(demo.status >= 400, `no demo sign-in without the demo: ${demo.status}`);
  const brand = await call("GET", "/api:verify/brand");
  ok(brand.status === 200, `the public pages' branding answers: ${brand.status}`);
  const signer = await call("POST", "/api:sign/sign/demo");
  ok(signer.status === 200 && signer.body?.state !== "ok", `no demo signer: ${signer.body?.state}`);
  finish();
}
const jordan = await signIn("jordan"), priya = await signIn("priya");
await must("POST", "/api:envelopes/app/hello", { app_url: frontend }, jordan);

const find = async (title) => (await must("GET", `/api:envelopes/envelopes?segment=all&q=${encodeURIComponent(title)}`, undefined, priya)).items.find((e) => e.title === title);
const nda = await find("Mutual NDA — Harbor Analytics");
ok(!!nda, "the demo is seeded");
if (!nda) finish();
let detail;
for (let i = 0; i < 60; i++) { detail = await must("GET", `/api:envelopes/envelopes/${nda.id}`, undefined, priya); if (detail.envelope.status === "completed") break; await sleep(2000); }
ok(detail.envelope.status === "completed", `the demo's signed NDA seals within two minutes: ${detail.envelope.status}`);

const all = (await must("GET", "/api:envelopes/envelopes?segment=all", undefined, priya)).items;
let intact = 0;
for (const e of all) { const d = await must("GET", `/api:envelopes/envelopes/${e.id}`, undefined, priya); if (d.integrity.ok && d.events.length > 0) intact++; else if (e.status !== "draft") console.log(`  trail of "${e.title}": ${d.integrity.ok ? "empty" : `broken at ${d.integrity.broken_at}`}`); }
ok(intact >= all.filter((e) => e.status !== "draft").length, `every sent document's trail is written and intact (${intact} of ${all.length})`);

const link = await must("GET", `/api:documents/envelopes/${nda.id}/final`, undefined, priya);
const res = link.how === "signed" ? await fetch(link.url) : await fetch(`${backend}/api:documents/envelopes/${nda.id}/final/raw`, { headers: { authorization: `Bearer ${priya}` } });
const bytes = new Uint8Array(await res.arrayBuffer());
const sha = createHash("sha256").update(bytes).digest("hex");
ok(sha === detail.envelope.final_sha256, "the sealed file's bytes match its stored fingerprint");
const verdict = await must("POST", "/api:verify/verify", { sha256: sha, public_id: detail.envelope.public_id });
ok(verdict.state === "match" && verdict.signers?.length === 2, `the verify page matches it and names both signers: ${verdict.state}`);

const demo = await must("POST", "/api:sign/sign/demo");
const opened = demo.path ? await must("POST", "/api:sign/sign/open", { token: tokenOf(demo.path) }) : null;
ok(demo.state === "ok" && opened?.state === "active", `"See what a signer sees" opens Maya's lease with no account: ${opened?.state}`);

const plumbing = await find("Services agreement — Northside Plumbing");
// Run once on a fresh demo, Jordan signs it here; run again, it's already signed and sealed from the first time.
if (plumbing.status === "in_progress") {
  const mine = await must("POST", `/api:envelopes/envelopes/${plumbing.id}/sign`, { app_url: frontend }, jordan);
  const done = await signThrough(tokenOf(mine.url));
  ok(done.ok && done.finishing, "Jordan countersigns the plumbing contract, the last signature it needed");
} else console.log(`note  the plumbing contract was countersigned on an earlier run (${plumbing.status})`);
let after;
for (let i = 0; i < 30; i++) { after = await must("GET", `/api:envelopes/envelopes/${plumbing.id}`, undefined, jordan); if (after.envelope.status === "completed") break; await sleep(1000); }
ok(after.envelope.status === "completed", `and it seals: ${after.envelope.status}`);
ok((await call("GET", "/api:envelopes/envelopes/stats")).status === 401, "the dashboard needs a sign-in");
finish();
