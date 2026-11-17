// What an admin sets for the whole organisation: its name and logo (on signing pages, emails and certificates), how email reads,
// the defaults new documents start with, the consent disclosure signers agree to, how long ended documents are kept, and the
// demo data. Also removing someone from the team, and an export of every document's record.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { field } from "../../table/envelope/field.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { purged_envelope } from "../../table/envelope/purged_envelope.js";
import { public_link } from "../../table/envelope/public_link.js";
import { disclosure } from "../../table/signing/disclosure.js";
import { signature } from "../../table/signing/signature.js";
import { signing_link } from "../../table/signing/signing_link.js";
import { audit_event } from "../../table/signing/audit_event.js";
import { email_outbox } from "../../table/email/email_outbox.js";
import { api_key } from "../../table/developer/api_key.js";
import { discardDocument } from "../documents/documents.js";
import { loadActor } from "../envelope/draft.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGO = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MOST_LOGO_CHARS = 280_000;
/** Ended documents erased per run of the daily purge; the rest wait for the next day. */
const PURGE_BATCH = 50;
const admin = [...loadActor(), rbac.allows(ref("actor.role"), "settings.manage", "Only admins can change the organisation's settings.")];

/** The settings row, made on first use so a fresh install always has one. Binds `org`. */
const orgRow = [
  s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], returnType: "single", as: "org_found" }),
  s.set_var("org", ref("org_found")),
  s.conditional({ when: expr(ref("org_found"), "=", c.null()), then: [
    s.db.add({ table: org_setting, row: { org_name: c.text("Countersign"), default_expiry_days: c.int(30), default_reminder_days: c.int(3), retention_days: c.int(0), demo_mode: c.bool(false) }, as: "org_made" }),
    s.update_var("org", ref("org_made")),
  ] }),
];

export const readOrgFn = defineFunction({
  name: "settings/read",
  description: "The organisation's settings and the current disclosure, for the Settings screen.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...admin,
    ...orgRow,
    s.db.query({ table: disclosure, sort: [{ sortBy: "version", dir: "desc" }], returnType: "single", output: ["version", "text", "created_at"], as: "current" }),
    s.db.query({ table: envelope, where: cmp(col("is_demo"), "=", c.bool(true)), returnType: "count", as: "demo_docs" }),
    // Which certificate (if any) signs sealed PDFs, read by the seal's own lambda. Called by name: the seal imports settings' tables.
    s.set_var("signing", obj({ ok: c.bool(false) })),
    s.try_catch({ try: [s.function.run({ fn: "seal/signing_info", as: "signing_read" }), s.update_var("signing", ref("signing_read"))], catch: [] }),
  ],
  response: obj({
    org: withFilters(ref("org"), fl.unset("app_url"), fl.unset("api_base_url")), app_url: ref("org.app_url", { safe: true }),
    disclosure: ref("current"), demo_documents: ref("demo_docs"), signing: ref("signing"),
  }),
});

