// Secrets that reach a person by email or on screen: signing links, one-time codes and download links. Each is random, only its
// SHA-256 is stored, and the raw value is returned once to the caller that sends or shows it. Nothing else keeps it: not the
// outbox, not the audit trail, not a log.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { recipient } from "../../table/envelope/recipient.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { signing_link } from "../../table/signing/signing_link.js";
import { otp_code } from "../../table/signing/otp_code.js";
import { audit } from "../audit/audit.js";

/** Where the frontend opens a signing link and a download link: `{app_url}{path}{token}`. */
export const SIGN_PATH = "/sign/";
export const DOWNLOAD_PATH = "/signed/";
export const OTP_MINUTES = 10;
const NO_APP_URL = "The app's address isn't known yet. Open Countersign in a browser once, then try again.";

/** A 32-byte random token, url-safe base64 without padding. Binds `<as>`. */
const randomToken = (as: string) => [
  s.security.random_bytes({ length: c.int(32), as: `${as}_raw` }),
  s.set_var(as, withFilters(ref(`${as}_raw`), fl.base64_encode_urlsafe(), fl.rtrim(c.text("=")))),
] as const;

/** The app's public address, from the one settings row. Binds `app_url` ("" when unknown). */
const bindAppUrl = [
  s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["app_url"], returnType: "single", as: "app_row" }),
  s.set_var("app_url", withFilters(ref("app_row.app_url", { safe: true }), fl.first_notnull(c.text("")), fl.rtrim(c.text("/")))),
] as const;

/** How a one-time code is stored: SHA-256 of the subject and the code, so a code only matches the request it was sent for. */
export const otpHashOf = (subject: Value, code: Value) =>
  withFilters(subject, fl.first_notnull(c.text("")), fl.concat(c.text(":")), fl.concat(code), fl.sha256());

export const mintLinkFn = defineFunction({
  name: "signing/mint_link",
  description: "Make a new signing link for a recipient. Stores only its hash; returns the URL once.",
  input: {
    recipient_id: input.int({ required: true }), round: input.int(), via: input.text(),
    /** Answer the link as a path ("/sign/…") for the caller's own origin, without needing the app's address. */
    path_only: input.bool(),
  },
  stack: [
    s.db.get({ table: recipient, fieldValue: inp("recipient_id"), output: ["id", "envelope_id", "round", "email"], as: "link_rcp" }),
    guard.found("link_rcp", { errorType: "notfound", message: "That person isn't on this document." }),
    ...bindAppUrl,
    s.conditional({ when: expr(inp("path_only"), "=", c.bool(true)), then: [s.update_var("app_url", c.text(""))], else: [
      guard.require(expr(ref("app_url"), "!=", c.text("")), { errorType: "badrequest", message: NO_APP_URL }),
    ] }),
    ...randomToken("token"),
    s.set_var("link_round", withFilters(inp("round"), fl.first_notempty(ref("link_rcp.round")))),
    s.set_var("link_via", withFilters(inp("via"), fl.first_notempty(c.text("copied")))),
    s.db.add({ table: signing_link, row: {
      recipient_id: inp("recipient_id"), token_hash: withFilters(ref("token"), fl.sha256()), round: ref("link_round"), via: ref("link_via"), revoked: c.bool(false),
    }, as: "link" }),
    // The demo's "See what a signer sees" makes a link on every click; those stay off the trail so it reads like a real one.
    s.conditional({ when: expr(ref("link_via"), "!=", c.text("demo")), then: [
      audit({
        envelope: ref("link_rcp.envelope_id"), kind: "link.created",
        data: obj({ recipient_id: inp("recipient_id"), recipient_email: ref("link_rcp.email"), round: ref("link_round"), via: ref("link_via"), link_id: ref("link.id") }),
      }),
    ] }),
  ],
  response: { id: ref("link.id"), url: withFilters(ref("app_url"), fl.concat(c.text(SIGN_PATH)), fl.concat(ref("token"))) },
});

