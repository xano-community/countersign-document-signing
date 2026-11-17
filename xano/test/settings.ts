// Settings: only admins change them, retention erases old ended documents and leaves a verify tombstone, clearing demo data leaves
// real documents alone, a new disclosure is a new version, and removing someone ends their access and keys but keeps their work.
import { c, cmp, col, obj, ref, s, workflowTest as plainWorkflowTest } from "@xano/sdk";
import { envelope } from "../table/envelope/envelope.js";
import { org_setting } from "../table/envelope/org_setting.js";
import { purged_envelope } from "../table/envelope/purged_envelope.js";
import { recipient } from "../table/envelope/recipient.js";
import { disclosure } from "../table/signing/disclosure.js";
import { api_key } from "../table/developer/api_key.js";
import { user } from "../table/user.js";
import { clearDemoFn, purgeDueFn, removeMemberFn, saveDisclosureFn, updateOrgFn } from "../function/settings/org.js";
import { createKeyFn } from "../function/developer/keys.js";
import { draft, person, signer, workflowTest } from "./fixtures.js";

const DAY = 86_400_000;
const settingsInput = (actor: string, extra = {}) => ({
  actor_id: ref(`${actor}.id`), org_name: c.text("Fernhill Test"), accent: c.text("ink"), email_sender_name: c.text("Fernhill"), reply_to: c.text(""),
  default_expiry_days: c.int(14), default_reminder_days: c.int(2), retention_days: c.int(0), demo_mode: c.bool(false), ...extra,
});

