// The demo world: Fernhill Property Group, a property manager, mid-week. Documents in every state, real PDFs (made by
// frontend/scripts/make-seed-files.mjs), signatures drawn in the app's handwriting fonts, and an audit history for each.
//
// Rows are seeded by position (`sender_id: 2` is Jordan, the second of DEMO_PEOPLE). Trails can't be seeded as rows, because each
// event's hash must be the engine's own: so the first sweep after deploy writes them through audit/append with these backdated
// times (function/demo/world.ts), queues the link-only invites, and finishes the two signed documents through the real seal.
// Every row is `is_demo`, so nothing is ever emailed, and Settings → Data → "Clear demo data" removes it all.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "seed-files");
const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (hours: number) => Math.round(NOW - hours * HOUR);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const PRIYA = 1, JORDAN = 2, SAM = 3, TAYLOR = 4;
const MEMBER = { [PRIYA]: { name: "Priya Shah", email: "priya@fernhill.example" }, [JORDAN]: { name: "Jordan Lee", email: "jordan@fernhill.example" }, [SAM]: { name: "Sam Okafor", email: "sam@fernhill.example" }, [TAYLOR]: { name: "Taylor Brooks", email: "taylor@fernhill.example" } } as const;

type Box = { page: number; x: number; y: number; w: number; h: number };
type Layout = Record<"lease" | "offer" | "nda" | "services", { pages: { w: number; h: number; rotation: number }[]; boxes: Record<string, Box> }>;
const LAYOUT = JSON.parse(readFileSync(join(HERE, "layout.json"), "utf8")) as Layout;
const MARKS = JSON.parse(readFileSync(join(HERE, "signatures.json"), "utf8")) as Record<string, string>;

// ── Files ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const FILE_NAMES = ["lease", "offer", "nda", "services"] as const;
type Doc = (typeof FILE_NAMES)[number];
const BYTES = Object.fromEntries(FILE_NAMES.map((n) => [n, readFileSync(join(HERE, `${n}.pdf`))])) as Record<Doc, Buffer>;
const FILE_ID: Record<Doc, number> = { lease: 1, offer: 2, nda: 3, services: 4 };
const FILE_TITLE: Record<Doc, string> = { lease: "Residential lease.pdf", offer: "Offer letter.pdf", nda: "Mutual NDA.pdf", services: "Services agreement.pdf" };

export const SEED_FILES = FILE_NAMES.map((n) => ({
  name: FILE_TITLE[n], size: BYTES[n].length, sha256: sha(BYTES[n]), mode: "table" as const, attachment: null, uploaded_by: n === "offer" ? SAM : n === "lease" ? JORDAN : PRIYA,
  client_id: `demo-${n}`, is_demo: true, created_at: ago(24 * 20),
}));
export const SEED_BLOBS = FILE_NAMES.map((n) => ({ file_id: FILE_ID[n], b64: BYTES[n].toString("base64") }));

// ── Envelopes, people, fields ──────────────────────────────────────────────────────────────────────────────────────────────

type Person = {
  name: string; email: string; role: "signer" | "approver" | "viewer" | "cc"; role_name?: string; step: number; user?: number;
  /** Where they've got to, and when (hours ago). */
  status: "waiting" | "sent" | "opened" | "completed" | "declined"; sent?: number; opened?: number; done?: number; reason?: string;
  /** Their fields: layout box keys, by kind. `sig.a` is a signature, `init.a` initials, `date.a` the date signed. */
  fields?: string[];
};
type Env = {
  title: string; doc: Doc; sender: number; status: "draft" | "in_progress" | "sealing" | "declined" | "voided" | "expired";
  order: "parallel" | "ordered"; message: string; created: number; sent?: number; ended?: number; endReason?: string; expiresIn?: number;
  people: Person[]; template?: boolean; reminded?: number;
};

