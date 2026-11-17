// Sending what the outbox holds. A row is claimed (queued -> sending) under a row lock before anything is sent, so two drains
// running at once (the one after a request and the minute sweep) can't send the same email twice. Then the drain makes the
// link or code the email carries, renders it, and sends it through Resend.
//
//   queued -> sending -> sent                      a recorded success is final: nothing sends a `sent` row again
//                     -> queued (retry in 1, then 5 minutes) -> failed after the third error
//                     -> skipped                    the email no longer applies (the document ended, the person finished)
//   sending for over 5 minutes -> unknown           no answer came back; it is never resent, so nobody gets it twice
//
// `send_email` doesn't raise on a refusal: it answers `{ status: "error", error }`, so each result is checked.
import { c, caught, cmp, col, defineFunction, env, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { email_outbox } from "../../table/email/email_outbox.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { emailStatusFn } from "./status.js";
import { enqueueFn } from "./outbox.js";
import { LINKED_KINDS, renderFn } from "./templates.js";
import { mintDownloadFn, mintLinkFn, mintOtpFn, revokeLinksFn } from "../signing/links.js";

export const MOST_ATTEMPTS = 3;
/** Minutes to wait after the first and second failed attempt. */
export const BACKOFF_MINUTES = [1, 5] as const;
export const STUCK_MINUTES = 5;
export const DRAIN_BATCH = 20;
/** Resend allows 2 requests a second by default: one send every half second stays under it. */
const SEND_GAP_SECONDS = 0.5;
const NO_APP_URL = "The app's address isn't known yet, so the link in this email can't be built. Open Countersign in a browser once.";
const STUCK_NOTE = "Resend didn't answer, so it isn't known whether this was delivered. It won't be resent automatically, to avoid a duplicate.";

const isIn = (list: readonly string[], v: ReturnType<typeof ref>) => expr(withFilters(c.array([...list]), fl.in(v)), "=", c.bool(true));

/** Take a row for sending, if it's still queued and due. Only one caller can win. */
export const claimFn = defineFunction({
  name: "email/claim",
  description: "Atomically move a due outbox row from queued to sending. Returns whether this caller got it.",
  input: { outbox_id: input.int({ required: true }) },
  stack: [
    s.set_var("claimed", c.bool(false)),
    s.db.transaction({ body: [
      s.db.get({ table: email_outbox, fieldValue: inp("outbox_id"), lock: true, output: ["id", "status", "next_attempt_at"], as: "claim_row" }),
      s.set_var("claim_now", c.now()),
      s.set_var("claim_due", withFilters(ref("claim_row.next_attempt_at", { safe: true }), fl.first_notempty(c.int(0)))),
      s.set_var("claim_status", withFilters(ref("claim_row.status", { safe: true }), fl.first_notnull(c.text("")))),
      s.conditional({ when: expr(c.expression('$var.claim_status == "queued" && $var.claim_due <= $var.claim_now'), "=", c.bool(true)), then: [
        s.db.patch({ table: email_outbox, fieldValue: inp("outbox_id"), data: obj({ status: c.text("sending"), claimed_at: ref("claim_now") }) }),
        s.update_var("claimed", c.bool(true)),
      ] }),
    ] }),
  ],
  response: ref("claimed"),
});

/** Send one outbox row, if this caller can claim it. Answers what happened, with Resend's exact error when there is one. */
export const sendOneFn = defineFunction({
  name: "email/send_one",
  description: "Claim, build and send one queued email, and record the result.",
  input: { outbox_id: input.int({ required: true }), test_key: input.text(), test_from: input.text() },
  stack: [
    s.function.run({ fn: claimFn, as: "got", input: { outbox_id: inp("outbox_id") } }),
    s.set_var("o_status", c.text("")),
    s.set_var("o_error", c.text("")),
    s.set_var("o_resend", c.text("")),
    s.set_var("o_attempted", c.bool(false)),
    s.db.get({ table: email_outbox, fieldValue: inp("outbox_id"), as: "row" }),
    s.update_var("o_status", withFilters(ref("row.status", { safe: true }), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("got"), "=", c.bool(true)), then: [
      guard.found("row", { errorType: "notfound", message: "That email has gone." }),
      s.set_var("row_params", withFilters(ref("row.params"), fl.first_notnull(c.obj({})))),
      s.set_var("row_round", withFilters(ref("row_params"), fl.get(c.text("round"), c.int(0)))),
      s.set_var("row_env", withFilters(ref("row.envelope_id"), fl.first_notempty(c.int(0)))),
      s.set_var("row_rcp", withFilters(ref("row.recipient_id"), fl.first_notempty(c.int(0)))),
      s.function.run({ fn: emailStatusFn, as: "ready", input: { test_key: inp("test_key"), test_from: inp("test_from"), test_webhook: c.text("") } }),
      s.db.get({ table: envelope, fieldValue: ref("row_env"), output: ["id", "status"], as: "o_env" }),
      s.db.get({ table: recipient, fieldValue: ref("row_rcp"), output: ["id", "status", "round"], as: "o_rcp" }),
      // Does this email still apply? An invitation or reminder only while the document is out and the person hasn't acted.
      s.set_var("o_skip", c.text("")),
      s.conditional({ when: isIn(["invite", "reminder"], ref("row.kind")), then: [
        s.conditional({ when: expr(ref("o_env.status", { safe: true }), "!=", c.text("in_progress")), then: [s.update_var("o_skip", c.text("The document is no longer out for signing."))] }),
        s.conditional({ when: isIn(["completed", "declined"], ref("o_rcp.status", { safe: true })), then: [s.update_var("o_skip", c.text("They've already finished."))] }),
        s.conditional({ when: expr(ref("o_rcp.round", { safe: true }), "!=", ref("row_round")), then: [s.update_var("o_skip", c.text("They were sent a newer invitation."))] }),
      ] }),
      s.conditional({ when: expr(c.expression("$var.row_rcp > 0 && $var.o_rcp == null"), "=", c.bool(true)), then: [s.update_var("o_skip", c.text("That person is no longer on the document."))] }),
      s.conditional({
        when: expr(ref("ready.can_send"), "!=", c.bool(true)),
        // Email was switched off after this was queued: it becomes a link to copy.
        then: [
          s.db.patch({ table: email_outbox, fieldValue: inp("outbox_id"), data: obj({ status: c.text("link_only"), claimed_at: c.null(), params: withFilters(ref("row_params"), fl.set(c.text("link_only_reason"), ref("ready.state"))) }) }),
          s.update_var("o_status", c.text("link_only")),
        ],
        elif: [{ when: expr(ref("o_skip"), "!=", c.text("")), then: [
          s.db.patch({ table: email_outbox, fieldValue: inp("outbox_id"), data: obj({ status: c.text("skipped"), claimed_at: c.null(), last_error: ref("o_skip") }) }),
          s.update_var("o_status", c.text("skipped")),
        ] }],
        else: [
          s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["app_url", "email_sender_name", "reply_to"], returnType: "single", as: "o_org" }),
          s.set_var("app_url", withFilters(ref("o_org.app_url", { safe: true }), fl.first_notnull(c.text("")), fl.rtrim(c.text("/")))),
          s.set_var("o_url", c.text("")),
          s.set_var("o_code", c.text("")),
          s.set_var("o_link_id", c.int(0)),
          s.conditional({
            when: expr(c.expression("$var.app_url == \"\""), "=", c.bool(true)),
            then: [s.conditional({ when: isIn(LINKED_KINDS, ref("row.kind")), then: [s.update_var("o_error", c.text(NO_APP_URL))] })],
          }),
          s.conditional({ when: expr(ref("o_error"), "=", c.text("")), then: [
            // The link or code is made now, at send time, and exists only in this email.
            s.conditional({ when: isIn(["invite", "reminder"], ref("row.kind")), then: [
              s.set_var("o_via", c.text("email")),
              s.conditional({ when: expr(ref("row.kind"), "=", c.text("reminder")), then: [s.update_var("o_via", c.text("reminder"))] }),
              s.function.run({ fn: mintLinkFn, as: "o_link", input: { recipient_id: ref("row_rcp"), round: ref("row_round"), via: ref("o_via") } }),
              s.update_var("o_url", ref("o_link.url")),
              s.update_var("o_link_id", ref("o_link.id")),
            ] }),
            s.conditional({ when: expr(ref("row.kind"), "=", c.text("otp")), then: [
              s.function.run({ fn: mintOtpFn, as: "o_otp", input: { otp_id: withFilters(ref("row_params"), fl.get(c.text("otp_id"), c.int(0))), subject: c.text(""), email: c.text("") } }),
              s.update_var("o_code", ref("o_otp.code")),
            ] }),
            s.conditional({ when: expr(ref("row.kind"), "=", c.text("completed")), then: [
              s.function.run({ fn: mintDownloadFn, as: "o_dl", input: { recipient_id: ref("row_rcp") } }),
              s.update_var("o_url", ref("o_dl.url")),
            ] }),
            s.conditional({ when: expr(withFilters(ref("row.kind"), fl.starts_with(c.text("notice_"))), "=", c.bool(true)), then: [
              s.update_var("o_url", withFilters(ref("app_url"), fl.concat(c.text("/envelopes/")), fl.concat(ref("row_env")))),
            ] }),
            s.conditional({ when: expr(ref("row.kind"), "=", c.text("test")), then: [s.update_var("o_url", ref("app_url"))] }),

            s.function.run({ fn: renderFn, as: "mail", input: {
              kind: ref("row.kind"), recipient_id: ref("row_rcp"), envelope_id: ref("row_env"), user_id: ref("row.user_id"),
              to: ref("row.to"), params: ref("row_params"), url: ref("o_url"), code: ref("o_code"),
            } }),
            // From: the configured address, under the organisation's sender name when one is set.
            s.set_var("o_from", withFilters(inp("test_from"), fl.first_notempty(env("RESEND_FROM")), fl.first_notnull(c.text("")), fl.trim())),
            s.set_var("o_name", withFilters(ref("o_org.email_sender_name", { safe: true }), fl.first_notnull(c.text("")))),
            s.update_var("o_name", withFilters(c.regex(/[\\$<>"\r\n,;]/), fl.regex_replace(c.text(""), ref("o_name")), fl.trim())),
            s.set_var("o_from_angle", withFilters(ref("o_from"), fl.contains(c.text("<")))),
            s.conditional({ when: expr(c.expression('$var.o_name != "" && $var.o_from_angle'), "=", c.bool(true)), then: [
              s.set_var("o_from_name", withFilters(ref("o_name"), fl.concat(c.text(" <")))),
              s.update_var("o_from", withFilters(c.regex(/^[^<]*</), fl.regex_replace(ref("o_from_name"), ref("o_from")))),
            ] }),
            s.set_var("o_reply", withFilters(ref("o_org.reply_to", { safe: true }), fl.first_notnull(c.text("")), fl.trim())),
            s.set_var("o_reply_ok", withFilters(c.regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/), fl.regex_test(ref("o_reply")))),
            s.set_var("o_key", withFilters(inp("test_key"), fl.first_notempty(env("RESEND_API_KEY")), fl.first_notnull(c.text("")), fl.trim())),
            s.set_var("sent", obj({ status: c.text("error"), error: c.text("Not sent.") })),
            s.update_var("o_attempted", c.bool(true)),
            s.try_catch({
              try: [s.conditional({
                when: expr(ref("o_reply_ok"), "=", c.bool(true)),
                then: [s.util.send_email({ service_provider: "resend", api_key: ref("o_key"), from: ref("o_from"), to: ref("row.to"), reply_to: ref("o_reply"), subject: ref("mail.subject"), message: ref("mail.html"), as: "sent_reply" }),
                  s.update_var("sent", ref("sent_reply"))],
                else: [s.util.send_email({ service_provider: "resend", api_key: ref("o_key"), from: ref("o_from"), to: ref("row.to"), subject: ref("mail.subject"), message: ref("mail.html"), as: "sent_plain" }),
                  s.update_var("sent", ref("sent_plain"))],
              })],
              catch: [
                s.set_var("o_caught", caught("message")),
                s.update_var("sent", obj({ status: c.text("error"), error: withFilters(c.text("Sending failed: "), fl.concat(ref("o_caught"))) })),
              ],
            }),
            s.conditional({ when: expr(withFilters(ref("sent"), fl.get(c.text("status"), c.text(""))), "=", c.text("error")), then: [
              s.update_var("o_error", withFilters(ref("sent"), fl.get(c.text("error"), c.text("")), fl.first_notempty(c.text("Resend refused the email without saying why.")))),
            ] }),
            s.set_var("o_resend_raw", withFilters(ref("sent"), fl.get(c.text("id"), c.text("")))),
            s.set_var("o_resend_data", withFilters(ref("sent"), fl.get(c.text("data.id"), c.text("")))),
            s.set_var("o_resend_result", withFilters(ref("sent"), fl.get(c.text("result.id"), c.text("")))),
            s.update_var("o_resend", withFilters(ref("o_resend_raw"), fl.first_notempty(ref("o_resend_data")), fl.first_notempty(ref("o_resend_result")), fl.first_notnull(c.text("")), fl.to_text())),
          ] }),

          s.set_var("o_now", c.now()),
          s.set_var("o_attempts", withFilters(ref("row.attempts"), fl.first_notempty(c.int(0)), fl.add(c.int(1)))),
          s.conditional({
            when: expr(ref("o_error"), "=", c.text("")),
            then: [
              s.db.patch({ table: email_outbox, fieldValue: inp("outbox_id"), data: obj({
                status: c.text("sent"), sent_at: ref("o_now"), attempts: ref("o_attempts"), resend_id: ref("o_resend"), last_error: c.text(""), claimed_at: c.null(),
              }) }),
              s.update_var("o_status", c.text("sent")),
            ],
            else: [
              // A link nobody received is no use to anyone: take it back.
              s.conditional({ when: expr(ref("o_link_id"), ">", c.int(0)), then: [
                s.function.run({ fn: revokeLinksFn, as: "o_revoked", input: { recipient_id: ref("row_rcp"), link_id: ref("o_link_id") } }),
              ] }),
              s.set_var("o_wait", c.int(BACKOFF_MINUTES[1] * 60_000)),
              s.conditional({ when: expr(ref("o_attempts"), "<", c.int(2)), then: [s.update_var("o_wait", c.int(BACKOFF_MINUTES[0] * 60_000))] }),
              s.set_var("o_next", withFilters(ref("o_now"), fl.add(ref("o_wait")))),
              s.update_var("o_status", c.text("queued")),
              // A test email answers the person who sent it, now; it doesn't try again behind their back.
              s.conditional({ when: expr(c.expression(`$var.o_attempts >= ${MOST_ATTEMPTS} || $var.row.kind == "test"`), "=", c.bool(true)), then: [s.update_var("o_status", c.text("failed"))] }),
              s.db.patch({ table: email_outbox, fieldValue: inp("outbox_id"), data: obj({
                status: ref("o_status"), attempts: ref("o_attempts"), last_error: ref("o_error"), next_attempt_at: ref("o_next"), claimed_at: c.null(),
              }) }),
            ],
          }),
        ],
      }),
      s.conditional({ when: expr(ref("row_env"), ">", c.int(0)), then: [changed({ entity: "envelope", id: ref("row_env"), op: "updated", actor: c.int(0) })] }),
    ] }),
  ],
  response: obj({ id: inp("outbox_id"), claimed: ref("got"), attempted: ref("o_attempted"), status: ref("o_status"), error: ref("o_error"), resend_id: ref("o_resend") }),
});

/** Send what's due, a batch at a time. Runs after a request that queued mail, and from the minute sweep. */
export const drainFn = defineFunction({
  name: "email/drain",
  description: "Send due queued emails, up to a batch, paced under Resend's rate limit.",
  input: { limit: input.int(), test_key: input.text(), test_from: input.text() },
  stack: [
    s.set_var("d_now", c.now()),
    s.set_var("d_limit", withFilters(inp("limit"), fl.first_notempty(c.int(DRAIN_BATCH)))),
    s.db.query({
      table: email_outbox, where: [cmp(col("status"), "=", c.text("queued")), expr(col("next_attempt_at"), "<=", ref("d_now"))],
      sort: [{ sortBy: "next_attempt_at", dir: "asc" }], output: ["id"], paging: { per_page: ref("d_limit"), metadata: false }, as: "due",
    }),
    s.set_var("d_sent", c.int(0)),
    s.set_var("d_failed", c.int(0)),
    s.set_var("d_paced", c.bool(false)),
    s.foreach({ list: ref("due"), as: "d", body: [
      s.conditional({ when: expr(ref("d_paced"), "=", c.bool(true)), then: [s.util.sleep({ value: c.decimal(SEND_GAP_SECONDS) }), s.update_var("d_paced", c.bool(false))] }),
      s.function.run({ fn: sendOneFn, as: "d_result", input: { outbox_id: ref("d.id"), test_key: inp("test_key"), test_from: inp("test_from") } }),
      s.conditional({ when: expr(ref("d_result.attempted"), "=", c.bool(true)), then: [s.update_var("d_paced", c.bool(true))] }),
      s.conditional({ when: expr(ref("d_result.status"), "=", c.text("sent")), then: [s.update_var("d_sent", withFilters(ref("d_sent"), fl.add(c.int(1))))] }),
      s.conditional({ when: isIn(["queued", "failed"], ref("d_result.status")), then: [s.update_var("d_failed", withFilters(ref("d_failed"), fl.add(c.int(1))))] }),
    ] }),
  ],
  response: obj({ due: withFilters(ref("due"), fl.count()), sent: ref("d_sent"), failed: ref("d_failed") }),
});

/** A row claimed over 5 minutes ago and never answered: whether it went out is unknown, and it is never sent again. */
export const markStuckFn = defineFunction({
  name: "email/mark_stuck",
  description: "Mark emails stuck in sending for over 5 minutes as unknown. They are not resent.",
  stack: [
    s.set_var("stuck_now", c.now()),
    s.set_var("stuck_before", withFilters(ref("stuck_now"), fl.sub(c.int(STUCK_MINUTES * 60_000)))),
    s.db.query({ table: email_outbox, where: [cmp(col("status"), "=", c.text("sending")), expr(col("claimed_at"), "<=", ref("stuck_before"))], output: ["id", "envelope_id"], as: "stuck" }),
    s.foreach({ list: ref("stuck"), as: "st", body: [
      s.db.patch({ table: email_outbox, fieldValue: ref("st.id"), data: obj({ status: c.text("unknown"), last_error: c.text(STUCK_NOTE) }) }),
      s.conditional({ when: expr(ref("st.envelope_id"), ">", c.int(0)), then: [changed({ entity: "envelope", id: ref("st.envelope_id"), op: "updated", actor: c.int(0) })] }),
    ] }),
  ],
  response: obj({ marked: withFilters(ref("stuck"), fl.count()) }),
});


/**
 * The Settings "Send test email" button: one email to the person who pressed it, sent now, with Resend's exact answer.
 * When email isn't set up it says which setting is missing instead of trying.
 */
export const sendTestFn = defineFunction({
  name: "email/send_test",
  description: "Send a test email to a member now and report Resend's result or error.",
  input: { actor_id: input.int({ required: true }), test_key: input.text(), test_from: input.text() },
  stack: [
    s.function.run({ fn: emailStatusFn, as: "t_ready", input: { test_key: inp("test_key"), test_from: inp("test_from"), test_webhook: c.text("") } }),
    s.set_var("t_result", obj({ ok: c.bool(false), state: ref("t_ready.state"), status: c.text("not_sent"), error: c.text(""), resend_id: c.text(""), to: c.text("") })),
    s.conditional({ when: expr(ref("t_ready.can_send"), "=", c.bool(true)), then: [
      s.set_var("t_now", c.now()),
      s.function.run({ fn: enqueueFn, as: "t_row", input: { kind: c.text("test"), user_id: inp("actor_id"), source_id: ref("t_now"), test_key: inp("test_key"), test_from: inp("test_from") } }),
      s.function.run({ fn: sendOneFn, as: "t_sent", input: { outbox_id: ref("t_row.id"), test_key: inp("test_key"), test_from: inp("test_from") } }),
      s.db.get({ table: email_outbox, fieldValue: ref("t_row.id"), output: ["to"], as: "t_out" }),
      s.update_var("t_result", obj({
        ok: c.expression('$var.t_sent.status == "sent"'), state: ref("t_ready.state"), status: ref("t_sent.status"),
        error: ref("t_sent.error"), resend_id: ref("t_sent.resend_id"), to: ref("t_out.to", { safe: true }),
      })),
    ] }),
  ],
  response: ref("t_result"),
});

export const drainFunctions = [claimFn, sendOneFn, drainFn, markStuckFn, sendTestFn];