export const revokeLinksFn = defineFunction({
  name: "signing/revoke_links",
  description: "Revoke every signing link a recipient has, or one of them when `link_id` is given.",
  input: { recipient_id: input.int({ required: true }), link_id: input.int() },
  stack: [
    s.db.query({ table: signing_link, where: [cmp(col("recipient_id"), "=", inp("recipient_id")), cmp(col("revoked"), "!=", c.bool(true))], output: ["id"], as: "live_links" }),
    s.set_var("revoked", c.int(0)),
    s.foreach({ list: ref("live_links"), as: "l", body: [
      s.conditional({ when: expr(c.expression("$input.link_id == null || $input.link_id == 0 || $input.link_id == $var.l.id"), "=", c.bool(true)), then: [
        s.db.patch({ table: signing_link, fieldValue: ref("l.id"), data: obj({ revoked: c.bool(true) }) }),
        s.update_var("revoked", withFilters(ref("revoked"), fl.add(c.int(1)))),
      ] }),
    ] }),
  ],
  response: { revoked: ref("revoked") },
});

/**
 * Give a one-time code row a fresh six-digit code, valid for 10 minutes with five tries. `otp_id` names a row the caller made
 * when the code was asked for (its subject and email set, no hash yet); without one, a new row is made from `subject`/`email`.
 * Checking a code: `otpHashOf(subject, entered)` equals `code_hash`, the row is unused, unexpired and under five attempts.
 */
export const mintOtpFn = defineFunction({
  name: "signing/mint_otp",
  description: "Set a fresh one-time code on a code row. Stores only its hash; returns the code once.",
  input: { otp_id: input.int(), subject: input.text(), email: input.text() },
  stack: [
    s.security.random_number({ min: c.int(0), max: c.int(999_999), as: "otp_n" }),
    // Six digits, leading zeros kept: 1,000,000 + n, then drop the leading 1.
    s.set_var("code", withFilters(ref("otp_n"), fl.add(c.int(1_000_000)), fl.to_text(), fl.substr(c.int(1), c.int(6)))),
    s.set_var("otp_now", c.now()),
    s.set_var("otp_expires", withFilters(ref("otp_now"), fl.add(c.int(OTP_MINUTES * 60_000)))),
    s.set_var("otp_row_id", withFilters(inp("otp_id"), fl.first_notempty(c.int(0)))),
    s.conditional({
      when: expr(ref("otp_row_id"), ">", c.int(0)),
      then: [
        s.db.get({ table: otp_code, fieldValue: ref("otp_row_id"), output: ["id", "subject"], as: "otp_row" }),
        guard.found("otp_row", { errorType: "notfound", message: "That code request has gone. Ask for a new code." }),
        s.db.patch({ table: otp_code, fieldValue: ref("otp_row_id"), data: obj({
          code_hash: otpHashOf(ref("otp_row.subject"), ref("code")), expires_at: ref("otp_expires"), attempts: c.int(0), used: c.bool(false),
        }) }),
      ],
      else: [
        guard.require(expr(inp("subject"), "!=", c.text("")), { errorType: "badrequest", message: "A code needs a subject." }),
        s.db.add({ table: otp_code, row: {
          subject: inp("subject"), email: inp("email"), code_hash: otpHashOf(inp("subject"), ref("code")), expires_at: ref("otp_expires"), attempts: c.int(0), used: c.bool(false),
        }, as: "otp_new" }),
        s.update_var("otp_row_id", ref("otp_new.id")),
      ],
    }),
  ],
  response: { id: ref("otp_row_id"), code: ref("code"), expires_at: ref("otp_expires") },
});

/** A recipient's personal link to the signed PDF and certificate. A new one replaces the last (one hash per recipient). */
export const mintDownloadFn = defineFunction({
  name: "signing/mint_download",
  description: "Make a recipient's download link for the signed document. Stores only its hash; returns the URL once.",
  input: { recipient_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: recipient, fieldValue: inp("recipient_id"), output: ["id"], as: "dl_rcp" }),
    guard.found("dl_rcp", { errorType: "notfound", message: "That person isn't on this document." }),
    ...bindAppUrl,
    guard.require(expr(ref("app_url"), "!=", c.text("")), { errorType: "badrequest", message: NO_APP_URL }),
    ...randomToken("dl_token"),
    s.db.patch({ table: recipient, fieldValue: inp("recipient_id"), data: obj({ download_hash: withFilters(ref("dl_token"), fl.sha256()) }) }),
  ],
  response: { url: withFilters(ref("app_url"), fl.concat(c.text(DOWNLOAD_PATH)), fl.concat(ref("dl_token"))) },
});

export const linkFunctions = [mintLinkFn, revokeLinksFn, mintOtpFn, mintDownloadFn];
