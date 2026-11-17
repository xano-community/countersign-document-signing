// What a sender does to an envelope that's out: void it, correct someone's name or email, extend the deadline, or remind
// someone now. And the two sweep steps that keep envelopes moving on their own: reminders on schedule, and expiry.
// Each is for the sender, or anyone who reads every envelope, and each is on the trail.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, statements, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { notify } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { audit } from "../audit/audit.js";
import { enqueueFn } from "../email/outbox.js";
import { revokeLinksFn } from "../signing/links.js";
import { requireDrawable } from "../signing/charset.js";
import { envelopeTransition } from "./transition.js";
import { loadActor } from "./draft.js";

const DAY_MS = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Binds `actor` and `env`: an envelope out for signature that this actor sent, or may manage as an admin. */
const requireOut = statements(
  ...loadActor(),
  s.db.get({ table: envelope, fieldValue: inp("envelope_id"), as: "env" }),
  guard.found("env", { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
  s.conditional({ when: expr(ref("env.sender_id"), "!=", ref("actor.id")), then: [
    rbac.allows(ref("actor.role"), "envelope.read_all", "Only the person who sent this document can change it."),
  ] }),
  guard.require(expr(ref("env.status"), "=", c.text("in_progress")), { errorType: "badrequest", message: "This document isn't out for signature any more." }),
);
const asActor = () => ({ type: c.text("user"), id: ref("actor.id"), name: ref("actor.name"), email: ref("actor.email"), ip: inp("ip"), ua: inp("user_agent") });
const actorFields = () => ({ actor_type: c.text("user"), actor_id: ref("actor.id"), actor_name: ref("actor.name"), actor_email: ref("actor.email"), ip: inp("ip"), user_agent: inp("user_agent") });
const base = { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), ip: input.text(), user_agent: input.text() };

/** Tell everyone who'd already heard about the envelope that it ended (voided or expired). */
const tellEnded = (kind: "voided" | "expired") => statements(
  s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("status"), "!=", c.text("waiting"))], output: ["id"], as: "heard" }),
  s.foreach({ list: ref("heard"), as: "h", body: [
    s.function.run({ fn: revokeLinksFn, as: "revoked", input: { recipient_id: ref("h.id") } }),
    s.function.run({ fn: enqueueFn, as: "q_ended", input: { kind: c.text(kind), recipient_id: ref("h.id"), envelope_id: ref("env.id") } }),
  ] }),
);

