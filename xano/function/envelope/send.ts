// Sending a draft, and moving a sent envelope on. `advanceFn` is the one place that decides what happens next: invite the
// next step of recipients, or, when everyone who acts has finished, move to finishing. It locks the envelope, so two people
// finishing at the same moment can't both start the next step.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { email_outbox } from "../../table/email/email_outbox.js";
import { emailStatusFn } from "../email/status.js";
import { enqueueFn } from "../email/outbox.js";
import { mintDownloadFn, mintLinkFn } from "../signing/links.js";
import { audit } from "../audit/audit.js";
import { envelopeTransition, recipientTransition } from "./transition.js";
import { loadActor, requireDraft, sendProblems } from "./draft.js";
import { rbac } from "../../rbac.js";

const actorInput = { actor_type: input.text(), actor_id: input.int(), actor_name: input.text(), actor_email: input.text(), ip: input.text(), user_agent: input.text() };
const actorPass = () => ({ actor_type: inp("actor_type"), actor_id: inp("actor_id"), actor_name: inp("actor_name"), actor_email: inp("actor_email"), ip: inp("ip"), user_agent: inp("user_agent") });

/**
 * What happens next on an envelope in progress. Answers `{ step, invited: [recipient ids], finishing }`: the step now
 * acting and who was just invited to it, or `finishing` when everyone who acts is done.
 */
export const advanceFn = defineFunction({
  name: "envelope/advance",
  description: "Invite the next signing step, or move the envelope to finishing when everyone has acted.",
  input: { envelope_id: input.int({ required: true }), ...actorInput },
  stack: [
    s.set_var("invited", c.array([])),
    s.set_var("finishing", c.bool(false)),
    s.set_var("step", c.int(0)),
    s.db.transaction({ body: [
      s.db.get({ table: envelope, fieldValue: inp("envelope_id"), lock: true, output: ["id", "status"], as: "adv_env" }),
      s.conditional({ when: expr(ref("adv_env.status", { safe: true }), "!=", c.text("in_progress")), then: [
        s.return(obj({ step: c.int(0), invited: c.array([]), finishing: c.bool(false) })),
      ] }),
      // Everyone who acts (CC only gets a copy) and hasn't finished yet, earliest step first.
      s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", inp("envelope_id")), cmp(col("role"), "!=", c.text("cc")), cmp(col("status"), "!=", c.text("completed"))],
        sort: [{ sortBy: "step", dir: "asc" }], output: ["id", "step", "status"], as: "pending" }),
      s.conditional({ when: expr(withFilters(ref("pending"), fl.count()), "=", c.int(0)), then: [
        s.function.run({ fn: envelopeTransition, as: "to_finish", input: { envelope_id: inp("envelope_id"), to: c.text("sealing"), kind: c.text("envelope.all_signed"), ...actorPass() } }),
        s.update_var("finishing", c.bool(true)),
      ], else: [
        s.update_var("step", withFilters(ref("pending"), fl.first(), fl.get("step"))),
        s.foreach({ list: ref("pending"), as: "p", body: [
          s.conditional({ when: and(expr(ref("p.step"), "=", ref("step")), expr(ref("p.status"), "=", c.text("waiting"))), then: [
            s.function.run({ fn: recipientTransition, as: "invited_one", input: { recipient_id: ref("p.id"), to: c.text("sent"), kind: c.text("recipient.invited"), ...actorPass() } }),
            s.update_var("invited", withFilters(ref("invited"), fl.array_push(ref("p.id")))),
          ] }),
        ] }),
      ] }),
    ] }),
    // Mail goes out after the moves are saved: a failed send never undoes them. The sender signing their own document isn't
    // emailed about it: they sign from the app, where it's in their "Action required".
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["sender_id"], as: "adv_owner" }),
    s.set_var("owner_id", withFilters(ref("adv_owner.sender_id", { safe: true }), fl.first_notempty(c.int(0)))),
    s.foreach({ list: ref("invited"), as: "rid", body: [
      s.db.get({ table: recipient, fieldValue: ref("rid"), output: ["user_id"], as: "inv" }),
      s.conditional({ when: expr(withFilters(ref("inv.user_id", { safe: true }), fl.first_notempty(c.int(0))), "!=", ref("owner_id")), then: [
        s.function.run({ fn: enqueueFn, as: "queued", input: { kind: c.text("invite"), recipient_id: ref("rid"), envelope_id: inp("envelope_id") } }),
      ] }),
    ] }),
  ],
  response: obj({ step: ref("step"), invited: ref("invited"), finishing: ref("finishing") }),
  responseShape: {} as { step: number; invited: number[]; finishing: boolean },
});