const ENVELOPES: Env[] = [
  { title: "Residential lease — 14 Alder St, Unit 3", doc: "lease", sender: JORDAN, status: "in_progress", order: "ordered", created: 30, sent: 26, expiresIn: 13,
    message: "Hi Maya, here's the lease for Unit 3 as we discussed. Initial page 1, sign on page 2, and I'll countersign straight after. Call me with any questions.",
    people: [
      { name: "Maya Chen", email: "maya.chen@example.com", role: "signer", role_name: "Tenant", step: 1, status: "opened", sent: 26, opened: 3, fields: ["init.a", "sig.a", "date.a"] },
      { name: "Jordan Lee", email: MEMBER[JORDAN].email, user: JORDAN, role: "signer", role_name: "Landlord's agent", step: 2, status: "waiting", fields: ["sig.b", "date.b"] },
    ] },
  { title: "Offer letter — Alex Rivera, Leasing Coordinator", doc: "offer", sender: SAM, status: "in_progress", order: "parallel", created: 54, sent: 50, expiresIn: 5, reminded: 2,
    message: "Alex, it was great meeting you. Here's your offer: sign when you're ready, and reply to this email with any questions.",
    people: [
      { name: "Alex Rivera", email: "alex.rivera@example.com", role: "signer", role_name: "Candidate", step: 1, status: "sent", sent: 50, fields: ["sig.a", "date.a"] },
      { name: "Jordan Lee", email: MEMBER[JORDAN].email, user: JORDAN, role: "cc", role_name: "Hiring manager", step: 1, status: "waiting" },
    ] },
  { title: "Mutual NDA — Harbor Analytics", doc: "nda", sender: PRIYA, status: "sealing", order: "ordered", created: 80, sent: 78,
    message: "Dana, here's our standard mutual NDA ahead of Thursday's call.",
    people: [
      { name: "Dana Okoye", email: "dana@harbor-analytics.example", role: "signer", role_name: "Harbor Analytics", step: 1, status: "completed", sent: 78, opened: 74, done: 73, fields: ["sig.a", "date.a"] },
      { name: "Priya Shah", email: MEMBER[PRIYA].email, user: PRIYA, role: "signer", role_name: "Fernhill", step: 2, status: "completed", sent: 73, opened: 2, done: 1.5, fields: ["sig.b", "date.b"] },
    ] },
  { title: "Services agreement — Brightline Cleaning", doc: "services", sender: PRIYA, status: "sealing", order: "ordered", created: 170, sent: 168,
    message: "Luis, here's the cleaning contract for the Alder and Harbor buildings. Initial page 1 and sign on page 2.",
    people: [
      { name: "Luis Ortega", email: "luis@brightline.example", role: "signer", role_name: "Contractor", step: 1, status: "completed", sent: 168, opened: 150, done: 149, fields: ["init.a", "sig.a", "date.a"] },
      { name: "Priya Shah", email: MEMBER[PRIYA].email, user: PRIYA, role: "signer", role_name: "Operations", step: 2, status: "completed", sent: 149, opened: 1, done: 0.8, fields: ["sig.b", "date.b"] },
      { name: "Taylor Brooks", email: MEMBER[TAYLOR].email, user: TAYLOR, role: "cc", role_name: "Finance", step: 2, status: "waiting" },
    ] },
  { title: "Lease renewal — 220 Harbor Rd, Apt 12", doc: "lease", sender: JORDAN, status: "declined", order: "parallel", created: 74, sent: 72, ended: 46, endReason: "The rent increase is more than we discussed. Can we talk before I sign?",
    message: "Kim, here's the renewal for another twelve months from December.",
    people: [{ name: "Kim Park", email: "kim.park@example.com", role: "signer", role_name: "Tenant", step: 1, status: "declined", sent: 72, opened: 47, reason: "The rent increase is more than we discussed. Can we talk before I sign?", fields: ["init.a", "sig.a", "date.a"] }] },
  { title: "Lease — 9 Birch Lane, Unit 1", doc: "lease", sender: JORDAN, status: "voided", order: "parallel", created: 120, sent: 118, ended: 96, endReason: "The owner has taken the unit off the market.",
    message: "Sam, the Birch Lane lease is ready for you.",
    people: [{ name: "Sam Ito", email: "sam.ito@example.com", role: "signer", role_name: "Tenant", step: 1, status: "opened", sent: 118, opened: 110, fields: ["init.a", "sig.a", "date.a"] }] },
  { title: "Lease — 31 Quarry Road, Unit 5", doc: "lease", sender: JORDAN, status: "expired", order: "parallel", created: 24 * 33, sent: 24 * 32, ended: 20,
    message: "Omar, here's the lease for Quarry Road.",
    people: [{ name: "Omar Haddad", email: "omar.haddad@example.com", role: "signer", role_name: "Tenant", step: 1, status: "sent", sent: 24 * 32, fields: ["init.a", "sig.a", "date.a"] }] },
  { title: "Services agreement — Northside Plumbing", doc: "services", sender: PRIYA, status: "in_progress", order: "ordered", created: 30, sent: 28, expiresIn: 20,
    message: "Ben has signed the plumbing contract. Jordan, it's yours to countersign for the leasing side.",
    people: [
      { name: "Ben Walsh", email: "ben@northside-plumbing.example", role: "signer", role_name: "Contractor", step: 1, status: "completed", sent: 28, opened: 26, done: 25, fields: ["init.a", "sig.a", "date.a"] },
      { name: "Jordan Lee", email: MEMBER[JORDAN].email, user: JORDAN, role: "signer", role_name: "Fernhill", step: 2, status: "sent", sent: 25, fields: ["sig.b", "date.b"] },
    ] },
  { title: "Residential lease — 5 Fern Court, Unit 2", doc: "lease", sender: JORDAN, status: "draft", order: "ordered", created: 2,
    message: "",
    people: [{ name: "Ana Ruiz", email: "ana.ruiz@example.com", role: "signer", role_name: "Tenant", step: 1, status: "waiting", fields: ["init.a", "sig.a"] }] },
  { title: "Residential lease", doc: "lease", sender: JORDAN, status: "draft", order: "ordered", created: 24 * 14, template: true,
    message: "Hi, here's your lease. Initial page 1, sign on page 2, and I'll countersign straight after.",
    people: [
      { name: "", email: "", role: "signer", role_name: "Tenant", step: 1, status: "waiting", fields: ["init.a", "sig.a", "date.a"] },
      { name: "Jordan Lee", email: MEMBER[JORDAN].email, user: JORDAN, role: "signer", role_name: "Landlord's agent", step: 2, status: "waiting", fields: ["sig.b", "date.b"] },
    ] },
];