export const voidFn = defineFunction({
  name: "envelope/void",
  description: "Cancel an envelope that's out for signature, with a reason everyone sees.",
  input: { ...base, reason: input.text({ methods: ["trim"] }) },
  stack: [
    ...requireOut,
    guard.require(expr(withFilters(inp("reason"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Say why you're cancelling it. Everyone on it will see this." }),
    guard.require(expr(withFilters(inp("reason"), fl.strlen()), "<=", c.int(500)), { errorType: "badrequest", message: "Keep the reason under 500 characters." }),
    s.function.run({ fn: envelopeTransition, as: "voided", input: { envelope_id: ref("env.id"), to: c.text("voided"), reason: inp("reason"), ...actorFields() } }),
    ...tellEnded("voided"),
  ],
  response: obj({ ok: c.bool(true) }),
});

/**
 * Correct a recipient who hasn't finished: a new name or email. Their links and any open session stop working (their round
 * goes up), and if it's their turn they get a fresh invite at the new address.
 */
export const correctFn = defineFunction({
  name: "envelope/correct",
  description: "Change a recipient's name or email before they've finished, and re-invite them.",
  input: { ...base, recipient_id: input.int({ required: true }), name: input.text({ methods: ["trim"] }), email: input.text({ methods: ["trim", "lower"] }) },
  stack: [
    ...requireOut,
    s.db.get({ table: recipient, fieldValue: inp("recipient_id"), lock: true, as: "who" }),
    guard.found("who", { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(expr(ref("who.envelope_id"), "=", ref("env.id")), { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(expr(withFilters(c.array(["waiting", "sent", "opened"]), fl.in(ref("who.status"))), "=", c.bool(true)), { errorType: "badrequest", message: "This person has already finished, so their details can't change." }),
    guard.require(expr(withFilters(inp("name"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Give their name." }),
    guard.require(expr(withFilters(inp("name"), fl.strlen()), "<=", c.int(120)), { errorType: "badrequest", message: "Keep names under 120 characters." }),
    requireDrawable(inp("name")),
    guard.require(expr(withFilters(c.regex(EMAIL), fl.regex_test(withFilters(inp("email"), fl.first_notnull(c.text(""))))), "=", c.bool(true)), { errorType: "badrequest", message: "Check the email address." }),
    s.set_var("next_round", withFilters(ref("who.round"), fl.add(c.int(1)))),
    s.set_var("next_status", ref("who.status")),
    s.conditional({ when: expr(ref("who.status"), "=", c.text("opened")), then: [s.update_var("next_status", c.text("sent"))] }),
    s.db.patch({ table: recipient, fieldValue: ref("who.id"), data: obj({
      name: inp("name"), email: inp("email"), round: ref("next_round"), status: ref("next_status"),
      bounced: c.bool(false), identity_round: c.int(0), opened_at: c.null(),
    }), as: "corrected" }),
    s.function.run({ fn: revokeLinksFn, as: "revoked", input: { recipient_id: ref("who.id") } }),
    audit({ envelope: ref("env.id"), kind: "recipient.corrected", actor: asActor(), data: obj({
      recipient_id: ref("who.id"), old_name: ref("who.name"), old_email: ref("who.email"), new_name: inp("name"), new_email: inp("email"), round: ref("next_round"),
    }) }),
    s.conditional({ when: expr(ref("next_status"), "=", c.text("sent")), then: [
      s.function.run({ fn: enqueueFn, as: "q_invite", input: { kind: c.text("invite"), recipient_id: ref("who.id"), envelope_id: ref("env.id") } }),
    ] }),
  ],
  response: obj({ ok: c.bool(true), round: ref("next_round") }),
});

export const extendFn = defineFunction({
  name: "envelope/extend",
  description: "Move an envelope's deadline later.",
  input: { ...base, days: input.int({ required: true }) },
  stack: [
    ...requireOut,
    guard.require(and(expr(inp("days"), ">=", c.int(1)), expr(inp("days"), "<=", c.int(365))), { errorType: "badrequest", message: "Extend by 1 to 365 days." }),
    s.set_var("now_ms", c.now()),
    s.set_var("from", withFilters(ref("env.expires_at"), fl.first_notempty(ref("now_ms")))),
    s.conditional({ when: expr(ref("from"), "<", ref("now_ms")), then: [s.update_var("from", ref("now_ms"))] }),
    s.set_var("until", withFilters(inp("days"), fl.mul(c.int(DAY_MS)), fl.add(ref("from")), fl.to_int())),
    s.db.patch({ table: envelope, fieldValue: ref("env.id"), data: obj({ expires_at: ref("until"), updated_at: ref("now_ms") }), as: "extended" }),
    audit({ envelope: ref("env.id"), kind: "envelope.extended", actor: asActor(), data: obj({ old_expires_at: ref("env.expires_at"), new_expires_at: ref("until") }) }),
    changed({ entity: "envelope", id: ref("env.id"), actor: inp("actor_id") }),
  ],
  response: obj({ ok: c.bool(true), expires_at: ref("until") }),
});

/** One reminder to one recipient whose turn it is. Each is its own email; a repeat with the same number is a no-op. */
const remindOne = defineFunction({
  name: "envelope/remind_one",
  description: "Send a recipient whose turn it is a reminder, and record it.",
  input: { recipient_id: input.int({ required: true }), actor_type: input.text(), actor_id: input.int(), actor_name: input.text(), actor_email: input.text(), ip: input.text(), user_agent: input.text() },
  stack: [
    s.db.get({ table: recipient, fieldValue: inp("recipient_id"), output: ["id", "envelope_id", "reminders_sent", "status", "name", "email"], as: "who" }),
    guard.found("who", { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(or(expr(ref("who.status"), "=", c.text("sent")), expr(ref("who.status"), "=", c.text("opened"))), { errorType: "badrequest", message: "It isn't this person's turn, so there's nothing to remind them about." }),
    s.set_var("n", withFilters(ref("who.reminders_sent"), fl.first_notempty(c.int(0)), fl.add(c.int(1)))),
    s.set_var("now_ms", c.now()),
    s.db.patch({ table: recipient, fieldValue: ref("who.id"), data: obj({ reminders_sent: ref("n"), last_reminded_at: ref("now_ms") }), as: "counted" }),
    s.function.run({ fn: enqueueFn, as: "q_reminder", input: { kind: c.text("reminder"), recipient_id: ref("who.id"), n: ref("n"), envelope_id: ref("who.envelope_id") } }),
    audit({ envelope: ref("who.envelope_id"), kind: "recipient.reminded", actor: { type: withFilters(inp("actor_type"), fl.first_notempty(c.text("system"))), id: inp("actor_id"), name: inp("actor_name"), email: inp("actor_email"), ip: inp("ip"), ua: inp("user_agent") },
      data: obj({ recipient_id: ref("who.id"), recipient_email: ref("who.email"), reminder: ref("n") }) }),
  ],
  response: obj({ ok: c.bool(true), reminder: ref("n") }),
});

export const remindFn = defineFunction({
  name: "envelope/remind",
  description: "Remind someone now, whose turn it is.",
  input: { ...base, recipient_id: input.int({ required: true }) },
  stack: [
    ...requireOut,
    s.db.get({ table: recipient, fieldValue: inp("recipient_id"), output: ["id", "envelope_id"], as: "who" }),
    guard.found("who", { errorType: "notfound", message: "That person isn't on this document." }),
    guard.require(expr(ref("who.envelope_id"), "=", ref("env.id")), { errorType: "notfound", message: "That person isn't on this document." }),
    s.function.run({ fn: remindOne, as: "reminded", input: { recipient_id: ref("who.id"), ...actorFields() } }),
  ],
  response: ref("reminded"),
});

/** Sweep step: reminders on schedule, for real envelopes that are out and not past their deadline. */
export const dueRemindersFn = defineFunction({
  name: "envelope/due_reminders",
  description: "Send the reminders that are due.",
  stack: [
    s.set_var("now_ms", c.now()),
    s.db.query({ table: envelope, where: [cmp(col("status"), "=", c.text("in_progress")), expr(col("reminder_days"), ">", c.int(0)), cmp(col("is_demo"), "!=", c.bool(true))],
      output: ["id", "reminder_days", "expires_at", "sent_at"], paging: { per_page: 200, metadata: false }, as: "out" }),
    s.set_var("sent", c.int(0)),
    s.foreach({ list: ref("out"), as: "e", body: [
      s.conditional({ when: or(expr(ref("e.expires_at"), "=", c.null()), expr(ref("e.expires_at"), ">", ref("now_ms"))), then: [
        s.set_var("gap", withFilters(ref("e.reminder_days"), fl.mul(c.int(DAY_MS)), fl.to_int())),
        s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("e.id")), cmp(col("status"), "in", c.array(["sent", "opened"]))], output: ["id", "last_reminded_at"], as: "turn" }),
        s.foreach({ list: ref("turn"), as: "r", body: [
          // A reminder is due a full gap after the last one, or after the envelope (or their step) went out.
          s.set_var("since", withFilters(ref("r.last_reminded_at"), fl.first_notempty(ref("e.sent_at")), fl.first_notempty(c.int(0)))),
          s.conditional({ when: expr(withFilters(ref("since"), fl.add(ref("gap"))), "<=", ref("now_ms")), then: [
            s.try_catch({ try: [
              s.function.run({ fn: remindOne, as: "auto", input: { recipient_id: ref("r.id"), actor_type: c.text("system") } }),
              s.update_var("sent", withFilters(ref("sent"), fl.add(c.int(1)))),
            ] }),
          ] }),
        ] }),
      ] }),
    ] }),
  ],
  response: obj({ sent: ref("sent") }),
});

/** Sweep step: envelopes past their deadline expire, everyone who'd heard is told, and the sender is notified. */
export const dueExpiriesFn = defineFunction({
  name: "envelope/due_expiries",
  description: "Expire envelopes past their deadline.",
  stack: [
    s.set_var("now_ms", c.now()),
    s.db.query({ table: envelope, where: [cmp(col("status"), "=", c.text("in_progress")), cmp(col("expires_at"), "!=", c.null()), expr(col("expires_at"), "<=", ref("now_ms"))],
      output: ["id", "title", "sender_id"], paging: { per_page: 100, metadata: false }, as: "late" }),
    s.foreach({ list: ref("late"), as: "env", body: [
      s.try_catch({ try: [
        s.function.run({ fn: envelopeTransition, as: "expired", input: { envelope_id: ref("env.id"), to: c.text("expired"), reason: c.text("The deadline passed."), actor_type: c.text("system") } }),
        ...tellEnded("expired"),
        notify({ to: ref("env.sender_id"), kind: "expired", actor: c.int(0), title: withFilters(ref("env.title"), fl.concat(c.text(" expired before everyone signed"))), link: withFilters(c.text("/documents/"), fl.concat(ref("env.id"))) }),
      ] }),
    ] }),
  ],
  response: obj({ expired: withFilters(ref("late"), fl.count()) }),
});

export const manageFunctions = [voidFn, correctFn, extendFn, remindOne, remindFn, dueRemindersFn, dueExpiriesFn];
