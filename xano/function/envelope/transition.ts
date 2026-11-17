// Every status change an envelope or a recipient makes goes through one of these two functions. Each locks the row, refuses
// a move that isn't allowed, stamps the matching times, and writes the audit event, so no path can skip a rule or the trail.
// Callers run what follows from the move (emails, webhooks, the next signer) after these return.
import { c, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { audit } from "../audit/audit.js";

const DAY_MS = 86_400_000;

/** Envelope moves, as "from>to". Everything else is refused. `sealing>sealing` lets a failed seal be retried. */
export const ENVELOPE_MOVES = [
  "draft>in_progress",
  "in_progress>sealing", "in_progress>declined", "in_progress>voided", "in_progress>expired",
  "sealing>sealing", "sealing>completed",
] as const;

/** Recipient moves. A CC goes straight from waiting to completed when the envelope completes. */
export const RECIPIENT_MOVES = [
  "waiting>sent", "waiting>completed",
  "sent>opened", "sent>completed", "sent>declined", "sent>sent",
  "opened>completed", "opened>declined", "opened>opened", "opened>sent",
] as const;

const actorInput = {
  actor_type: input.text(), actor_id: input.int(), actor_name: input.text(), actor_email: input.text(), ip: input.text(), user_agent: input.text(),
};
const actorOf = () => ({ type: inp("actor_type"), id: inp("actor_id"), name: inp("actor_name"), email: inp("actor_email"), ip: inp("ip"), ua: inp("user_agent") });

export const envelopeTransition = defineFunction({
  name: "envelope/transition",
  description: "Move an envelope to a new status, if that move is allowed, and record it.",
  input: { envelope_id: input.int({ required: true }), to: input.text({ required: true }), kind: input.text(), reason: input.text(), data: input.json(), ...actorInput },
  stack: [
    s.db.transaction({ body: [
      s.db.get({ table: envelope, fieldValue: inp("envelope_id"), lock: true, output: ["id", "status", "expiry_days", "title", "sender_id"], as: "env" }),
      guard.found("env", { errorType: "notfound", message: "That document doesn't exist." }),
      s.set_var("move", withFilters(ref("env.status"), fl.concat(c.text(">")), fl.concat(inp("to")))),
      guard.require(expr(withFilters(c.array([...ENVELOPE_MOVES]), fl.in(ref("move"))), "=", c.bool(true)), { errorType: "badrequest", message: "That document can't change to this state now." }),
      s.set_var("now_ms", c.now()),
      s.set_var("why", withFilters(inp("reason"), fl.first_notnull(c.text("")))),
      s.set_var("event_kind", withFilters(c.text("envelope."), fl.concat(inp("to")))),
      s.conditional({ when: expr(inp("kind"), "!=", c.text("")), then: [s.update_var("event_kind", inp("kind"))] }),
      s.set_var("patch", obj({ status: inp("to"), updated_at: ref("now_ms") })),
      s.conditional({ when: expr(inp("to"), "=", c.text("in_progress")), then: [
        s.set_var("expires_ms", withFilters(ref("env.expiry_days"), fl.first_notempty(c.int(30)), fl.mul(c.int(DAY_MS)), fl.add(ref("now_ms")), fl.to_int())),
        s.update_var("patch", withFilters(ref("patch"),
          fl.set("sent_at", ref("now_ms")), fl.set("expires_at", ref("expires_ms")))),
      ] }),
      s.conditional({ when: expr(inp("to"), "=", c.text("completed")), then: [
        s.update_var("patch", withFilters(ref("patch"), fl.set("completed_at", ref("now_ms")), fl.set("ended_at", ref("now_ms")), fl.set("seal_failed", c.bool(false)), fl.set("seal_error", c.text("")))),
      ] }),
      s.conditional({ when: expr(withFilters(c.array(["declined", "voided", "expired"]), fl.in(inp("to"))), "=", c.bool(true)), then: [
        s.update_var("patch", withFilters(ref("patch"), fl.set("ended_at", ref("now_ms")), fl.set("end_reason", ref("why")))),
      ] }),
      s.db.patch({ table: envelope, fieldValue: inp("envelope_id"), data: ref("patch"), as: "moved" }),
      audit({
        envelope: inp("envelope_id"),
        kind: ref("event_kind"),
        actor: actorOf(),
        data: withFilters(inp("data"), fl.first_notnull(obj({})), fl.set("from", ref("env.status")), fl.set("to", inp("to")), fl.set("reason", ref("why"))),
      }),
    ] }),
    changed({ entity: "envelope", id: inp("envelope_id"), op: "updated", actor: inp("actor_id") }),
  ],
  response: { ok: c.bool(true), from: ref("env.status"), to: inp("to") },
});

export const recipientTransition = defineFunction({
  name: "recipient/transition",
  description: "Move a recipient to a new state, if allowed, and record it on the envelope's trail.",
  input: { recipient_id: input.int({ required: true }), to: input.text({ required: true }), kind: input.text(), reason: input.text(), data: input.json(), ...actorInput },
  stack: [
    s.db.transaction({ body: [
      s.db.get({ table: recipient, fieldValue: inp("recipient_id"), lock: true, output: ["id", "status", "envelope_id", "name", "email", "role"], as: "rcp" }),
      guard.found("rcp", { errorType: "notfound", message: "That person isn't on this document." }),
      s.set_var("move", withFilters(ref("rcp.status"), fl.concat(c.text(">")), fl.concat(inp("to")))),
      guard.require(expr(withFilters(c.array([...RECIPIENT_MOVES]), fl.in(ref("move"))), "=", c.bool(true)), { errorType: "badrequest", message: "This step has already been taken." }),
      s.set_var("now_ms", c.now()),
      s.set_var("why", withFilters(inp("reason"), fl.first_notnull(c.text("")))),
      s.set_var("event_kind", withFilters(c.text("recipient."), fl.concat(inp("to")))),
      s.conditional({ when: expr(inp("kind"), "!=", c.text("")), then: [s.update_var("event_kind", inp("kind"))] }),
      s.set_var("patch", obj({ status: inp("to") })),
      s.conditional({ when: expr(inp("to"), "=", c.text("opened")), then: [s.update_var("patch", withFilters(ref("patch"), fl.set("opened_at", ref("now_ms"))))] }),
      s.conditional({ when: expr(inp("to"), "=", c.text("completed")), then: [s.update_var("patch", withFilters(ref("patch"), fl.set("completed_at", ref("now_ms"))))] }),
      s.conditional({ when: expr(inp("to"), "=", c.text("declined")), then: [
        s.update_var("patch", withFilters(ref("patch"), fl.set("declined_at", ref("now_ms")), fl.set("decline_reason", ref("why")))),
      ] }),
      s.db.patch({ table: recipient, fieldValue: inp("recipient_id"), data: ref("patch"), as: "moved" }),
      // Re-opening a link the recipient already opened isn't news: only real changes reach the trail.
      s.conditional({ when: expr(ref("rcp.status"), "!=", inp("to")), then: [
        audit({
          envelope: ref("rcp.envelope_id"),
          kind: ref("event_kind"),
          actor: actorOf(),
          data: withFilters(inp("data"), fl.first_notnull(obj({})), fl.set("recipient_id", inp("recipient_id")), fl.set("recipient_email", ref("rcp.email")), fl.set("role", ref("rcp.role")), fl.set("from", ref("rcp.status")), fl.set("to", inp("to"))),
        }),
      ] }),
    ] }),
    changed({ entity: "envelope", id: ref("rcp.envelope_id"), op: "updated", actor: inp("actor_id") }),
  ],
  response: { ok: c.bool(true), from: ref("rcp.status"), to: inp("to"), envelope_id: ref("rcp.envelope_id") },
});
