#!/usr/bin/env node
// A signer signs a whole document with the keyboard alone, on a phone-sized screen in dark mode: Tab to the consent box, Space,
// Enter; then Start, and each field in turn (Enter opens the signature dialog, Tab to "Adopt and sign"); focus moves to the next
// field after each one and to "Sign and finish" after the last. No console errors, no sideways scrolling.
//
//   node frontend/scripts/keyboard-sign-check.mjs --backend <url> --frontend <url>
//
// Needs Chrome (CHROME_PATH, or the usual places). Exit 0 = pass, 1 = a check failed, 2 = usage.
import { browser as launch, frontend as APP, makeEnvelope, must, needBackend, signIn, sleep } from "./check-lib.mjs";

needBackend("keyboard-sign-check.mjs");
const run = Date.now();
const jordan = await signIn("jordan");
const lease = (p) => [
  { recipient_id: p[0].id, type: "signature", page: 1, x: 0.118, y: 0.74, w: 0.34, h: 0.06, required: true },
  { recipient_id: p[0].id, type: "date", page: 1, x: 0.118, y: 0.835, w: 0.2, h: 0.028, required: true },
  { recipient_id: p[0].id, type: "initials", page: 1, x: 0.75, y: 0.3, w: 0.09, h: 0.04, required: true },
  { recipient_id: p[0].id, type: "checkbox", page: 1, x: 0.118, y: 0.47, w: 0.03, h: 0.023, required: false, label: "I have a pet" },
  { recipient_id: p[0].id, type: "text", page: 2, x: 0.118, y: 0.5, w: 0.35, h: 0.03, required: true, label: "Vehicle registration" },
];
const one = [{ name: "Maya Chen", email: `maya-k-${run}@example.com`, role: "signer", step: 1, identity_check: "none" }, { name: "Accounts", email: `accounts-k-${run}@example.com`, role: "cc", step: 1, identity_check: "none" }];
const env = await makeEnvelope(jordan, { title: `Keyboard lease ${run}`, people: one, fields: (p) => lease([p[0]]), run });
if (!env.sent?.links) { console.log(JSON.stringify(env.sent)); process.exit(1); }
const url = APP + new URL(env.sent.links[0].url).pathname;
const browser = await launch();
const errors = [];
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await page.goto(APP + "/sign-in");
await page.evaluate(() => { localStorage.removeItem("app.token"); localStorage.setItem("app.theme", "dark"); });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("Electronic records"), { timeout: 15000 }).catch(async (e) => {
  console.log("first screen never showed:", await page.evaluate(() => document.body.innerText.slice(0, 400)), errors); await browser.close(); process.exit(1);
});
const active = () => page.evaluate(() => { const a = document.activeElement; return { tag: a?.tagName, role: a?.getAttribute("role"), label: a?.getAttribute("aria-label") ?? a?.textContent?.trim().slice(0, 40), id: a?.id }; });
const tabTo = async (pred, max = 30) => { for (let i = 0; i < max; i++) { await page.keyboard.press("Tab"); const a = await active(); if (pred(a)) return a; } throw new Error("never reached by Tab: " + pred); };
const steps = [], lost = [];
// Consent: Tab to the checkbox, Space; Tab to the button, Enter.
await tabTo((a) => a.role === "checkbox" || (a.tag === "INPUT" && /agree/i.test(a.label ?? "")) || /agree/i.test(a.label ?? ""));
await page.keyboard.press("Space"); steps.push("consent ticked");
await tabTo((a) => /Review the document/.test(a.label ?? ""));
await page.keyboard.press("Enter"); steps.push("opened the document");
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^Start/.test(b.textContent ?? "")), { timeout: 20000 });
await sleep(1200);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
for (let round = 0; round < 12; round++) {
  const nextLabel = await page.evaluate(() => [...document.querySelectorAll("footer button")].find((b) => /^(Start|Next field)/.test(b.textContent ?? ""))?.textContent);
  if (!nextLabel) break;
  await page.evaluate(() => [...document.querySelectorAll("footer button")].find((b) => /^(Start|Next field)/.test(b.textContent ?? ""))?.focus());
  await page.keyboard.press("Enter"); await sleep(600);
  const a = await active();
  if (a.tag === "BUTTON" && /^(Signature|Initials)/.test(a.label ?? "")) {
    await page.keyboard.press("Enter"); await page.waitForSelector("[role=dialog]", { timeout: 5000 });
    await tabTo((x) => /Adopt and sign/.test(x.label ?? ""));
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"), { timeout: 10000 });
    steps.push(`adopted for ${a.label}`);
  } else if (a.tag === "INPUT") {
    await page.keyboard.type("KX-482"); await page.keyboard.press("Enter"); await sleep(800); steps.push(`typed in ${a.label}`);
  } else { throw new Error("Next field focused something unexpected: " + JSON.stringify(a)); }
  // Focus must return to the page after the dialog: report where it went.
  await sleep(700);
  const after = await active();
  if (!/^field-|^sign-finish$/.test(after.id ?? "")) lost.push(`after ${a.label}: focus on ${after.tag} ${JSON.stringify(after.label)}`);
  steps.push(`focus moved to ${after.id}`);
}
await sleep(500);
await page.evaluate(() => [...document.querySelectorAll("footer button")].find((b) => /Sign and finish/.test(b.textContent ?? ""))?.focus());
const finishDisabled = await page.evaluate(() => document.activeElement?.hasAttribute("disabled"));
await page.keyboard.press("Enter");
await page.waitForFunction(() => /You.?ve signed|signed|done|Finishing/i.test(document.querySelector("main, body")?.innerText ?? ""), { timeout: 15000 }).catch(() => undefined);
await sleep(1500);
const done = await must("GET", `/api:envelopes/envelopes/${env.id}`, undefined, jordan);
const me = (done.recipients ?? done.envelope?.recipients ?? []).find((r) => r.name === "Maya Chen");
console.log(JSON.stringify({ steps, lost, overflow, finishDisabled, maya: me?.status, envelope: done.envelope?.status ?? done.status, errors }, null, 1));
await browser.close();
const ok = me?.status === "completed" && !overflow && errors.length === 0 && lost.length === 0;
console.log(ok ? "SIGN CHECK PASSED" : "SIGN CHECK FAILED"); process.exit(ok ? 0 : 1);