export const updateOrgFn = defineFunction({
  name: "settings/update",
  description: "Change the organisation's branding, email details, defaults, retention or demo mode.",
  input: {
    actor_id: input.int({ required: true }), org_name: input.text({ methods: ["trim"] }), logo_data_url: input.text(), accent: input.text(),
    email_sender_name: input.text({ methods: ["trim"] }), reply_to: input.text({ methods: ["trim", "lower"] }),
    default_expiry_days: input.int(), default_reminder_days: input.int(), retention_days: input.int(), demo_mode: input.bool(),
  },
  stack: [
    ...admin,
    ...orgRow,
    s.set_var("name", withFilters(inp("org_name"), fl.first_notnull(c.text("")))),
    guard.require(and(expr(withFilters(ref("name"), fl.strlen()), ">=", c.int(1)), expr(withFilters(ref("name"), fl.strlen()), "<=", c.int(80))), { errorType: "badrequest", message: "Give the organisation a name, up to 80 characters." }),
    s.set_var("logo", withFilters(inp("logo_data_url"), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("logo"), "!=", c.text("")), then: [
      guard.require(expr(withFilters(c.regex(LOGO), fl.regex_test(ref("logo"))), "=", c.bool(true)), { errorType: "badrequest", message: "Use a PNG or JPEG logo." }),
      guard.require(expr(withFilters(ref("logo"), fl.strlen()), "<=", c.int(MOST_LOGO_CHARS)), { errorType: "badrequest", message: "That logo is too large. Use one under 200 KB." }),
    ] }),
    s.set_var("reply", withFilters(inp("reply_to"), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("reply"), "!=", c.text("")), then: [
      guard.require(expr(withFilters(c.regex(EMAIL), fl.regex_test(ref("reply"))), "=", c.bool(true)), { errorType: "badrequest", message: "Check the reply-to address." }),
    ] }),
    guard.require(and(expr(inp("default_expiry_days"), ">=", c.int(1)), expr(inp("default_expiry_days"), "<=", c.int(365))), { errorType: "badrequest", message: "Set a deadline between 1 and 365 days." }),
    guard.require(and(expr(inp("default_reminder_days"), ">=", c.int(0)), expr(inp("default_reminder_days"), "<=", c.int(30))), { errorType: "badrequest", message: "Remind every 1 to 30 days, or never." }),
    s.set_var("keep", withFilters(inp("retention_days"), fl.first_notempty(c.int(0)))),
    guard.require(expr(c.expression("$var.keep == 0 || ($var.keep >= 30 && $var.keep <= 3650)"), "=", c.bool(true)), { errorType: "badrequest", message: "Keep documents for 30 days to 10 years, or forever." }),
    s.db.patch({ table: org_setting, fieldValue: ref("org.id"), data: obj({
      org_name: ref("name"), logo_data_url: ref("logo"), accent: withFilters(inp("accent"), fl.first_notempty(c.text("ink")), fl.substr(c.int(0), c.int(20))),
      email_sender_name: withFilters(inp("email_sender_name"), fl.first_notnull(c.text("")), fl.substr(c.int(0), c.int(80))), reply_to: ref("reply"),
      default_expiry_days: inp("default_expiry_days"), default_reminder_days: inp("default_reminder_days"), retention_days: ref("keep"),
      demo_mode: withFilters(inp("demo_mode"), fl.first_notnull(c.bool(false))),
    }), as: "saved" }),
    changed({ entity: "org_setting", id: ref("org.id"), actor: inp("actor_id"), title: c.text("changed the organisation's settings") }),
  ],
  response: withFilters(ref("saved"), fl.unset("app_url"), fl.unset("api_base_url")),
});

/** A new version of the disclosure. Signers who agreed to an earlier one keep that version on their record and certificate. */
export const saveDisclosureFn = defineFunction({
  name: "settings/disclosure",
  description: "Save a new version of the electronic records and signatures disclosure.",
  input: { actor_id: input.int({ required: true }), text: input.text({ methods: ["trim"] }) },
  stack: [
    ...admin,
    s.set_var("body", withFilters(inp("text"), fl.first_notnull(c.text("")))),
    guard.require(and(expr(withFilters(ref("body"), fl.strlen()), ">=", c.int(80)), expr(withFilters(ref("body"), fl.strlen()), "<=", c.int(10_000))), { errorType: "badrequest", message: "The disclosure needs 80 to 10,000 characters." }),
    s.db.query({ table: disclosure, sort: [{ sortBy: "version", dir: "desc" }], returnType: "single", output: ["version", "text"], as: "last" }),
    s.set_var("same", c.bool(false)),
    s.conditional({ when: expr(ref("last.text", { safe: true }), "=", ref("body")), then: [s.update_var("same", c.bool(true))] }),
    guard.require(expr(ref("same"), "=", c.bool(false)), { errorType: "badrequest", message: "That's the same as the current version." }),
    s.set_var("next", withFilters(ref("last.version", { safe: true }), fl.first_notempty(c.int(0)), fl.add(c.int(1)))),
    s.db.add({ table: disclosure, row: { version: ref("next"), text: ref("body"), created_by: ref("actor.id") }, as: "made" }),
    changed({ entity: "disclosure", id: ref("made.id"), op: "created", actor: inp("actor_id"), title: withFilters(c.text("published disclosure version "), fl.concat(ref("next"))) }),
  ],
  response: obj({ version: ref("next") }),
});

/**
 * Erase one envelope and everything that hangs off it: people, fields, signatures, links, trail, mail, and its files (the
 * original only when no other envelope or template shares it). A completed one leaves a tombstone for the verify page.
 */
