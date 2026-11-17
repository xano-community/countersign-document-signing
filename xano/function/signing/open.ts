// A recipient's way in: their link, then any identity check, then consent, then a short signing session. Every step
// answers a state the signing page can show (never an error page), and every step that changes something is on the trail.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { user } from "../../table/user.js";
import { disclosure } from "../../table/signing/disclosure.js";
import { otp_code } from "../../table/signing/otp_code.js";
import { signing_link } from "../../table/signing/signing_link.js";
import { audit } from "../audit/audit.js";
import { recipientTransition } from "../envelope/transition.js";
import { hit } from "../rate/limit.js";
import { otpHashOf } from "./links.js";
import { enqueueFn } from "../email/outbox.js";
import { email_outbox } from "../../table/email/email_outbox.js";

/** How long a signing session lasts. A signer who takes longer opens their link again. */
export const SESSION_SECONDS = 7200;
/** Wrong identity codes allowed in a window before the signer has to wait. */
export const CODE_TRIES = 6;
export const CODE_WINDOW_SECS = 900;

const who = { ip: inp("ip"), ua: inp("user_agent") };
const requestInput = { token: input.text({ required: true }), ip: input.text(), user_agent: input.text() };
const answer = (state: string, extra: Record<string, ReturnType<typeof c.text>> = {}) => s.return(obj({ state: c.text(state), ...extra }));

/**
 * Binds `link`, `rcp` and `env` for a raw link token, or returns the state that explains why there's nothing to sign:
 * `not_found` (unknown), `replaced` (revoked by a correction or a newer link), or the envelope's own ending.
 */
const resolveLink = statements(
  s.set_var("token_hash", withFilters(inp("token"), fl.sha256())),
  s.db.get({ table: signing_link, fieldName: "token_hash", fieldValue: ref("token_hash"), as: "link" }),
  s.conditional({ when: expr(ref("link"), "=", c.null()), then: [answer("not_found")] }),
  s.conditional({ when: expr(ref("link.revoked", { safe: true }), "=", c.bool(true)), then: [answer("replaced")] }),
  s.set_var("link_rid", withFilters(ref("link"), fl.get("recipient_id"))),
  s.db.get({ table: recipient, fieldValue: ref("link_rid"), as: "rcp" }),
  s.conditional({ when: expr(ref("rcp"), "=", c.null()), then: [answer("not_found")] }),
  s.set_var("rcp_eid", withFilters(ref("rcp"), fl.get("envelope_id"))),
  s.db.get({ table: envelope, fieldValue: ref("rcp_eid"), as: "env" }),
  s.conditional({ when: expr(ref("env"), "=", c.null()), then: [answer("not_found")] }),
  s.conditional({ when: expr(ref("link.round", { safe: true }), "!=", ref("rcp.round", { safe: true })), then: [answer("replaced")] }),
);

/** The state a recipient is in on this envelope. `active` means they can sign now; everything else is a page to show. */
const stateOf = statements(
  s.set_var("state", c.text("active")),
  s.conditional({ when: expr(ref("env.status"), "=", c.text("draft")), then: [s.update_var("state", c.text("not_found"))] }),
  s.conditional({ when: expr(ref("env.status"), "=", c.text("voided")), then: [s.update_var("state", c.text("voided"))] }),
  s.conditional({ when: expr(ref("env.status"), "=", c.text("expired")), then: [s.update_var("state", c.text("expired"))] }),
  s.conditional({ when: expr(ref("env.status"), "=", c.text("declined")), then: [s.update_var("state", c.text("declined"))] }),
  s.conditional({ when: expr(ref("env.status"), "=", c.text("sealing")), then: [s.update_var("state", c.text("finishing"))] }),
  s.conditional({ when: expr(ref("env.status"), "=", c.text("completed")), then: [s.update_var("state", c.text("completed"))] }),
  s.conditional({ when: expr(ref("state"), "=", c.text("active")), then: [
    s.conditional({ when: expr(ref("rcp.status"), "=", c.text("completed")), then: [s.update_var("state", c.text("already_signed"))] }),
    s.conditional({ when: expr(ref("rcp.status"), "=", c.text("declined")), then: [s.update_var("state", c.text("declined"))] }),
    s.conditional({ when: expr(ref("rcp.status"), "=", c.text("waiting")), then: [s.update_var("state", c.text("not_your_turn"))] }),
  ] }),
);

