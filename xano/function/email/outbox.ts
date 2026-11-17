// Every email starts here. `enqueue` writes one outbox row, keyed by what the email is for, so asking twice (a double click,
// a retried request, two background runs) leaves one row. The row holds the kind and plain parameters only: the drain renders
// the email, and makes any link or code, when it actually sends.
//
// A row is written as `link_only` instead of `queued`, and never sent, when:
//   - email isn't set up (no Resend key or no From address): the sender copies the link instead;
//   - the envelope is a seeded demo envelope;
//   - demo mode is on and the address isn't an active team member's, so a public demo can't email strangers.
//
// Call it outside a database transaction: a duplicate is caught as a failed insert, which a transaction can't recover from.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { email_outbox } from "../../table/email/email_outbox.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { otp_code } from "../../table/signing/otp_code.js";
import { user } from "../../table/user.js";
import { emailStatusFn } from "./status.js";
import { EMAIL_KINDS, MEMBER_KINDS, RECIPIENT_KINDS } from "./templates.js";

const isIn = (list: readonly string[], v: ReturnType<typeof inp>) => expr(withFilters(c.array([...list]), fl.in(v)), "=", c.bool(true));

export const enqueueFn = defineFunction({
  name: "email/enqueue",
  description: "Queue one email, once. A repeat with the same purpose is a no-op. Decides between sending and link-only.",
  input: {
    kind: input.text({ required: true }),
    /** Recipient mail (invite, reminder, completed, declined, voided, expired): the recipient. Their current round is used. */
    recipient_id: input.int(),
    /** A reminder's number for this recipient and round: each reminder is its own email. */
    n: input.int(),
    /** A one-time code: the otp_code row the caller made for the request. */
    otp_id: input.int(),
    /** Member mail: the member, and what the email is about (an envelope id, an outbox id, a timestamp for a test). */
    user_id: input.int(), source_id: input.int(),
    envelope_id: input.int(),
    /** Plain, non-secret details the email shows (who declined, which address bounced). Never a link, token or code. */
    params: input.json(),
    /** Only workflow tests pass these; see email/status. */
    test_key: input.text(), test_from: input.text(),
  },
  stack: [
    guard.require(isIn(EMAIL_KINDS, inp("kind")), { errorType: "badrequest", message: "That isn't a kind of email Countersign sends." }),
    s.set_var("q_env_id", withFilters(inp("envelope_id"), fl.first_notempty(c.int(0)))),
    s.set_var("q_rcp_id", c.int(0)),
    s.set_var("q_user_id", c.int(0)),
    s.set_var("q_round", c.int(0)),
    s.set_var("q_to", c.text("")),
    s.set_var("q_key", c.text("")),
    s.set_var("q_params", withFilters(inp("params"), fl.first_notnull(c.obj({})))),
    s.set_var("q_in_rcp", withFilters(inp("recipient_id"), fl.first_notempty(c.int(0)))),
    s.set_var("q_in_otp", withFilters(inp("otp_id"), fl.first_notempty(c.int(0)))),
    s.set_var("q_in_user", withFilters(inp("user_id"), fl.first_notempty(c.int(0)))),
    s.set_var("q_in_source", withFilters(inp("source_id"), fl.first_notempty(c.int(0)))),
    s.conditional({
      when: isIn(RECIPIENT_KINDS, inp("kind")),
      then: [
        s.db.get({ table: recipient, fieldValue: ref("q_in_rcp"), output: ["id", "envelope_id", "email", "round"], as: "q_rcp" }),
        guard.found("q_rcp", { errorType: "notfound", message: "That person isn't on this document." }),
        s.update_var("q_rcp_id", ref("q_rcp.id")),
        s.update_var("q_env_id", ref("q_rcp.envelope_id")),
        s.update_var("q_to", ref("q_rcp.email")),
        s.update_var("q_round", withFilters(ref("q_rcp.round"), fl.first_notempty(c.int(1)))),
        s.update_var("q_key", withFilters(c.text("r:"), fl.concat(ref("q_rcp.id")), fl.concat(c.text(":")), fl.concat(inp("kind")), fl.concat(c.text(":")), fl.concat(ref("q_round")))),
        s.conditional({ when: expr(inp("kind"), "=", c.text("reminder")), then: [
          s.set_var("q_n", withFilters(inp("n"), fl.first_notempty(c.int(1)))),
          s.update_var("q_key", withFilters(ref("q_key"), fl.concat(c.text(":")), fl.concat(ref("q_n")))),
          s.update_var("q_params", withFilters(ref("q_params"), fl.set(c.text("n"), ref("q_n")))),
        ] }),
        s.update_var("q_params", withFilters(ref("q_params"), fl.set(c.text("round"), ref("q_round")))),
      ],
      elif: [
        { when: expr(inp("kind"), "=", c.text("otp")), then: [
          s.db.get({ table: otp_code, fieldValue: ref("q_in_otp"), output: ["id", "email", "subject"], as: "q_otp" }),
          guard.found("q_otp", { errorType: "notfound", message: "That code request has gone. Ask for a new code." }),
          s.update_var("q_to", ref("q_otp.email")),
          s.update_var("q_rcp_id", ref("q_in_rcp")),
          s.update_var("q_key", withFilters(c.text("otp:"), fl.concat(ref("q_otp.id")))),
          s.update_var("q_params", withFilters(ref("q_params"), fl.set(c.text("otp_id"), ref("q_otp.id")))),
        ] },
      ],
      else: [
        guard.require(isIn(MEMBER_KINDS, inp("kind")), { errorType: "badrequest", message: "That isn't a kind of email Countersign sends." }),
        s.db.get({ table: user, fieldValue: ref("q_in_user"), output: ["id", "email"], as: "q_user" }),
        guard.found("q_user", { errorType: "notfound", message: "That team member doesn't exist." }),
        s.update_var("q_user_id", ref("q_user.id")),
        s.update_var("q_to", ref("q_user.email")),
        s.update_var("q_key", withFilters(c.text("u:"), fl.concat(ref("q_user.id")), fl.concat(c.text(":")), fl.concat(inp("kind")), fl.concat(c.text(":")), fl.concat(ref("q_in_source")))),
      ],
    }),
    s.update_var("q_to", withFilters(ref("q_to"), fl.first_notnull(c.text("")), fl.trim(), fl.lower())),
    guard.require(expr(ref("q_to"), "!=", c.text("")), { errorType: "badrequest", message: "There's no email address to send this to." }),

    // Already queued for this purpose: nothing to do.
    s.db.get({ table: email_outbox, fieldName: "dedupe_key", fieldValue: ref("q_key"), output: ["id", "status"], as: "q_existing" }),
    s.set_var("q_created", c.bool(false)),
    s.set_var("q_id", withFilters(ref("q_existing.id", { safe: true }), fl.first_notempty(c.int(0)))),
    s.set_var("q_status", withFilters(ref("q_existing.status", { safe: true }), fl.first_notempty(c.text("")))),
    s.conditional({ when: expr(ref("q_id"), "=", c.int(0)), then: [
      s.function.run({ fn: emailStatusFn, as: "q_ready", input: { test_key: inp("test_key"), test_from: inp("test_from"), test_webhook: c.text("") } }),
      s.update_var("q_status", c.text("queued")),
      s.set_var("q_why", c.text("")),
      s.conditional({ when: expr(ref("q_ready.can_send"), "!=", c.bool(true)), then: [s.update_var("q_why", ref("q_ready.state"))] }),
      s.db.get({ table: envelope, fieldValue: ref("q_env_id"), output: ["is_demo"], as: "q_env" }),
      s.conditional({ when: expr(ref("q_env.is_demo", { safe: true }), "=", c.bool(true)), then: [s.update_var("q_why", c.text("demo_envelope"))] }),
      s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["demo_mode"], returnType: "single", as: "q_org" }),
      s.conditional({ when: expr(ref("q_org.demo_mode", { safe: true }), "=", c.bool(true)), then: [
        s.db.query({ table: user, where: [cmp(col("email"), "=", ref("q_to")), cmp(col("status"), "=", c.text("active"))], returnType: "count", as: "q_members" }),
        s.conditional({ when: expr(ref("q_members"), "<", c.int(1)), then: [s.update_var("q_why", c.text("demo_mode"))] }),
      ] }),
      s.conditional({ when: expr(ref("q_why"), "!=", c.text("")), then: [
        s.update_var("q_status", c.text("link_only")),
        s.update_var("q_params", withFilters(ref("q_params"), fl.set(c.text("link_only_reason"), ref("q_why")))),
      ] }),
      s.set_var("q_now", c.now()),
      s.try_catch({
        try: [
          s.db.add({ table: email_outbox, row: {
            dedupe_key: ref("q_key"), kind: inp("kind"), envelope_id: ref("q_env_id"), recipient_id: ref("q_rcp_id"), user_id: ref("q_user_id"),
            to: ref("q_to"), params: ref("q_params"), status: ref("q_status"), attempts: c.int(0), next_attempt_at: ref("q_now"), last_error: c.text(""),
          }, as: "q_row" }),
          s.update_var("q_id", ref("q_row.id")),
          s.update_var("q_created", c.bool(true)),
        ],
        // Another request queued the same email a moment ago: theirs stands.
        catch: [
          s.db.get({ table: email_outbox, fieldName: "dedupe_key", fieldValue: ref("q_key"), output: ["id", "status"], as: "q_raced" }),
          s.update_var("q_id", withFilters(ref("q_raced.id", { safe: true }), fl.first_notempty(c.int(0)))),
          s.update_var("q_status", withFilters(ref("q_raced.status", { safe: true }), fl.first_notempty(c.text("")))),
        ],
      }),
      // Send right after this request answers. Tests pass a stand-in key and drain by hand instead.
      s.conditional({ when: expr(c.expression('$var.q_created && $var.q_status == "queued" && ($input.test_key == null || $input.test_key == "")'), "=", c.bool(true)), then: [
        s.util.post_process([s.function.run({ fn: "email/drain", as: "q_drained", input: { limit: c.int(20), test_key: c.text(""), test_from: c.text("") } })]),
      ] }),
    ] }),
  ],
  response: obj({ id: ref("q_id"), status: ref("q_status"), created: ref("q_created"), dedupe_key: ref("q_key") }),
});