export const settingsTests = [
  workflowTest({
    name: "settings: an admin changes them; a member can't",
    description: "The admin's change is saved; the member's is refused.",
    stack: [
      s.db.add({ table: org_setting, as: "org", row: { org_name: c.text("Before"), default_expiry_days: c.int(30), default_reminder_days: c.int(3) } }),
      person("boss", "admin"),
      person("worker"),
      s.function.call({ fn: updateOrgFn, as: "saved", input: settingsInput("boss") }),
      s.db.get({ table: org_setting, fieldValue: ref("org.id"), as: "after" }),
      s.expect.to_equal({ expr: ref("after.org_name"), value: c.text("Fernhill Test") }),
      s.expect.to_equal({ expr: ref("after.default_expiry_days"), value: c.int(14) }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: user, where: cmp(col("email"), "=", c.text("worker@countersign-test.example")), returnType: "single", as: "w" }),
          s.function.call({ fn: updateOrgFn, as: "nope", input: { ...settingsInput("w") } }),
        ],
        exception: c.text("Only admins"),
      }),
    ],
  }),
  workflowTest({
    name: "settings: retention erases an old completed document and leaves a tombstone; recent ones stay",
    description: "With 30-day retention, a document completed 31 days ago is erased with a tombstone; one completed yesterday stays.",
    stack: [
      s.db.add({ table: org_setting, as: "org", row: { org_name: c.text("Keep"), retention_days: c.int(30) } }),
      person("sender"),
      s.set_var("now_ms", c.now()),
      s.set_var("old_at", c.expression(`$var.now_ms - ${31 * DAY}`)),
      s.set_var("new_at", c.expression(`$var.now_ms - ${DAY}`)),
      draft("old", "sender", "Old lease", { status: c.text("completed") }),
      s.db.patch({ table: envelope, fieldValue: ref("old.id"), data: obj({ completed_at: ref("old_at"), final_sha256: c.text("ab".repeat(32)) }), as: "aged" }),
      signer("ana", "old", "ana@old.example"),
      draft("fresh", "sender", "Fresh lease", { status: c.text("completed") }),
      s.db.patch({ table: envelope, fieldValue: ref("fresh.id"), data: obj({ completed_at: ref("new_at") }), as: "recent" }),
      s.function.call({ fn: purgeDueFn, as: "purged" }),
      s.db.get({ table: envelope, fieldValue: ref("old.id"), as: "old_after" }),
      s.expect.to_be_null({ expr: ref("old_after") }),
      s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("old.id")), returnType: "count", as: "people_left" }),
      s.expect.to_equal({ expr: ref("people_left"), value: c.int(0) }),
      s.db.query({ table: purged_envelope, where: cmp(col("public_id"), "=", ref("old.public_id")), returnType: "single", as: "stone" }),
      s.expect.to_equal({ expr: ref("stone.final_sha256"), value: c.text("ab".repeat(32)) }),
      s.db.get({ table: envelope, fieldValue: ref("fresh.id"), as: "fresh_after" }),
      s.expect.to_equal({ expr: ref("fresh_after.title"), value: c.text("Fresh lease") }),
    ],
  }),
  plainWorkflowTest({
    name: "settings: clearing demo data removes demo documents and leaves real ones",
    description: "Two demo documents go; the real one stays.",
    stack: [
      person("boss", "admin"),
      draft("d1", "boss", "Demo one"),
      draft("d2", "boss", "Demo two", { status: c.text("completed") }),
      draft("real", "boss", "Real one"),
      s.db.patch({ table: envelope, fieldValue: ref("d1.id"), data: obj({ is_demo: c.bool(true) }), as: "m1" }),
      s.db.patch({ table: envelope, fieldValue: ref("d2.id"), data: obj({ is_demo: c.bool(true) }), as: "m2" }),
      s.function.call({ fn: clearDemoFn, as: "cleared", input: { actor_id: ref("boss.id") } }),
      s.expect.to_equal({ expr: ref("cleared.removed"), value: c.int(2) }),
      s.db.query({ table: envelope, returnType: "count", as: "left" }),
      s.expect.to_equal({ expr: ref("left"), value: c.int(1) }),
      s.db.query({ table: purged_envelope, returnType: "count", as: "stones" }),
      s.expect.to_equal({ expr: ref("stones"), value: c.int(0) }),
    ],
  }),
  plainWorkflowTest({
    name: "settings: editing the disclosure publishes a new version",
    description: "Version 2 is added; version 1 is kept for the signers who agreed to it.",
    stack: [
      person("boss", "admin"),
      s.db.add({ table: disclosure, as: "v1", row: { version: c.int(1), text: c.text("The first disclosure, long enough to count as one: you agree to sign electronically, and so on.") } }),
      s.function.call({ fn: saveDisclosureFn, as: "saved", input: { actor_id: ref("boss.id"), text: c.text("The second disclosure, also long enough to count: you agree to sign electronically and to receive records by email.") } }),
      s.expect.to_equal({ expr: ref("saved.version"), value: c.int(2) }),
      s.db.query({ table: disclosure, returnType: "count", as: "versions" }),
      s.expect.to_equal({ expr: ref("versions"), value: c.int(2) }),
    ],
  }),
  workflowTest({
    name: "settings: removing someone ends their access and keys, and keeps their documents",
    description: "The removed person's status and role change, their key is revoked, their document stays; the last admin can't be removed.",
    stack: [
      person("boss", "admin"),
      person("leaver", "admin"),
      s.function.call({ fn: createKeyFn, as: "key", input: { actor_id: ref("leaver.id"), name: c.text("Their script") } }),
      draft("theirs", "leaver", "Their lease"),
      s.function.call({ fn: removeMemberFn, as: "removed", input: { actor_id: ref("boss.id"), user_id: ref("leaver.id") } }),
      s.db.get({ table: user, fieldValue: ref("leaver.id"), as: "after" }),
      s.expect.to_equal({ expr: ref("after.status"), value: c.text("removed") }),
      s.expect.to_equal({ expr: ref("after.role"), value: c.text("viewer") }),
      s.db.get({ table: api_key, fieldValue: ref("key.id"), as: "key_after" }),
      s.expect.to_not_equal({ expr: ref("key_after.revoked_at"), value: c.null() }),
      s.db.get({ table: envelope, fieldValue: ref("theirs.id"), as: "doc_after" }),
      s.expect.to_equal({ expr: ref("doc_after.title"), value: c.text("Their lease") }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: user, where: cmp(col("email"), "=", c.text("boss@countersign-test.example")), returnType: "single", as: "b" }),
          s.function.call({ fn: removeMemberFn, as: "self", input: { actor_id: ref("b.id"), user_id: ref("b.id") } }),
        ],
        exception: c.text("can't remove yourself"),
      }),
    ],
  }),
];