/**
 * Send a draft. Refuses while anything on the Review list is unfixed. When email isn't set up (or the invites are link-only),
 * answers each invited person's signing link once, to copy and share.
 */
export const sendFn = defineFunction({
  name: "envelope/send",
  description: "Send a draft to its recipients.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), ip: input.text(), user_agent: input.text() },
  stack: [
    ...requireDraft(),
    s.function.run({ fn: sendProblems, as: "problems", input: { envelope_id: inp("envelope_id") } }),
    s.function.run({ fn: emailStatusFn, as: "mail", input: { test_key: c.text(""), test_from: c.text(""), test_webhook: c.text("") } }),
    s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", inp("envelope_id")), cmp(col("identity_check"), "=", c.text("email_code"))], returnType: "count", as: "needs_codes" }),
    s.conditional({ when: and(expr(ref("needs_codes"), ">", c.int(0)), expr(ref("mail.can_send"), "!=", c.bool(true))), then: [
      s.update_var("problems", withFilters(ref("problems"), fl.array_push(obj({ code: c.text("email_needed"), message: c.text("Emailed codes need email set up. Choose another identity check, or connect email in Settings.") })))),
    ] }),
    guard.require(expr(withFilters(ref("problems"), fl.count()), "=", c.int(0)), { errorType: "badrequest", message: "This document isn't ready to send yet. Fix what's listed under Review." }),
    s.function.run({ fn: envelopeTransition, as: "sent", input: {
      envelope_id: inp("envelope_id"), to: c.text("in_progress"), kind: c.text("envelope.sent"),
      actor_type: c.text("user"), actor_id: ref("actor.id"), actor_name: ref("actor.name"), actor_email: ref("actor.email"), ip: inp("ip"), user_agent: inp("user_agent"),
    } }),
    s.function.run({ fn: advanceFn, as: "next", input: {
      envelope_id: inp("envelope_id"), actor_type: c.text("user"), actor_id: ref("actor.id"), actor_name: ref("actor.name"), actor_email: ref("actor.email"), ip: inp("ip"), user_agent: inp("user_agent"),
    } }),
    // Invites that won't be emailed: hand the sender each person's link now, once.
    s.set_var("links", c.array([])),
    s.foreach({ list: ref("next.invited"), as: "rid", body: [
      s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("rid")), cmp(col("kind"), "=", c.text("invite")), cmp(col("status"), "=", c.text("link_only"))], returnType: "count", as: "link_only" }),
      s.conditional({ when: expr(ref("link_only"), ">", c.int(0)), then: [
        s.function.run({ fn: mintLinkFn, as: "minted", input: { recipient_id: ref("rid"), via: c.text("copied") } }),
        s.db.get({ table: recipient, fieldValue: ref("rid"), output: ["id", "name", "email"], as: "who" }),
        s.update_var("links", withFilters(ref("links"), fl.array_push(obj({ recipient_id: ref("rid"), name: ref("who.name", { safe: true }), email: ref("who.email", { safe: true }), url: ref("minted.url") })))),
      ] }),
    ] }),
  ],
  response: obj({ ok: c.bool(true), envelope_id: inp("envelope_id"), links: ref("links"), email: ref("mail.state") }),
});

/**
 * A fresh signing link for one recipient, to copy and share: shown once, recorded on the trail. Their earlier links keep
 * working. For the sender, or anyone who reads every envelope, while the envelope is out.
 */
