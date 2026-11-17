// Signing in person: the sender (or anyone who reads every envelope) opens a recipient's signing page on their own device and
// hands it over. The recipient still goes through their identity check and consent. The trail records who hosted it, and the
// certificate says "Signed in person, hosted by …".
import { c, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { audit } from "../audit/audit.js";
import { mintLinkFn } from "../signing/links.js";
import { canRead } from "./access.js";
import { loadActor } from "./draft.js";

export const hostFn = defineFunction({
  name: "envelope/host",
  description: "Start in-person signing for a recipient whose turn it is: answers a signing link to open on this device.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), recipient_id: input.int({ required: true }), ip: input.text(), user_agent: input.text() },
  stack: [
    ...loadActor(),
    s.function.run({ fn: canRead, as: "may_read", input: { actor_id: inp("actor_id"), envelope_id: inp("envelope_id") } }),
    guard.require(expr(ref("may_read"), "=", c.bool(true)), { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "status", "sender_id"], as: "env" }),
    guard.found("env", { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.conditional({ when: expr(ref("env.sender_id"), "!=", ref("actor.id")), then: [
      rbac.allows(ref("actor.role"), "envelope.read_all", "Only the person who sent this document can host signing in person."),
    ] }),
    guard.require(expr(ref("env.status"), "=", c.text("in_progress")), { errorType: "badrequest", message: "Signing in person works while the document is out for signature." }),
    s.db.get({ table: recipient, fieldValue: inp("recipient_id"), output: ["id", "envelope_id", "role", "status", "name", "email"], as: "who" }),
    guard.found("who", { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(expr(ref("who.envelope_id"), "=", inp("envelope_id")), { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(expr(ref("who.role"), "!=", c.text("cc")), { errorType: "badrequest", message: "People who only get a copy don't sign." }),
    guard.require(expr(withFilters(c.array(["sent", "opened"]), fl.in(ref("who.status"))), "=", c.bool(true)), { errorType: "badrequest", message: "It isn't this person's turn, or they've already finished." }),
    s.db.patch({ table: recipient, fieldValue: inp("recipient_id"), data: obj({ hosted_by: ref("actor.id") }), as: "hosted" }),
    s.function.run({ fn: mintLinkFn, as: "minted", input: { recipient_id: inp("recipient_id"), via: c.text("in_person") } }),
    audit({
      envelope: inp("envelope_id"), kind: "recipient.hosted",
      actor: { type: c.text("user"), id: ref("actor.id"), name: ref("actor.name"), email: ref("actor.email"), ip: inp("ip"), ua: inp("user_agent") },
      data: obj({ recipient_id: inp("recipient_id"), recipient_email: ref("who.email"), method: c.text("in_person") }),
    }),
    changed({ entity: "envelope", id: inp("envelope_id"), actor: inp("actor_id") }),
  ],
  response: obj({ url: ref("minted.url"), name: ref("who.name") }),
});

export const hostFunctions = [hostFn];
