// Managing envelopes that are out: correcting a recipient, voiding, reminders on schedule, and expiry.
import { c, cmp, col, obj, ref, s } from "@xano/sdk";
import { correctFn, dueExpiriesFn, dueRemindersFn, voidFn } from "../function/envelope/manage.js";
import { envelope } from "../table/envelope/envelope.js";
import { recipient } from "../table/envelope/recipient.js";
import { signing_link } from "../table/signing/signing_link.js";
import { email_outbox } from "../table/email/email_outbox.js";
import { audit_event } from "../table/signing/audit_event.js";
import { workflowTest as plainWorkflowTest } from "@xano/sdk";
import { draft, person, signer, workflowTest } from "./fixtures.js";

const out = (as: string, sender: string, title: string, extra = {}) => draft(as, sender, title, { status: c.text("in_progress"), ...extra });

export const manageTests = [
  workflowTest({
    name: "manage: correcting a recipient revokes their links and re-invites them at the new round",
    description: "Old links stop working, the round goes up, a new invite is queued for the new address, and the trail names the sender.",
    stack: [
      person("sender"),
      out("env", "sender", "Correct me"),
      signer("ana", "env", "ana@old.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ status: c.text("opened") }), as: "opened" }),
      s.db.add({ table: signing_link, row: { recipient_id: ref("ana.id"), token_hash: c.text("old-link-hash"), round: c.int(1), via: c.text("email"), revoked: c.bool(false) }, as: "old" }),
      s.function.call({ fn: correctFn, as: "fixed", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id"), recipient_id: ref("ana.id"), name: c.text("Ana New"), email: c.text("ana@new.example") } }),
      s.db.get({ table: signing_link, fieldValue: ref("old.id"), as: "old_after" }),
      s.expect.to_be_true({ expr: ref("old_after.revoked") }),
      s.db.get({ table: recipient, fieldValue: ref("ana.id"), as: "ana_after" }),
      s.expect.to_equal({ expr: ref("ana_after.round"), value: c.int(2) }),
      s.expect.to_equal({ expr: ref("ana_after.status"), value: c.text("sent") }),
      s.expect.to_equal({ expr: ref("ana_after.email"), value: c.text("ana@new.example") }),
      s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("ana.id")), cmp(col("kind"), "=", c.text("invite"))], returnType: "single", as: "invite" }),
      s.expect.to_equal({ expr: ref("invite.to"), value: c.text("ana@new.example") }),
      s.db.query({ table: audit_event, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("kind"), "=", c.text("recipient.corrected"))], returnType: "single", as: "ev" }),
      s.expect.to_equal({ expr: ref("ev.actor_id"), value: ref("sender.id") }),
    ],
  }),
  workflowTest({
    name: "manage: voiding ends the envelope and tells whoever had heard; a completed one can't be voided",
    description: "Voiding needs a reason, revokes links and queues a voided email; voiding a completed envelope is refused.",
    stack: [
      person("sender"),
      out("env", "sender", "Void me"),
      signer("ana", "env", "ana@void.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ status: c.text("sent") }), as: "sent" }),
      s.function.call({ fn: voidFn, as: "voided", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id"), reason: c.text("Wrong rent amount") } }),
      s.db.get({ table: envelope, fieldValue: ref("env.id"), as: "after" }),
      s.expect.to_equal({ expr: ref("after.status"), value: c.text("voided") }),
      s.expect.to_equal({ expr: ref("after.end_reason"), value: c.text("Wrong rent amount") }),
      s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("ana.id")), cmp(col("kind"), "=", c.text("voided"))], returnType: "count", as: "told" }),
      s.expect.to_equal({ expr: ref("told"), value: c.int(1) }),
      draft("done", "sender", "Already done", { status: c.text("completed") }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: envelope, where: cmp(col("title"), "=", c.text("Already done")), returnType: "single", as: "e" }),
          s.function.call({ fn: voidFn, as: "nope", input: { actor_id: ref("e.sender_id"), envelope_id: ref("e.id"), reason: c.text("x") } }),
        ],
        exception: c.text("isn't out for signature"),
      }),
    ],
  }),
  plainWorkflowTest({
    name: "manage: a due reminder goes out once per interval, and never for demo envelopes",
    description: "Running the reminder step twice sends one reminder; a demo envelope gets none.",
    stack: [
      person("sender"),
      out("env", "sender", "Remind me", { reminder_days: c.int(3) }),
      s.db.patch({ table: envelope, fieldValue: ref("env.id"), data: obj({ sent_at: c.int(1) }), as: "backdated" }),
      signer("ana", "env", "ana@remind.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ status: c.text("sent") }), as: "sent" }),
      out("demo", "sender", "Demo remind", { reminder_days: c.int(3) }),
      s.db.patch({ table: envelope, fieldValue: ref("demo.id"), data: obj({ is_demo: c.bool(true), sent_at: c.int(1) }), as: "demo_marked" }),
      signer("dee", "demo", "dee@remind.example"),
      s.db.patch({ table: recipient, fieldValue: ref("dee.id"), data: obj({ status: c.text("sent") }), as: "dee_sent" }),
      s.function.call({ fn: dueRemindersFn, as: "first" }),
      s.function.call({ fn: dueRemindersFn, as: "second" }),
      s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("ana.id")), cmp(col("kind"), "=", c.text("reminder"))], returnType: "count", as: "reminders" }),
      s.expect.to_equal({ expr: ref("reminders"), value: c.int(1) }),
      s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("dee.id")), cmp(col("kind"), "=", c.text("reminder"))], returnType: "count", as: "demo_reminders" }),
      s.expect.to_equal({ expr: ref("demo_reminders"), value: c.int(0) }),
    ],
  }),
  workflowTest({
    name: "manage: an envelope past its deadline expires and its links stop working",
    description: "The expiry step moves it to expired, revokes the links of whoever had heard, and queues an expired email.",
    stack: [
      person("sender"),
      out("env", "sender", "Expire me"),
      s.db.patch({ table: envelope, fieldValue: ref("env.id"), data: obj({ expires_at: c.int(1000) }), as: "late" }),
      signer("ana", "env", "ana@expire.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ status: c.text("opened") }), as: "opened" }),
      s.db.add({ table: signing_link, row: { recipient_id: ref("ana.id"), token_hash: c.text("expire-link-hash"), round: c.int(1), via: c.text("email"), revoked: c.bool(false) }, as: "link" }),
      s.function.call({ fn: dueExpiriesFn, as: "ran" }),
      s.db.get({ table: envelope, fieldValue: ref("env.id"), as: "after" }),
      s.expect.to_equal({ expr: ref("after.status"), value: c.text("expired") }),
      s.db.get({ table: signing_link, fieldValue: ref("link.id"), as: "link_after" }),
      s.expect.to_be_true({ expr: ref("link_after.revoked") }),
      s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("ana.id")), cmp(col("kind"), "=", c.text("expired"))], returnType: "count", as: "told" }),
      s.expect.to_equal({ expr: ref("told"), value: c.int(1) }),
    ],
  }),
];
