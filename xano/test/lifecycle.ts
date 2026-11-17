// The envelope and recipient lifecycles, and the audit chain they write.
import { c, cmp, col, fl, ref, s, withFilters } from "@xano/sdk";
import { envelopeTransition, recipientTransition } from "../function/envelope/transition.js";
import { verifyFn } from "../function/audit/audit.js";
import { audit_event } from "../table/signing/audit_event.js";
import { envelope } from "../table/envelope/envelope.js";
import { draft, person, signer, workflowTest } from "./fixtures.js";

const move = (env: string, to: string, as: string) => s.function.call({ fn: envelopeTransition, as, input: { envelope_id: ref(`${env}.id`), to: c.text(to), actor_type: c.text("user"), actor_id: ref("sender.id") } });

export const lifecycleTests = [
  workflowTest({
    name: "lifecycle: an envelope moves draft, in progress, finishing, completed",
    description: "Each allowed move lands, stamps its times and writes one audit event; the chain verifies.",
    stack: [
      person("sender"),
      draft("env", "sender"),
      move("env", "in_progress", "m1"),
      s.db.get({ table: envelope, fieldValue: ref("env.id"), as: "sent" }),
      s.expect.to_equal({ expr: ref("sent.status"), value: c.text("in_progress") }),
      s.expect.to_be_defined({ expr: ref("sent.sent_at") }),
      s.expect.to_be_greater_than({ expr: ref("sent.expires_at"), value: ref("sent.sent_at") }),
      move("env", "sealing", "m2"),
      move("env", "completed", "m3"),
      s.db.get({ table: envelope, fieldValue: ref("env.id"), as: "done" }),
      s.expect.to_equal({ expr: ref("done.status"), value: c.text("completed") }),
      s.expect.to_be_defined({ expr: ref("done.completed_at") }),
      s.function.call({ fn: verifyFn, as: "chain", input: { envelope_id: ref("env.id") } }),
      s.expect.to_be_true({ expr: ref("chain.ok") }),
      s.expect.to_equal({ expr: ref("chain.events"), value: c.int(3) }),
    ],
  }),
  workflowTest({
    name: "lifecycle: a completed envelope can't be voided",
    description: "A move the table doesn't allow is refused, and the envelope is untouched.",
    stack: [
      person("sender"),
      draft("env", "sender", "Done deal", { status: c.text("completed") }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: envelope, where: cmp(col("title"), "=", c.text("Done deal")), returnType: "single", as: "e" }),
          s.function.call({ fn: envelopeTransition, as: "v", input: { envelope_id: ref("e.id"), to: c.text("voided") } }),
        ],
        exception: c.text("can't change to this state"),
      }),
      s.db.get({ table: envelope, fieldValue: ref("env.id"), as: "still" }),
      s.expect.to_equal({ expr: ref("still.status"), value: c.text("completed") }),
    ],
  }),
  workflowTest({
    name: "lifecycle: a recipient opens, then signs, once",
    description: "Opening twice writes one event; completing a second time is refused.",
    stack: [
      person("sender"),
      draft("env", "sender"),
      signer("ana", "env", "ana@countersign-test.example"),
      s.function.call({ fn: recipientTransition, as: "r1", input: { recipient_id: ref("ana.id"), to: c.text("sent") } }),
      s.function.call({ fn: recipientTransition, as: "r2", input: { recipient_id: ref("ana.id"), to: c.text("opened") } }),
      s.function.call({ fn: recipientTransition, as: "r3", input: { recipient_id: ref("ana.id"), to: c.text("opened") } }),
      s.function.call({ fn: recipientTransition, as: "r4", input: { recipient_id: ref("ana.id"), to: c.text("completed") } }),
      s.db.query({ table: audit_event, where: cmp(col("envelope_id"), "=", ref("env.id")), returnType: "count", as: "events" }),
      s.expect.to_equal({ expr: ref("events"), value: c.int(3) }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: audit_event, where: cmp(col("kind"), "=", c.text("recipient.completed")), returnType: "single", as: "ev" }),
          s.set_var("ev_data", withFilters(ref("ev.data"), fl.json_decode())),
          s.function.call({ fn: recipientTransition, as: "again", input: { recipient_id: ref("ev_data.recipient_id"), to: c.text("completed") } }),
        ],
        exception: c.text("already been taken"),
      }),
    ],
  }),
  workflowTest({
    name: "lifecycle: editing an audit row breaks the chain at that row",
    description: "The verify walk names the first row whose hash no longer adds up.",
    stack: [
      person("sender"),
      draft("env", "sender"),
      move("env", "in_progress", "m1"),
      move("env", "voided", "m2"),
      s.function.call({ fn: verifyFn, as: "before", input: { envelope_id: ref("env.id") } }),
      s.expect.to_be_true({ expr: ref("before.ok") }),
      s.db.query({ table: audit_event, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("seq"), "=", c.int(1))], returnType: "single", as: "first" }),
      s.db.edit({ table: audit_event, fieldValue: ref("first.id"), row: { data: c.text('{"from":"draft","to":"completed","reason":""}') }, as: "tampered" }),
      s.function.call({ fn: verifyFn, as: "after", input: { envelope_id: ref("env.id") } }),
      s.expect.to_be_false({ expr: ref("after.ok") }),
      s.expect.to_equal({ expr: ref("after.broken_at"), value: c.int(1) }),
    ],
  }),
];
