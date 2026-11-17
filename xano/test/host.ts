// Signing without email: the sender signing their own document gets no invite, a host is named on the trail and the recipient,
// and nobody can host signing on a document they can't see.
import { c, cmp, col, obj, ref, s } from "@xano/sdk";
import { recipient } from "../table/envelope/recipient.js";
import { org_setting } from "../table/envelope/org_setting.js";
import { user } from "../table/user.js";
import { email_outbox } from "../table/email/email_outbox.js";
import { audit_event } from "../table/signing/audit_event.js";
import { advanceFn } from "../function/envelope/send.js";
import { hostFn } from "../function/envelope/host.js";
import { draft, person, signer, workflowTest } from "./fixtures.js";

const out = (as: string, sender: string, title: string, extra = {}) => draft(as, sender, title, { status: c.text("in_progress"), ...extra });

export const hostTests = [
  workflowTest({
    name: "host: the sender signing their own document isn't emailed an invite; others still are",
    description: "Advancing invites both signers, but only the other person gets an invite email.",
    stack: [
      person("sender"),
      out("env", "sender", "Sign it myself"),
      signer("me", "env", "sender@countersign-test.example"),
      s.db.patch({ table: recipient, fieldValue: ref("me.id"), data: obj({ user_id: ref("sender.id") }), as: "me_linked" }),
      signer("ana", "env", "ana@host.example"),
      s.function.call({ fn: advanceFn, as: "next", input: { envelope_id: ref("env.id"), actor_type: c.text("user"), actor_id: ref("sender.id") } }),
      s.db.get({ table: recipient, fieldValue: ref("me.id"), as: "me_after" }),
      s.expect.to_equal({ expr: ref("me_after.status"), value: c.text("sent") }),
      s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("me.id")), cmp(col("kind"), "=", c.text("invite"))], returnType: "count", as: "my_invites" }),
      s.expect.to_equal({ expr: ref("my_invites"), value: c.int(0) }),
      s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("ana.id")), cmp(col("kind"), "=", c.text("invite"))], returnType: "count", as: "ana_invites" }),
      s.expect.to_equal({ expr: ref("ana_invites"), value: c.int(1) }),
    ],
  }),
  workflowTest({
    name: "host: in-person signing names the host on the recipient and the trail",
    description: "Hosting sets hosted_by and records recipient.hosted with the host as the actor.",
    stack: [
      s.db.add({ table: org_setting, as: "org", row: { org_name: c.text("Fernhill Test"), app_url: c.text("https://sign.fernhill-test.example") } }),
      person("sender"),
      out("env", "sender", "In person"),
      signer("ana", "env", "ana@inperson.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ status: c.text("sent") }), as: "turn" }),
      s.function.call({ fn: hostFn, as: "hosted", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id"), recipient_id: ref("ana.id") } }),
      s.db.get({ table: recipient, fieldValue: ref("ana.id"), as: "ana_after" }),
      s.expect.to_equal({ expr: ref("ana_after.hosted_by"), value: ref("sender.id") }),
      s.db.query({ table: audit_event, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("kind"), "=", c.text("recipient.hosted"))], returnType: "single", as: "ev" }),
      s.expect.to_equal({ expr: ref("ev.actor_id"), value: ref("sender.id") }),
    ],
  }),
  workflowTest({
    name: "host: a member can't host signing on a document they can't see",
    description: "A private envelope stays out of reach of another member.",
    stack: [
      person("sender"),
      person("stranger"),
      out("env", "sender", "Private one", { visibility: c.text("private") }),
      signer("ana", "env", "ana@private.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ status: c.text("sent") }), as: "turn" }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: recipient, where: cmp(col("email"), "=", c.text("ana@private.example")), returnType: "single", as: "a" }),
          s.db.query({ table: user, where: cmp(col("email"), "=", c.text("stranger@countersign-test.example")), returnType: "single", as: "st" }),
          s.function.call({ fn: hostFn, as: "nope", input: { actor_id: ref("st.id"), envelope_id: ref("a.envelope_id"), recipient_id: ref("a.id") } }),
        ],
        exception: c.text("can't see it"),
      }),
    ],
  }),
];
