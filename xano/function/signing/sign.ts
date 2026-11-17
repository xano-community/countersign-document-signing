// Signing, inside a signer session. Every call passes the signer gate first: the session must be a signer's, from the
// recipient's current round, on an envelope still in progress, and the recipient must not have finished or declined. A
// correction, a decline by someone else, or a void ends an open session at its next call.
import { and, auth, c, cmp, col, defineFunction, expr, fl, guard, inp, input, middleware, obj, or, ref, s, statements, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { notify } from "../../base/functions.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { field } from "../../table/envelope/field.js";
import { signature } from "../../table/signing/signature.js";
import { audit } from "../audit/audit.js";
import { envelopeTransition, recipientTransition } from "../envelope/transition.js";
import { requireDrawable } from "./charset.js";
import { enqueueFn } from "../email/outbox.js";

/** The largest adopted signature image, in bytes. */
export const MOST_SIGNATURE_BYTES = 200 * 1024;
const MOST_TEXT = 500;

export const signerGate = middleware({
  name: "signing/gate",
  exceptionPolicy: "rethrow",
  description: "Refuses a signer session that's no longer current.",
  stack: [
    guard.require(expr(auth("extras.kind"), "=", c.text("signer")), { errorType: "unauthorized", message: "This link has ended. Open your signing link again." }),
    s.db.get({ table: recipient, fieldValue: auth("id"), output: ["id", "round", "status", "envelope_id"], as: "gate_rcp" }),
    guard.found("gate_rcp", { errorType: "unauthorized", message: "This link no longer works. Check your email for a newer one, or ask the sender." }),
    guard.require(expr(ref("gate_rcp.round"), "=", auth("extras.round")), { errorType: "unauthorized", message: "This link no longer works. Check your email for a newer one, or ask the sender." }),
    s.db.get({ table: envelope, fieldValue: ref("gate_rcp.envelope_id"), output: ["status"], as: "gate_env" }),
    guard.require(expr(ref("gate_env.status", { safe: true }), "=", c.text("in_progress")), { errorType: "unauthorized", message: "This document has changed since you opened it. Open your signing link again to see where it stands." }),
    guard.require(or(expr(ref("gate_rcp.status"), "=", c.text("sent")), expr(ref("gate_rcp.status"), "=", c.text("opened"))), { errorType: "unauthorized", message: "You've already finished with this document." }),
  ],
});

const signerInput = { recipient_id: input.int({ required: true }), ip: input.text(), user_agent: input.text() };
const loadSigner = statements(
  s.db.get({ table: recipient, fieldValue: inp("recipient_id"), as: "rcp" }),
  guard.found("rcp", { errorType: "unauthorized", message: "This link no longer works." }),
  s.db.get({ table: envelope, fieldValue: ref("rcp.envelope_id"), as: "env" }),
  guard.found("env", { errorType: "notfound", message: "That document doesn't exist." }),
);
const asSigner = () => ({ type: c.text("recipient"), id: ref("rcp.id"), name: ref("rcp.name"), email: ref("rcp.email"), ip: inp("ip"), ua: inp("user_agent") });

/** Everything the signing page draws: the envelope, my fields with their values, others' fields already filled, my adopted marks. */
export const signerState = defineFunction({
  name: "signing/state",
  description: "What a signer sees: the document's pages, their fields, and what others have filled in.",
  input: signerInput,
  stack: [
    ...loadSigner,
    s.db.query({ table: field, where: cmp(col("recipient_id"), "=", ref("rcp.id")), sort: [{ sortBy: "page", dir: "asc" }, { sortBy: "y", dir: "asc" }, { sortBy: "x", dir: "asc" }], as: "mine" }),
    s.db.query({ table: field, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("recipient_id"), "!=", ref("rcp.id")), cmp(col("filled_at"), "!=", c.null())],
      bind: [{ table: recipient, as: "owner", join: "left", where: expr(col("recipient_id"), "=", col("owner.id")) }],
      eval: [{ name: "owner.name", as: "owner_name" }],
      output: ["id", "type", "page", "x", "y", "w", "h", "value", "owner_name"], as: "others" }),
    s.db.query({ table: signature, where: cmp(col("recipient_id"), "=", ref("rcp.id")), output: ["kind", "method", "png_b64"], as: "marks" }),
  ],
  response: obj({
    title: ref("env.title"), public_id: ref("env.public_id"), page_count: ref("env.page_count"), pages: ref("env.pages"),
    recipient: obj({ id: ref("rcp.id"), name: ref("rcp.name"), email: ref("rcp.email"), role: ref("rcp.role") }),
    fields: ref("mine"), others: ref("others"), marks: ref("marks"),
  }),
});