/** What the signing page shows around the document: who asked, the organisation's branding, and the envelope's shape. */
const brief = statements(
  s.db.get({ table: user, fieldValue: ref("env.sender_id"), output: ["name", "email"], as: "sender" }),
  s.db.query({ table: org_setting, returnType: "single", output: ["org_name", "logo_data_url", "accent", "reply_to"], as: "org" }),
  // Who's still ahead of this recipient in ordered signing.
  s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("step"), "<", ref("rcp.step")), cmp(col("role"), "!=", c.text("cc")), cmp(col("status"), "!=", c.text("completed"))], output: ["name", "role_name"], as: "ahead" }),
  s.set_var("sender_email", withFilters(ref("sender.email", { safe: true }), fl.first_notnull(c.text("")))),
  // Whether this person gets emails from us, or was handed their link (email not set up): the page words the next step to match.
  s.db.query({ table: email_outbox, where: [cmp(col("recipient_id"), "=", ref("rcp.id")), cmp(col("status"), "=", c.text("link_only"))], returnType: "count", as: "unmailed" }),
  s.set_var("emailed", c.bool(true)),
  s.conditional({ when: expr(ref("unmailed"), ">", c.int(0)), then: [s.update_var("emailed", c.bool(false))] }),
  s.set_var("brief", obj({
    title: ref("env.title"), message: ref("env.message"), public_id: ref("env.public_id"),
    page_count: ref("env.page_count"), pages: ref("env.pages"), status: ref("env.status"), end_reason: ref("env.end_reason"),
    expires_at: ref("env.expires_at"),
    sender_name: ref("sender.name", { safe: true }), sender_email: ref("sender.email", { safe: true }),
    reply_to: withFilters(ref("org.reply_to", { safe: true }), fl.first_notempty(ref("sender_email"))),
    org_name: ref("org.org_name", { safe: true }), logo: ref("org.logo_data_url", { safe: true }), accent: ref("org.accent", { safe: true }),
    recipient: obj({ name: ref("rcp.name"), email: ref("rcp.email"), role: ref("rcp.role"), identity_check: ref("rcp.identity_check") }),
    ahead: ref("ahead"),
    emailed: ref("emailed"),
  })),
);

/** Mint the signer session: a recipient token that names its round, so a correction ends it. */
const mintSession = s.security.create_auth_token({ table: recipient, id: ref("rcp.id"), extras: obj({ kind: c.text("signer"), round: ref("rcp.round") }), expiration: c.int(SESSION_SECONDS), as: "session" });

export const openLink = defineFunction({
  name: "signing/open",
  description: "Open a signing link: say what the recipient sees next, and record the first open.",
  input: requestInput,
  stack: [
    hit(withFilters(c.text("open-ip:"), fl.concat(withFilters(inp("ip"), fl.first_notnull(c.text(""))))), 120, 60, "rate_ip"),
    s.conditional({ when: expr(ref("rate_ip.allowed"), "=", c.bool(false)), then: [s.return(obj({ state: c.text("rate_limited"), retry_after: ref("rate_ip.retry_after") }))] }),
    ...resolveLink,
    ...stateOf,
    ...brief,
    s.conditional({ when: expr(ref("state"), "!=", c.text("active")), then: [s.return(obj({ state: ref("state"), envelope: ref("brief") }))] }),
    // The first open is news; later opens aren't.
    s.conditional({ when: expr(ref("rcp.status"), "=", c.text("sent")), then: [
      s.function.run({ fn: recipientTransition, as: "opened", input: {
        recipient_id: ref("rcp.id"), to: c.text("opened"), actor_type: c.text("recipient"), actor_id: ref("rcp.id"),
        actor_name: ref("rcp.name"), actor_email: ref("rcp.email"), ip: who.ip, user_agent: who.ua,
      } }),
    ] }),
    s.set_var("needs_identity", c.bool(false)),
    s.conditional({ when: and(expr(ref("rcp.identity_check"), "!=", c.text("none")), expr(withFilters(ref("rcp.identity_round"), fl.first_notempty(c.int(0))), "!=", ref("rcp.round"))), then: [s.update_var("needs_identity", c.bool(true))] }),
    s.db.query({ table: disclosure, sort: [{ sortBy: "version", dir: "desc" }], returnType: "single", output: ["version", "text"], as: "current_disclosure" }),
    s.set_var("needs", c.text("ready")),
    s.conditional({ when: expr(ref("rcp.consented_at"), "=", c.null()), then: [s.update_var("needs", c.text("consent"))] }),
    s.conditional({ when: expr(ref("needs_identity"), "=", c.bool(true)), then: [s.update_var("needs", c.text("identity"))] }),
    s.set_var("session", c.null()),
    s.conditional({ when: expr(ref("needs"), "=", c.text("ready")), then: [mintSession] }),
  ],
  response: obj({ state: c.text("active"), needs: ref("needs"), envelope: ref("brief"), disclosure: ref("current_disclosure"), session: ref("session") }),
  responseShape: {} as Record<string, unknown>,
});