export const eraseEnvelopeFn = defineFunction({
  name: "envelope/erase",
  description: "Delete an envelope and all its data, leaving a verify tombstone if it had completed.",
  input: { envelope_id: input.int({ required: true }), tombstone: input.bool() },
  stack: [
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "public_id", "status", "final_sha256", "completed_at", "original_file_id", "final_file_id"], as: "gone" }),
    guard.found("gone", { errorType: "notfound", message: "That document doesn't exist." }),
    s.conditional({ when: and(expr(inp("tombstone"), "=", c.bool(true)), expr(ref("gone.status"), "=", c.text("completed"))), then: [
      s.try_catch({ try: [s.db.add({ table: purged_envelope, row: { public_id: ref("gone.public_id"), final_sha256: ref("gone.final_sha256"), completed_at: ref("gone.completed_at") }, as: "stone" })], catch: [] }),
    ] }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("gone.id")), output: ["id"], as: "people" }),
    s.foreach({ list: ref("people"), as: "p", body: [
      s.db.bulk.delete({ table: signature, where: cmp(col("recipient_id"), "=", ref("p.id")), as: "marks_gone" }),
      s.db.bulk.delete({ table: signing_link, where: cmp(col("recipient_id"), "=", ref("p.id")), as: "links_gone" }),
    ] }),
    s.db.bulk.delete({ table: field, where: cmp(col("envelope_id"), "=", ref("gone.id")), as: "fields_gone" }),
    s.db.bulk.delete({ table: recipient, where: cmp(col("envelope_id"), "=", ref("gone.id")), as: "people_gone" }),
    s.db.bulk.delete({ table: audit_event, where: cmp(col("envelope_id"), "=", ref("gone.id")), as: "trail_gone" }),
    s.db.bulk.delete({ table: email_outbox, where: cmp(col("envelope_id"), "=", ref("gone.id")), as: "mail_gone" }),
    s.db.bulk.delete({ table: public_link, where: cmp(col("template_id"), "=", ref("gone.id")), as: "link_gone" }),
    s.db.del({ table: envelope, fieldValue: ref("gone.id") }),
    s.set_var("final_id", withFilters(ref("gone.final_file_id"), fl.first_notempty(c.int(0)))),
    s.conditional({ when: expr(ref("final_id"), ">", c.int(0)), then: [s.function.run({ fn: discardDocument, as: "final_gone", input: { file_id: ref("final_id") } })] }),
    s.set_var("original_id", withFilters(ref("gone.original_file_id"), fl.first_notempty(c.int(0)))),
    s.conditional({ when: expr(ref("original_id"), ">", c.int(0)), then: [
      s.db.query({ table: envelope, where: cmp(col("original_file_id"), "=", ref("original_id")), returnType: "count", as: "sharing" }),
      s.conditional({ when: expr(ref("sharing"), "=", c.int(0)), then: [s.function.run({ fn: discardDocument, as: "original_gone", input: { file_id: ref("original_id") } })] }),
    ] }),
  ],
  response: obj({ ok: c.bool(true) }),
});

/** The daily purge: ended envelopes older than the retention period are erased, a batch at a time. Templates are never purged. */
export const purgeDueFn = defineFunction({
  name: "settings/purge_due",
  description: "Erase ended envelopes older than the retention period.",
  stack: [
    ...orgRow,
    s.set_var("keep_days", withFilters(ref("org.retention_days"), fl.first_notempty(c.int(0)))),
    s.conditional({ when: expr(ref("keep_days"), "<=", c.int(0)), then: [s.return(obj({ purged: c.int(0) }))] }),
    s.set_var("now_ms", c.now()),
    s.set_var("keep_ms", withFilters(ref("keep_days"), fl.mul(c.int(86_400_000)))),
    s.set_var("cutoff", withFilters(ref("now_ms"), fl.sub(ref("keep_ms")))),
    s.db.query({ table: envelope, where: [cmp(col("is_template"), "!=", c.bool(true)), cmp(col("status"), "=", c.text("completed")), cmp(col("completed_at"), "<", ref("cutoff"))], output: ["id"], paging: { per_page: c.int(PURGE_BATCH), metadata: false }, as: "done_old" }),
    s.db.query({ table: envelope, where: [cmp(col("is_template"), "!=", c.bool(true)), cmp(col("status"), "in", c.array(["declined", "voided", "expired"])), cmp(col("ended_at"), "<", ref("cutoff"))], output: ["id"], paging: { per_page: c.int(PURGE_BATCH), metadata: false }, as: "ended_old" }),
    s.set_var("purged", c.int(0)),
    ...(["done_old", "ended_old"] as const).map((list) => s.foreach({ list: ref(list), as: "old", body: [
      s.try_catch({ try: [
        s.function.run({ fn: eraseEnvelopeFn, as: "erased", input: { envelope_id: ref("old.id"), tombstone: c.bool(true) } }),
        s.update_var("purged", withFilters(ref("purged"), fl.add(c.int(1)))),
      ], catch: [] }),
    ] })),
  ],
  response: obj({ purged: ref("purged") }),
  responseShape: {} as { purged: number },
});