/** The demo signer: Maya, on the Alder St lease. "See what a signer sees" opens her signing page. */
export const DEMO_SIGNER_RECIPIENT = 1;

const publicId = (i: number) => {
  const h = sha(`countersign-demo-${i}`).toUpperCase();
  return `CS-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
};
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const dateText = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export const SEED_ENVELOPES = ENVELOPES.map((e, i) => {
  const lastDone = Math.min(...e.people.filter((p) => p.done !== undefined).map((p) => p.done as number));
  return {
    public_id: publicId(i + 1), title: e.title, status: e.status, sender_id: e.sender, visibility: "team" as const, signing_order: e.order, subject: "", message: e.message,
    expires_at: e.expiresIn ? NOW + e.expiresIn * DAY : e.status === "expired" ? ago(e.ended ?? 0) : null, expiry_days: e.expiresIn ? Math.ceil(e.expiresIn + (e.sent ?? 0) / 24) : 30,
    reminder_days: 3, original_file_id: FILE_ID[e.doc], original_sha256: sha(BYTES[e.doc]), page_count: LAYOUT[e.doc].pages.length, pages: LAYOUT[e.doc].pages, sources: [],
    final_file_id: 0, final_sha256: "", chain_head: "", seal_attempts: 0, seal_failed: false, seal_error: "",
    // Held back until demo/build_world has written the trail the certificate prints.
    seal_next_at: e.status === "sealing" ? NOW + 365 * DAY : null, seal_key_hash: null,
    sent_at: e.sent !== undefined ? ago(e.sent) : null, completed_at: null, ended_at: e.ended !== undefined ? ago(e.ended) : e.status === "sealing" ? ago(lastDone) : null,
    end_reason: e.endReason ?? "", last_reminder_at: e.reminded !== undefined ? ago(e.reminded) : null, is_template: !!e.template, template_id: 0, bulk_send_id: 0,
    origin_key: "", is_demo: true, created_at: ago(e.created), updated_at: ago(Math.min(e.created, e.sent ?? e.created, ...e.people.map((p) => p.done ?? p.opened ?? p.sent ?? e.created))),
  };
});

const RECIPIENTS: { env: number; p: Person; color: number }[] = ENVELOPES.flatMap((e, i) => e.people.map((p, k) => ({ env: i + 1, p, color: k + 1 })));
export const SEED_RECIPIENTS = RECIPIENTS.map(({ env, p, color }) => {
  const consented = p.opened !== undefined ? ago(p.opened - 0.02) : null;
  return {
    envelope_id: env, role: p.role, role_name: p.role_name ?? "", name: p.name, email: p.email, step: p.step, color, status: p.status, round: 1,
    identity_check: "none" as const, access_code_hash: null, user_id: p.user ?? 0, consented_at: p.status === "completed" || p.status === "declined" || p.status === "opened" ? consented : null,
    disclosure_version: consented ? 1 : 0, identity_checked_at: null, identity_round: 0, opened_at: p.opened !== undefined ? ago(p.opened) : null,
    completed_at: p.done !== undefined ? ago(p.done) : null, declined_at: p.status === "declined" ? ago(ENVELOPES[env - 1].ended ?? 0) : null, decline_reason: p.reason ?? "",
    ip: p.opened !== undefined ? `203.0.113.${20 + color * 7 + env}` : "", user_agent: p.opened !== undefined ? (color % 2 ? PHONE : BROWSER) : "",
    hosted_by: null, bounced: false, last_reminded_at: ENVELOPES[env - 1].reminded !== undefined && p.role !== "cc" ? ago(ENVELOPES[env - 1].reminded ?? 0) : null,
    reminders_sent: ENVELOPES[env - 1].reminded !== undefined && p.role !== "cc" ? 1 : 0, download_hash: null, is_demo: true,
  };
});

const KIND_OF: Record<string, "signature" | "initials" | "date"> = { sig: "signature", init: "initials", date: "date" };
export const SEED_FIELDS = RECIPIENTS.flatMap(({ env, p }, r) => (p.fields ?? []).map((key) => {
  const e = ENVELOPES[env - 1];
  const b = LAYOUT[e.doc].boxes[key];
  if (!b) throw new Error(`world.ts: ${e.doc} has no box ${key}`);
  const type = KIND_OF[key.split(".")[0]];
  const filled = p.status === "completed" && p.done !== undefined;
  return {
    envelope_id: env, recipient_id: r + 1, type, page: b.page, x: b.x, y: b.y, w: b.w, h: b.h, required: true, label: "", options: [], validation: {},
    value: filled ? (type === "date" ? dateText(ago(p.done as number)) : "adopted") : null, filled_at: filled ? ago((p.done as number) + 0.01) : null,
  };
}));

/** Each finished signer's adopted signature (and initials when they had initials to fill). */
export const SEED_SIGNATURES = RECIPIENTS.flatMap(({ p }, r) => {
  if (p.status !== "completed" || !p.fields) return [];
  const kinds = (["signature", "initials"] as const).filter((k) => p.fields?.some((f) => KIND_OF[f.split(".")[0]] === k));
  return kinds.map((kind) => {
    const png = MARKS[`${p.name}:${kind}`];
    if (!png) throw new Error(`world.ts: no ${kind} drawn for ${p.name}; run make-seed-files.mjs --marks`);
    return { recipient_id: r + 1, kind, method: "typed" as const, png_b64: png, created_at: ago((p.opened ?? 1) - 0.01) };
  });
});

// ── The history the first sweep writes ─────────────────────────────────────────────────────────────────────────────────────

type Actor = { actor_type: string; actor_id: number; actor_name: string; actor_email: string; ip: string; user_agent: string };
const member = (id: number): Actor => ({ actor_type: "user", actor_id: id, actor_name: MEMBER[id as keyof typeof MEMBER].name, actor_email: MEMBER[id as keyof typeof MEMBER].email, ip: "198.51.100.4", user_agent: BROWSER });
const system: Actor = { actor_type: "system", actor_id: 0, actor_name: "", actor_email: "", ip: "", user_agent: "" };

/** One envelope's trail, oldest first: { envelope_id, kind, at, data, actor… }. Written in order by demo/build_world. */
export const WORLD_EVENTS = ENVELOPES.flatMap((e, i) => {
  if (e.template) return [];
  const env = i + 1;
  const out: ({ envelope_id: number; kind: string; at: number; data: Record<string, unknown> } & Actor)[] = [];
  const add = (kind: string, hours: number, actor: Actor, data: Record<string, unknown> = {}) => out.push({ envelope_id: env, kind, at: ago(hours), data, ...actor });
  const file = SEED_FILES[FILE_ID[e.doc] - 1];
  add("envelope.created", e.created, member(e.sender), { title: e.title, file_name: file.name, size: file.size, sha256: file.sha256, page_count: LAYOUT[e.doc].pages.length, storage: "table", sources_reported_by_client: [] });
  if (e.sent === undefined) return out;
  add("envelope.sent", e.sent, member(e.sender), { from: "draft", to: "in_progress" });
  const firstId = RECIPIENTS.findIndex((x) => x.env === env) + 1;
  e.people.forEach((p, k) => {
    const rid = firstId + k;
    const person: Actor = { actor_type: "recipient", actor_id: rid, actor_name: p.name, actor_email: p.email, ip: SEED_RECIPIENTS[rid - 1].ip, user_agent: SEED_RECIPIENTS[rid - 1].user_agent };
    const base = { recipient_id: rid, recipient_email: p.email, role: p.role };
    if (p.role === "cc") return;
    if (p.sent !== undefined) add("recipient.invited", p.sent, member(e.sender), { ...base, from: "waiting", to: "sent" });
    if (p.opened !== undefined) {
      add("recipient.opened", p.opened, person, { ...base, from: "sent", to: "opened" });
      add("recipient.consented", p.opened - 0.02, person, { ...base, disclosure_version: 1 });
    }
    if (p.status === "completed" && p.done !== undefined) {
      if (p.fields?.some((f) => f.startsWith("init"))) add("recipient.adopted_initials", p.done + 0.03, person, { ...base, method: "typed" });
      add("recipient.adopted_signature", p.done + 0.02, person, { ...base, method: "typed" });
      add("recipient.signed", p.done, person, { ...base, from: "opened", to: "completed", timezone: "America/Los_Angeles" });
    }
    if (p.status === "declined") add("recipient.declined", e.ended ?? 0, person, { ...base, from: "opened", to: "declined", reason: p.reason ?? "" });
  });
  if (e.reminded !== undefined) {
    const p = e.people[0];
    add("recipient.reminded", e.reminded, system, { recipient_id: firstId, recipient_email: p.email, n: 1 });
  }
  if (e.status === "declined") add("envelope.declined", e.ended ?? 0, system, { reason: e.endReason ?? "" });
  if (e.status === "voided") add("envelope.voided", e.ended ?? 0, member(e.sender), { reason: e.endReason ?? "" });
  if (e.status === "expired") add("envelope.expired", e.ended ?? 0, system, {});
  if (e.status === "sealing") add("envelope.all_signed", Math.min(...e.people.filter((p) => p.done !== undefined).map((p) => p.done as number)) - 0.01, system, { from: "in_progress", to: "sealing" });
  return out.sort((a, b) => a.at - b.at);
});

/** Envelopes the first sweep sends to the seal, so their signed copies come from the same code as any other. */
export const WORLD_TO_SEAL = ENVELOPES.map((e, i) => (e.status === "sealing" ? i + 1 : 0)).filter(Boolean);
/** Recipients whose invitation is shown on their document's page (as link-only: demo documents never email). */
export const WORLD_INVITED = RECIPIENTS.map(({ p }, r) => (p.sent !== undefined && p.role !== "cc" ? r + 1 : 0)).filter(Boolean);
/** The template's public link, made but off: turning it on needs email. */
export const SEED_PUBLIC_LINKS = ENVELOPES.flatMap((e, i) => (e.template ? [{ template_id: i + 1, slug: sha("countersign-demo-public").slice(0, 24), enabled: false, created_by: e.sender, uses: 0 }] : []));