/** Check an access code or an emailed code. Wrong codes count, and a run of them makes the signer wait. */
export const verifyIdentity = defineFunction({
  name: "signing/verify_identity",
  description: "Check a recipient's access code or emailed code.",
  input: { ...requestInput, code: input.text({ methods: ["trim"] }) },
  stack: [
    ...resolveLink,
    ...stateOf,
    s.conditional({ when: expr(ref("state"), "!=", c.text("active")), then: [s.return(obj({ state: ref("state") }))] }),
    s.conditional({ when: expr(ref("rcp.identity_check"), "=", c.text("none")), then: [s.return(obj({ state: c.text("active"), ok: c.bool(true) }))] }),
    hit(withFilters(c.text("code:"), fl.concat(ref("rcp.id"))), CODE_TRIES, CODE_WINDOW_SECS, "tries"),
    s.conditional({ when: expr(ref("tries.allowed"), "=", c.bool(false)), then: [s.return(obj({ state: c.text("rate_limited"), retry_after: ref("tries.retry_after") }))] }),
    s.set_var("code_hash", withFilters(inp("code"), fl.first_notnull(c.text("")), fl.sha256())),
    s.set_var("passed", c.bool(false)),
    s.conditional({ when: expr(ref("rcp.identity_check"), "=", c.text("access_code")), then: [
      s.conditional({ when: expr(ref("code_hash"), "=", ref("rcp.access_code_hash")), then: [s.update_var("passed", c.bool(true))] }),
    ] }),
    s.conditional({ when: expr(ref("rcp.identity_check"), "=", c.text("email_code")), then: [
      s.set_var("subject", withFilters(c.text("recipient:"), fl.concat(ref("rcp.id")))),
      s.set_var("now_ms", c.now()),
      s.db.query({ table: otp_code, where: [cmp(col("subject"), "=", ref("subject")), cmp(col("used"), "=", c.bool(false))], sort: [{ sortBy: "id", dir: "desc" }], returnType: "single", as: "otp" }),
      s.conditional({ when: and(
        expr(ref("otp"), "!=", c.null()),
        expr(ref("otp.expires_at", { safe: true }), ">", ref("now_ms")),
        expr(ref("otp.attempts", { safe: true }), "<", c.int(5)),
      ), then: [
        s.set_var("otp_id", withFilters(ref("otp"), fl.get("id"))),
        s.db.increment({ table: otp_code, where: cmp(col("id"), "=", ref("otp_id")), fieldName: "attempts", value: 1, as: "counted" }),
        s.set_var("otp_want", otpHashOf(ref("subject"), withFilters(inp("code"), fl.first_notnull(c.text(""))))),
        s.conditional({ when: expr(ref("otp_want"), "=", ref("otp.code_hash", { safe: true })), then: [
          s.update_var("passed", c.bool(true)),
          s.db.patch({ table: otp_code, fieldValue: ref("otp_id"), data: obj({ used: c.bool(true) }), as: "spent" }),
        ] }),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("passed"), "=", c.bool(false)), then: [
      audit({ envelope: ref("env.id"), kind: "recipient.identity_failed", actor: { type: c.text("recipient"), id: ref("rcp.id"), name: ref("rcp.name"), email: ref("rcp.email"), ip: who.ip, ua: who.ua }, data: obj({ method: ref("rcp.identity_check") }) }),
      s.return(obj({ state: c.text("wrong_code"), tries_left: withFilters(c.int(CODE_TRIES), fl.sub(ref("tries.count")), fl.to_int()) })),
    ] }),
    s.set_var("checked_at", c.now()),
    s.db.patch({ table: recipient, fieldValue: ref("rcp.id"), data: obj({ identity_checked_at: ref("checked_at"), identity_round: ref("rcp.round") }), as: "checked" }),
    audit({ envelope: ref("env.id"), kind: "recipient.identity_checked", actor: { type: c.text("recipient"), id: ref("rcp.id"), name: ref("rcp.name"), email: ref("rcp.email"), ip: who.ip, ua: who.ua }, data: obj({ method: ref("rcp.identity_check") }) }),
    changed({ entity: "envelope", id: ref("env.id"), actor: c.int(0) }),
  ],
  response: obj({ state: c.text("active"), ok: c.bool(true) }),
  responseShape: {} as Record<string, unknown>,
});

/** Accept the electronic records disclosure, and start a signing session. */
export const giveConsent = defineFunction({
  name: "signing/consent",
  description: "Record a recipient's consent to sign electronically, and open their signing session.",
  input: { ...requestInput, disclosure_version: input.int({ required: true }), agree: input.bool() },
  stack: [
    ...resolveLink,
    ...stateOf,
    s.conditional({ when: expr(ref("state"), "!=", c.text("active")), then: [s.return(obj({ state: ref("state") }))] }),
    guard.require(expr(inp("agree"), "=", c.bool(true)), { errorType: "badrequest", message: "Tick the box to agree before you continue." }),
    s.conditional({ when: and(expr(ref("rcp.identity_check"), "!=", c.text("none")), expr(withFilters(ref("rcp.identity_round"), fl.first_notempty(c.int(0))), "!=", ref("rcp.round"))), then: [
      s.return(obj({ state: c.text("active"), needs: c.text("identity") })),
    ] }),
    s.db.get({ table: disclosure, fieldName: "version", fieldValue: inp("disclosure_version"), output: ["version"], as: "shown" }),
    guard.found("shown", { errorType: "badrequest", message: "The disclosure has changed. Reload the page to read the current one." }),
    s.conditional({ when: expr(ref("rcp.consented_at"), "=", c.null()), then: [
      s.set_var("consented", c.now()),
      s.db.patch({ table: recipient, fieldValue: ref("rcp.id"), data: obj({ consented_at: ref("consented"), disclosure_version: inp("disclosure_version"), ip: who.ip, user_agent: who.ua }), as: "agreed" }),
      audit({ envelope: ref("env.id"), kind: "recipient.consented", actor: { type: c.text("recipient"), id: ref("rcp.id"), name: ref("rcp.name"), email: ref("rcp.email"), ip: who.ip, ua: who.ua }, data: obj({ disclosure_version: inp("disclosure_version") }) }),
    ] }),
    mintSession,
    changed({ entity: "envelope", id: ref("env.id"), actor: c.int(0) }),
  ],
  response: obj({ state: c.text("active"), needs: c.text("ready"), session: ref("session") }),
  responseShape: {} as Record<string, unknown>,
});

/** Email a six-digit code to a recipient whose identity check is an emailed code. At most three an hour per person. */
export const sendCode = defineFunction({
  name: "signing/send_code",
  description: "Email a recipient a one-time code.",
  input: requestInput,
  stack: [
    ...resolveLink,
    ...stateOf,
    s.conditional({ when: expr(ref("state"), "!=", c.text("active")), then: [s.return(obj({ state: ref("state") }))] }),
    guard.require(expr(ref("rcp.identity_check"), "=", c.text("email_code")), { errorType: "badrequest", message: "This document doesn't ask for an emailed code." }),
    hit(withFilters(c.text("otp-send:"), fl.concat(ref("rcp.id"))), 3, 3600, "sends"),
    s.conditional({ when: expr(ref("sends.allowed"), "=", c.bool(false)), then: [s.return(obj({ state: c.text("rate_limited"), retry_after: ref("sends.retry_after") }))] }),
    s.set_var("subject", withFilters(c.text("recipient:"), fl.concat(ref("rcp.id")))),
    // Earlier codes stop working: only the newest one counts.
    s.db.add({ table: otp_code, row: { subject: ref("subject"), email: ref("rcp.email"), code_hash: c.null(), attempts: c.int(0), used: c.bool(false) }, as: "otp_row" }),
    s.function.run({ fn: enqueueFn, as: "queued", input: { kind: c.text("otp"), otp_id: ref("otp_row.id"), recipient_id: ref("rcp.id"), envelope_id: ref("env.id") } }),
    audit({ envelope: ref("env.id"), kind: "recipient.code_sent", actor: { type: c.text("recipient"), id: ref("rcp.id"), name: ref("rcp.name"), email: ref("rcp.email"), ip: who.ip, ua: who.ua } }),
  ],
  response: obj({ state: c.text("active"), sent_to: ref("rcp.email") }),
  responseShape: {} as Record<string, unknown>,
});

export const openFunctions = [openLink, verifyIdentity, giveConsent, sendCode];