/** Remove every seeded demo document and template. Real ones are untouched. */
export const clearDemoFn = defineFunction({
  name: "settings/clear_demo",
  description: "Delete all demo documents and templates.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...admin,
    s.db.query({ table: envelope, where: cmp(col("is_demo"), "=", c.bool(true)), output: ["id"], as: "demo" }),
    s.foreach({ list: ref("demo"), as: "d", body: [s.function.run({ fn: eraseEnvelopeFn, as: "erased", input: { envelope_id: ref("d.id"), tombstone: c.bool(false) } })] }),
    changed({ entity: "envelope", id: c.int(0), op: "deleted", actor: inp("actor_id"), title: c.text("cleared the demo documents") }),
  ],
  response: obj({ removed: withFilters(ref("demo"), fl.count()) }),
});

/** Every document's record (not its files), for a spreadsheet: who sent it, who's on it and where it stands. */
export const exportRecordsFn = defineFunction({
  name: "settings/export",
  description: "Every document's record, with its people, for export.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...admin,
    s.db.query({ table: envelope, where: cmp(col("is_template"), "!=", c.bool(true)), sort: [{ sortBy: "id", dir: "asc" }],
      output: ["id", "public_id", "title", "status", "sender_id", "created_at", "sent_at", "completed_at", "ended_at", "end_reason", "final_sha256"], as: "docs" }),
    s.db.query({ table: user, output: ["id", "name", "email"], as: "people" }),
    s.db.query({ table: recipient, output: ["envelope_id", "name", "email", "role", "status", "completed_at"], as: "parties" }),
  ],
  response: obj({ documents: ref("docs"), members: ref("people"), recipients: ref("parties") }),
});

/**
 * Remove someone from the team: they can't sign in or use the API from that moment, and keep nothing but their history. Their
 * documents stay. Nobody removes themselves, and the last admin can't be removed.
 */
export const removeMemberFn = defineFunction({
  name: "members/remove",
  description: "Remove a person from the team. Their documents stay; their access, keys and sessions end.",
  input: { actor_id: input.int({ required: true }), user_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    rbac.allows(ref("actor.role"), "team.manage", "Only people who manage the team can remove someone."),
    guard.require(expr(inp("user_id"), "!=", ref("actor.id")), { errorType: "badrequest", message: "You can't remove yourself. Ask another admin." }),
    s.db.get({ table: user, fieldValue: inp("user_id"), output: ["id", "name", "role", "status"], as: "target" }),
    guard.found("target", { errorType: "notfound", message: "That person isn't on the team." }),
    guard.require(expr(ref("target.status"), "=", c.text("active")), { errorType: "badrequest", message: "They've already been removed." }),
    s.conditional({ when: rbac.has(ref("target.role"), "team.manage"), then: [
      s.db.query({ table: user, where: [cmp(col("status"), "=", c.text("active")), cmp(col("role"), "in", c.array(rbac.rolesWith("team.manage"))), cmp(col("id"), "!=", ref("target.id"))], returnType: "count", as: "others" }),
      guard.require(expr(ref("others"), ">", c.int(0)), { errorType: "badrequest", message: "They're the last admin. Make someone else an admin first." }),
    ] }),
    s.db.patch({ table: user, fieldValue: ref("target.id"), data: obj({ status: c.text("removed"), role: c.text("viewer") }), as: "removed" }),
    s.set_var("now_ms", c.now()),
    s.db.query({ table: api_key, where: [cmp(col("user_id"), "=", ref("target.id")), cmp(col("revoked_at"), "=", c.null())], output: ["id"], as: "their_keys" }),
    s.foreach({ list: ref("their_keys"), as: "tk", body: [s.db.patch({ table: api_key, fieldValue: ref("tk.id"), data: obj({ revoked_at: ref("now_ms") }), as: "key_off" })] }),
    changed({ entity: "user", id: ref("target.id"), actor: inp("actor_id"), title: withFilters(c.text("removed "), fl.concat(ref("target.name")), fl.concat(c.text(" from the team"))) }),
  ],
  response: obj({ ok: c.bool(true) }),
});

export const orgFunctions = [readOrgFn, updateOrgFn, saveDisclosureFn, eraseEnvelopeFn, purgeDueFn, clearDemoFn, exportRecordsFn, removeMemberFn];