/** Fill one of my fields. Names, emails and dates fill themselves at the end; signatures take the adopted mark. */
export const fillField = defineFunction({
  name: "signing/fill",
  description: "Save a signer's value for one of their fields.",
  input: { ...signerInput, field_id: input.int({ required: true }), value: input.text() },
  stack: [
    ...loadSigner,
    s.db.get({ table: field, fieldValue: inp("field_id"), as: "fd" }),
    guard.found("fd", { errorType: "notfound", message: "That field isn't on this document." }),
    guard.require(expr(ref("fd.recipient_id"), "=", ref("rcp.id")), { errorType: "notfound", message: "That field isn't on this document." }),
    s.set_var("v", withFilters(inp("value"), fl.first_notnull(c.text("")))),
    s.set_var("max_len", withFilters(ref("fd.validation"), fl.get("max_length"), fl.first_notempty(c.int(MOST_TEXT)), fl.to_int())),
    guard.require(expr(withFilters(c.array(["name", "email", "date"]), fl.in(ref("fd.type"))), "=", c.bool(false)), { errorType: "badrequest", message: "This field fills itself in when you finish." }),
    s.conditional({ when: expr(withFilters(c.array(["signature", "initials"]), fl.in(ref("fd.type"))), "=", c.bool(true)), then: [
      s.db.query({ table: signature, where: [cmp(col("recipient_id"), "=", ref("rcp.id")), cmp(col("kind"), "=", ref("fd.type"))], returnType: "count", as: "has_mark" }),
      s.conditional({ when: expr(ref("v"), "!=", c.text("")), then: [
        guard.require(expr(ref("has_mark"), ">", c.int(0)), { errorType: "badrequest", message: "Adopt your signature first." }),
        s.update_var("v", c.text("adopted")),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("fd.type"), "=", c.text("text")), then: [
      guard.require(expr(withFilters(ref("v"), fl.strlen()), "<=", ref("max_len")), { errorType: "badrequest", message: "That's longer than this field allows." }),
      requireDrawable(ref("v")),
    ] }),
    s.conditional({ when: and(expr(ref("fd.type"), "=", c.text("number")), expr(ref("v"), "!=", c.text(""))), then: [
      guard.require(expr(withFilters(c.regex(/^-?\d+(\.\d+)?$/), fl.regex_test(ref("v"))), "=", c.bool(true)), { errorType: "badrequest", message: "Enter a number." }),
      s.set_var("num", withFilters(ref("v"), fl.to_decimal())),
      s.set_var("num_min", withFilters(ref("fd.validation"), fl.get("min"))),
      s.set_var("num_max", withFilters(ref("fd.validation"), fl.get("max"))),
      s.conditional({ when: expr(ref("num_min"), "!=", c.null()), then: [guard.require(expr(ref("num"), ">=", ref("num_min")), { errorType: "badrequest", message: "That number is below this field's minimum." })] }),
      s.conditional({ when: expr(ref("num_max"), "!=", c.null()), then: [guard.require(expr(ref("num"), "<=", ref("num_max")), { errorType: "badrequest", message: "That number is above this field's maximum." })] }),
    ] }),
    s.conditional({ when: expr(ref("fd.type"), "=", c.text("checkbox")), then: [
      guard.require(expr(withFilters(c.array(["", "true", "false"]), fl.in(ref("v"))), "=", c.bool(true)), { errorType: "badrequest", message: "Tick or untick the box." }),
    ] }),
    s.conditional({ when: and(expr(withFilters(c.array(["radio", "dropdown"]), fl.in(ref("fd.type"))), "=", c.bool(true)), expr(ref("v"), "!=", c.text(""))), then: [
      guard.require(expr(withFilters(ref("fd.options"), fl.first_notnull(c.array([])), fl.in(ref("v"))), "=", c.bool(true)), { errorType: "badrequest", message: "Pick one of the choices." }),
    ] }),
    s.set_var("filled", c.null()),
    s.conditional({ when: and(expr(ref("v"), "!=", c.text("")), expr(ref("v"), "!=", c.text("false"))), then: [s.update_var("filled", c.now())] }),
    s.conditional({ when: expr(ref("v"), "=", c.text("")), then: [s.update_var("v", c.null())] }),
    s.db.patch({ table: field, fieldValue: ref("fd.id"), data: obj({ value: ref("v"), filled_at: ref("filled") }), as: "saved" }),
    // The sender's open page follows along as the signer works (ids only; no activity row).
    changed({ entity: "envelope", id: ref("fd.envelope_id"), actor: c.int(0) }),
  ],
  response: ref("saved"),
});

/** Adopt a signature or initials: a PNG or JPEG drawn, typed or uploaded in the browser, at most 200 KB. */
export const adoptMark = defineFunction({
  name: "signing/adopt",
  description: "Save the signature or initials a signer adopted.",
  input: { ...signerInput, kind: input.text({ required: true }), method: input.text({ required: true }), png_b64: input.text({ required: true }) },
  stack: [
    ...loadSigner,
    guard.require(expr(withFilters(c.array(["signature", "initials"]), fl.in(inp("kind"))), "=", c.bool(true)), { errorType: "badrequest", message: "Adopt a signature or initials." }),
    guard.require(expr(withFilters(c.array(["typed", "drawn", "uploaded"]), fl.in(inp("method"))), "=", c.bool(true)), { errorType: "badrequest", message: "Type, draw or upload your signature." }),
    // A data URL's "data:image/png;base64," prefix is dropped: only the base64 is kept.
    s.set_var("img_in", withFilters(inp("png_b64"), fl.first_notnull(c.text("")))),
    s.set_var("img", withFilters(c.text("/^data:image\\/[a-z+.-]+;base64,/"), fl.regex_replace(c.text(""), ref("img_in")))),
    s.set_var("raw", withFilters(ref("img"), fl.base64_decode())),
    s.set_var("size", withFilters(ref("raw"), fl.strlen())),
    guard.require(expr(ref("size"), ">", c.int(0)), { errorType: "badrequest", message: "That image is empty." }),
    guard.require(expr(ref("size"), "<=", c.int(MOST_SIGNATURE_BYTES)), { errorType: "badrequest", message: "That image is too large. Use one under 200 KB." }),
    // The file's own first bytes, read through its base64: PNG begins "iVBORw0KGgo", JPEG "/9j/".
    guard.require(expr(withFilters(c.regex(/^(iVBORw0KGgo|\/9j\/)/), fl.regex_test(ref("img"))), "=", c.bool(true)), { errorType: "badrequest", message: "Use a PNG or JPEG image." }),
    s.db.query({ table: signature, where: [cmp(col("recipient_id"), "=", ref("rcp.id")), cmp(col("kind"), "=", inp("kind"))], returnType: "single", output: ["id"], as: "had" }),
    s.conditional({ when: expr(ref("had"), "!=", c.null()), then: [
      s.set_var("had_id", withFilters(ref("had"), fl.get("id"))),
      s.db.patch({ table: signature, fieldValue: ref("had_id"), data: obj({ method: inp("method"), png_b64: ref("img") }), as: "mark" }),
    ], else: [
      s.db.add({ table: signature, row: { recipient_id: ref("rcp.id"), kind: inp("kind"), method: inp("method"), png_b64: ref("img") }, as: "mark" }),
    ] }),
    audit({ envelope: ref("env.id"), kind: withFilters(c.text("recipient.adopted_"), fl.concat(inp("kind"))), actor: asSigner(), data: obj({ method: inp("method"), bytes: ref("size") }) }),
    changed({ entity: "envelope", id: ref("env.id"), actor: c.int(0) }),
  ],
  response: obj({ kind: inp("kind"), method: inp("method") }),
});

/**
 * Finish: the signer confirms they mean it. Required fields must be filled; names, emails and dates fill in now. A second
 * finish answers the same without a second event. Then the envelope moves on (the next signer, or finishing).
 */
export const finishSigning = defineFunction({
  name: "signing/finish",
  description: "Complete a recipient's part of an envelope.",
  input: { ...signerInput, agree: input.bool(), timezone: input.text() },
  stack: [
    ...loadSigner,
    s.conditional({ when: expr(ref("rcp.status"), "=", c.text("completed")), then: [s.return(obj({ ok: c.bool(true), already: c.bool(true), envelope_id: ref("env.id") }))] }),
    guard.require(expr(inp("agree"), "=", c.bool(true)), { errorType: "badrequest", message: "Confirm that you agree to sign." }),
    s.db.query({ table: field, where: cmp(col("recipient_id"), "=", ref("rcp.id")), as: "mine" }),
    s.set_var("today", withFilters(c.now(), fl.epochms_date(c.text("j M Y"), withFilters(inp("timezone"), fl.first_notempty(c.text("UTC")))))),
    s.foreach({ list: ref("mine"), as: "fd", body: [
      s.conditional({ when: expr(ref("fd.type"), "=", c.text("name")), then: [s.db.patch({ table: field, fieldValue: ref("fd.id"), data: obj({ value: ref("rcp.name"), filled_at: c.now() }), as: "auto" })] }),
      s.conditional({ when: expr(ref("fd.type"), "=", c.text("email")), then: [s.db.patch({ table: field, fieldValue: ref("fd.id"), data: obj({ value: ref("rcp.email"), filled_at: c.now() }), as: "auto" })] }),
      s.conditional({ when: expr(ref("fd.type"), "=", c.text("date")), then: [s.db.patch({ table: field, fieldValue: ref("fd.id"), data: obj({ value: ref("today"), filled_at: c.now() }), as: "auto" })] }),
      s.conditional({ when: and(expr(ref("fd.required"), "=", c.bool(true)), expr(withFilters(c.array(["name", "email", "date"]), fl.in(ref("fd.type"))), "=", c.bool(false)), expr(ref("fd.filled_at"), "=", c.null())), then: [
        s.set_var("missing_label", withFilters(ref("fd.label"), fl.first_notempty(ref("fd.type")))),
        guard.require(expr(c.bool(false), "=", c.bool(true)), { errorType: "badrequest", message: "Fill in every required field before you finish." }),
      ] }),
    ] }),
    s.db.query({ table: signature, where: cmp(col("recipient_id"), "=", ref("rcp.id")), output: ["kind"], as: "marks" }),
    s.function.run({ fn: recipientTransition, as: "done", input: {
      recipient_id: ref("rcp.id"), to: c.text("completed"), kind: withFilters(c.text("recipient."), fl.concat(withFilters(ref("rcp.role"), fl.string_replace(c.text("signer"), c.text("signed")), fl.string_replace(c.text("approver"), c.text("approved")), fl.string_replace(c.text("viewer"), c.text("viewed"))))),
      actor_type: c.text("recipient"), actor_id: ref("rcp.id"), actor_name: ref("rcp.name"), actor_email: ref("rcp.email"), ip: inp("ip"), user_agent: inp("user_agent"),
      data: obj({ fields: withFilters(ref("mine"), fl.count()), marks: withFilters(ref("marks"), fl.count()) }),
    } }),
  ],
  response: obj({ ok: c.bool(true), already: c.bool(false), envelope_id: ref("env.id") }),
  responseShape: {} as { ok: boolean; already: boolean; envelope_id: number },
});

/** Decline (or, for an approver, reject): it ends the envelope for everyone and tells the sender why. */
export const declineSigning = defineFunction({
  name: "signing/decline",
  description: "A recipient declines; the envelope ends.",
  input: { ...signerInput, reason: input.text({ methods: ["trim"] }) },
  stack: [
    ...loadSigner,
    guard.require(expr(withFilters(inp("reason"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Tell the sender why, so they can fix it." }),
    guard.require(expr(withFilters(inp("reason"), fl.strlen()), "<=", c.int(1000)), { errorType: "badrequest", message: "Keep the reason under 1,000 characters." }),
    requireDrawable(inp("reason")),
    s.set_var("verb", c.text("recipient.declined")),
    s.conditional({ when: expr(ref("rcp.role"), "=", c.text("approver")), then: [s.update_var("verb", c.text("recipient.rejected"))] }),
    s.function.run({ fn: recipientTransition, as: "declined", input: {
      recipient_id: ref("rcp.id"), to: c.text("declined"), kind: ref("verb"), reason: inp("reason"),
      actor_type: c.text("recipient"), actor_id: ref("rcp.id"), actor_name: ref("rcp.name"), actor_email: ref("rcp.email"), ip: inp("ip"), user_agent: inp("user_agent"),
    } }),
    s.function.run({ fn: envelopeTransition, as: "ended", input: {
      envelope_id: ref("env.id"), to: c.text("declined"), reason: inp("reason"),
      actor_type: c.text("recipient"), actor_id: ref("rcp.id"), actor_name: ref("rcp.name"), actor_email: ref("rcp.email"), ip: inp("ip"), user_agent: inp("user_agent"),
    } }),
    // Everyone who'd already heard about it is told it ended; the sender gets the reason.
    s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("id"), "!=", ref("rcp.id")), cmp(col("status"), "!=", c.text("waiting"))], output: ["id"], as: "told" }),
    s.foreach({ list: ref("told"), as: "t", body: [
      s.function.run({ fn: enqueueFn, as: "q_told", input: { kind: c.text("declined"), recipient_id: ref("t.id"), envelope_id: ref("env.id"), params: obj({ by_name: ref("rcp.name") }) } }),
    ] }),
    s.function.run({ fn: enqueueFn, as: "q_sender", input: { kind: c.text("notice_declined"), recipient_id: c.int(0), user_id: ref("env.sender_id"), source_id: ref("env.id"), envelope_id: ref("env.id"), params: obj({ by_name: ref("rcp.name") }) } }),
    notify({ to: ref("env.sender_id"), kind: "declined", actor: c.int(0),
      title: withFilters(ref("rcp.name"), fl.concat(c.text(" declined ")), fl.concat(ref("env.title"))),
      body: inp("reason"), link: withFilters(c.text("/documents/"), fl.concat(ref("env.id"))) }),
  ],
  response: obj({ ok: c.bool(true), envelope_id: ref("env.id") }),
});

export const signFunctions = [signerState, fillField, adoptMark, finishSigning, declineSigning];