export const copyLinkFn = defineFunction({
  name: "envelope/copy_link",
  description: "Make a new signing link for a recipient, to share by hand.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), recipient_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "status", "sender_id"], as: "env" }),
    guard.found("env", { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.conditional({ when: expr(ref("env.sender_id"), "!=", ref("actor.id")), then: [
      rbac.allows(ref("actor.role"), "envelope.read_all", "Only the person who sent this document can share its links."),
    ] }),
    guard.require(expr(ref("env.status"), "=", c.text("in_progress")), { errorType: "badrequest", message: "Links can only be shared while the document is out for signature." }),
    s.db.get({ table: recipient, fieldValue: inp("recipient_id"), output: ["id", "envelope_id", "role", "status", "name", "email"], as: "who" }),
    guard.found("who", { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(expr(ref("who.envelope_id"), "=", inp("envelope_id")), { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(expr(ref("who.role"), "!=", c.text("cc")), { errorType: "badrequest", message: "People who only get a copy don't sign, so they have no link." }),
    guard.require(expr(withFilters(c.array(["waiting", "sent", "opened"]), fl.in(ref("who.status"))), "=", c.bool(true)), { errorType: "badrequest", message: "This person has already finished." }),
    s.function.run({ fn: mintLinkFn, as: "minted", input: { recipient_id: inp("recipient_id"), via: c.text("copied") } }),
  ],
  response: obj({ recipient_id: inp("recipient_id"), name: ref("who.name"), email: ref("who.email"), url: ref("minted.url") }),
});

/**
 * A party's link to their signed copy, to share by hand when email isn't set up: for the sender or anyone who reads every
 * envelope, once it's complete. A new link replaces that person's earlier one.
 */
export const copyDownloadFn = defineFunction({
  name: "envelope/copy_download",
  description: "Make a new download link to the signed copy for one party, to share by hand.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), recipient_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "status", "sender_id"], as: "env" }),
    guard.found("env", { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.conditional({ when: expr(ref("env.sender_id"), "!=", ref("actor.id")), then: [
      rbac.allows(ref("actor.role"), "envelope.read_all", "Only the person who sent this document can share its signed copy."),
    ] }),
    guard.require(expr(ref("env.status"), "=", c.text("completed")), { errorType: "badrequest", message: "The signed copy is ready once everyone has signed." }),
    s.db.get({ table: recipient, fieldValue: inp("recipient_id"), output: ["id", "envelope_id", "name", "email"], as: "who" }),
    guard.found("who", { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(expr(ref("who.envelope_id"), "=", inp("envelope_id")), { errorType: "notfound", message: "That person isn't on this document." }),
    s.function.run({ fn: mintDownloadFn, as: "minted", input: { recipient_id: inp("recipient_id") } }),
    audit({
      envelope: inp("envelope_id"), kind: "link.download_created",
      actor: { type: c.text("user"), id: ref("actor.id"), name: ref("actor.name"), email: ref("actor.email") },
      data: obj({ recipient_id: inp("recipient_id"), recipient_email: ref("who.email") }),
    }),
  ],
  response: obj({ recipient_id: inp("recipient_id"), name: ref("who.name"), email: ref("who.email"), url: ref("minted.url") }),
});

/** A member who is a recipient on an envelope, and whose turn it is, opens signing in the app through a fresh link. */
export const signAsMeFn = defineFunction({
  name: "envelope/sign_as_me",
  description: "A fresh signing link for the signed-in member, when it's their turn on this envelope.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", inp("envelope_id")), cmp(col("user_id"), "=", ref("actor.id")), cmp(col("status"), "in", c.array(["sent", "opened"]))], returnType: "single", output: ["id"], as: "mine" }),
    guard.found("mine", { errorType: "notfound", message: "It isn't your turn on this document." }),
    s.set_var("mine_id", withFilters(ref("mine"), fl.get("id"))),
    s.function.run({ fn: mintLinkFn, as: "minted", input: { recipient_id: ref("mine_id"), via: c.text("in_app") } }),
  ],
  response: obj({ url: ref("minted.url") }),
});

export const sendFunctions = [advanceFn, sendFn, copyLinkFn, copyDownloadFn, signAsMeFn];
