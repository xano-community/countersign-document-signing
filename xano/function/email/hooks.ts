// Delivery news from Resend. Resend signs each webhook the Svix way: HMAC-SHA256 over `id.timestamp.body`, keyed with the
// base64 secret after `whsec_`, sent as one or more `v1,<base64>` signatures. A webhook is believed only when one of them
// matches and its timestamp is within 5 minutes, so an old captured request can't be replayed.
//
// A verified event moves the outbox row on: delivered, bounced or complained. A bounce also flags the recipient, tells the
// sender in the app and by email, and goes on the document's audit trail.
import { c, cmp, col, defineFunction, expr, fl, inp, input, lam, obj, ref, s, withFilters } from "@xano/sdk";
import { changed, notify } from "../../base/functions.js";
import { email_outbox } from "../../table/email/email_outbox.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { audit } from "../audit/audit.js";
import { enqueueFn } from "./outbox.js";

export const WEBHOOK_TOLERANCE_SECONDS = 300;

const svixBody = `
try {
  const secret = String($var.v_secret || "");
  const key = cryptojs.enc.Base64.parse(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const expected = cryptojs.HmacSHA256($var.v_id + "." + $var.v_ts + "." + $var.v_raw, key).toString(cryptojs.enc.Base64);
  const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
  const sigs = String($var.v_sig || "").split(" ").map((p) => p.split(",")[1] || "").filter(Boolean);
  let match = false;
  for (const s of sigs) if (same(s, expected)) match = true;
  const now = Number($var.v_now) > 0 ? Number($var.v_now) / 1000 : Date.now() / 1000;
  const age = Math.abs(now - Number($var.v_ts));
  return { ok: true, match, age: Number.isFinite(age) ? Math.round(age) : -1 };
} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
`;

/** Check a Svix signature. `reason` is "", "missing_secret", "missing_headers", "bad_signature" or "stale". */
export const svixVerifyFn = defineFunction({
  name: "email/svix_verify",
  description: "Verify a Resend (Svix) webhook signature and its age.",
  input: {
    secret: input.text(), id: input.text(), timestamp: input.text(), signature: input.text(), raw: input.text(),
    /** Only tests pass this: the time to check the timestamp against, in ms. */
    now_ms: input.int(),
  },
  stack: [
    s.set_var("v_secret", withFilters(inp("secret"), fl.first_notnull(c.text("")), fl.trim())),
    s.set_var("v_id", withFilters(inp("id"), fl.first_notnull(c.text("")))),
    s.set_var("v_ts", withFilters(inp("timestamp"), fl.first_notnull(c.text("")))),
    s.set_var("v_sig", withFilters(inp("signature"), fl.first_notnull(c.text("")))),
    s.set_var("v_raw", withFilters(inp("raw"), fl.first_notnull(c.text("")))),
    s.set_var("v_now", withFilters(inp("now_ms"), fl.first_notempty(c.int(0)))),
    s.set_var("reason", c.text("")),
    s.conditional({
      when: expr(ref("v_secret"), "=", c.text("")),
      then: [s.update_var("reason", c.text("missing_secret"))],
      elif: [{ when: expr(c.expression('$var.v_id == "" || $var.v_ts == "" || $var.v_sig == ""'), "=", c.bool(true)), then: [s.update_var("reason", c.text("missing_headers"))] }],
      else: [
        s.lambda({ as: "v", code: lam.raw(svixBody, { surface: "s.lambda" }) }),
        s.set_var("v_ok", withFilters(ref("v"), fl.get(c.text("ok"), c.bool(false)))),
        s.set_var("v_match", withFilters(ref("v"), fl.get(c.text("match"), c.bool(false)))),
        s.set_var("v_age", withFilters(ref("v"), fl.get(c.text("age"), c.int(-1)))),
        s.conditional({
          when: expr(c.expression("$var.v_ok != true || $var.v_match != true"), "=", c.bool(true)),
          then: [s.update_var("reason", c.text("bad_signature"))],
          elif: [{ when: expr(c.expression(`$var.v_age < 0 || $var.v_age > ${WEBHOOK_TOLERANCE_SECONDS}`), "=", c.bool(true)), then: [s.update_var("reason", c.text("stale"))] }],
        }),
      ],
    }),
  ],
  response: obj({ ok: c.expression('$var.reason == ""'), reason: ref("reason") }),
});

const EVENT_STATUS = { "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained" } as const;
/** States a delivery event may move a row from. A bounce or complaint is never undone by a late "delivered". */
const MOVABLE = { delivered: ["sent", "unknown"], bounced: ["sent", "unknown", "delivered"], complained: ["sent", "unknown", "delivered"] } as const;

/** Apply one verified Resend event to the outbox. Finds the row by Resend's id, or by address and nearest send time. */
export const applyEventFn = defineFunction({
  name: "email/apply_event",
  description: "Move an outbox row to delivered, bounced or complained from a verified Resend event.",
  input: { event: input.json() },
  stack: [
    s.set_var("ev", withFilters(inp("event"), fl.first_notnull(c.obj({})))),
    s.set_var("ev_type", withFilters(ref("ev"), fl.get(c.text("type"), c.text("")))),
    s.set_var("ev_status", withFilters(c.obj(EVENT_STATUS), fl.get(ref("ev_type"), c.text("")))),
    s.set_var("ev_email_id", withFilters(ref("ev"), fl.get(c.text("data.email_id"), c.text("")), fl.to_text())),
    s.set_var("ev_to", withFilters(ref("ev"), fl.get(c.text("data.to"), c.array([])), fl.first(), fl.first_notnull(c.text("")), fl.to_text(), fl.trim(), fl.lower())),
    s.set_var("ev_at_text", withFilters(ref("ev"), fl.get(c.text("created_at"), c.text("")))),
    s.set_var("ev_at", c.int(0)),
    s.conditional({ when: expr(ref("ev_at_text"), "!=", c.text("")), then: [s.update_var("ev_at", withFilters(ref("ev_at_text"), fl.to_epochms()))] }),
    s.conditional({ when: expr(ref("ev_at"), "<", c.int(1)), then: [s.update_var("ev_at", c.now())] }),
    s.set_var("hit", c.int(0)),
    s.set_var("hit_status", c.text("")),
    s.conditional({ when: expr(ref("ev_status"), "!=", c.text("")), then: [
      s.conditional({ when: expr(ref("ev_email_id"), "!=", c.text("")), then: [
        s.db.get({ table: email_outbox, fieldName: "resend_id", fieldValue: ref("ev_email_id"), output: ["id"], as: "by_id" }),
        s.update_var("hit", withFilters(ref("by_id.id", { safe: true }), fl.first_notempty(c.int(0)))),
      ] }),
      // No message id on the row: the sent email to that address whose send time is nearest the event's.
      s.conditional({ when: expr(c.expression('$var.hit == 0 && $var.ev_to != ""'), "=", c.bool(true)), then: [
        s.db.query({ table: email_outbox, where: [cmp(col("to"), "=", ref("ev_to")), cmp(col("status"), "in", c.array(["sent", "unknown", "delivered"])), expr(col("sent_at"), "<=", ref("ev_at"))],
          sort: [{ sortBy: "sent_at", dir: "desc" }], output: ["id"], returnType: "single", as: "by_to" }),
        s.update_var("hit", withFilters(ref("by_to.id", { safe: true }), fl.first_notempty(c.int(0)))),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("hit"), ">", c.int(0)), then: [
      s.db.get({ table: email_outbox, fieldValue: ref("hit"), output: ["id", "status", "kind", "to", "envelope_id", "recipient_id"], as: "o" }),
      s.set_var("o_from", withFilters(ref("o.status", { safe: true }), fl.first_notnull(c.text("")))),
      s.set_var("movable", withFilters(c.obj(MOVABLE), fl.get(ref("ev_status"), c.array([])), fl.in(ref("o_from")))),
      s.conditional({ when: expr(ref("movable"), "=", c.bool(true)), then: [
        s.db.patch({ table: email_outbox, fieldValue: ref("hit"), data: obj({ status: ref("ev_status") }) }),
        s.update_var("hit_status", ref("ev_status")),
        s.set_var("o_env", withFilters(ref("o.envelope_id", { safe: true }), fl.first_notempty(c.int(0)))),
        s.set_var("o_rcp", withFilters(ref("o.recipient_id", { safe: true }), fl.first_notempty(c.int(0)))),
        s.conditional({ when: expr(c.expression('$var.ev_status == "bounced" && $var.o_rcp > 0'), "=", c.bool(true)), then: [
          s.db.patch({ table: recipient, fieldValue: ref("o_rcp"), data: obj({ bounced: c.bool(true) }) }),
          s.db.get({ table: envelope, fieldValue: ref("o_env"), output: ["id", "title", "sender_id"], as: "b_env" }),
          s.set_var("b_sender", withFilters(ref("b_env.sender_id", { safe: true }), fl.first_notempty(c.int(0)))),
          s.set_var("b_title", withFilters(ref("b_env.title", { safe: true }), fl.first_notnull(c.text("")))),
          s.set_var("b_to", withFilters(ref("o.to", { safe: true }), fl.first_notnull(c.text("")))),
          s.conditional({ when: expr(ref("o_env"), ">", c.int(0)), then: [
            audit({ envelope: ref("o_env"), kind: "recipient.bounced", data: obj({ recipient_id: ref("o_rcp"), recipient_email: ref("b_to"), outbox_id: ref("hit"), kind: ref("o.kind", { safe: true }) }) }),
          ] }),
          s.conditional({ when: expr(ref("b_sender"), ">", c.int(0)), then: [
            notify({
              to: ref("b_sender"), kind: "email_bounced", actor: c.int(0),
              title: withFilters(c.text("Email to "), fl.concat(ref("b_to")), fl.concat(c.text(" bounced"))),
              body: withFilters(c.text("Check the address on “"), fl.concat(ref("b_title")), fl.concat(c.text("” and correct it."))),
              link: withFilters(c.text("/envelopes/"), fl.concat(ref("o_env"))),
            }),
            s.function.run({ fn: enqueueFn, as: "b_mail", input: {
              kind: c.text("notice_bounced"), user_id: ref("b_sender"), source_id: ref("hit"), envelope_id: ref("o_env"), params: obj({ address: ref("b_to") }),
            } }),
          ] }),
        ] }),
        s.conditional({ when: expr(ref("o_env"), ">", c.int(0)), then: [
          changed({ entity: "envelope", id: ref("o_env"), op: "updated", actor: c.int(0) }),
        ] }),
      ] }),
    ] }),
  ],
  response: obj({ type: ref("ev_type"), outbox_id: ref("hit"), status: ref("hit_status") }),
});

export const hookFunctions = [svixVerifyFn, applyEventFn];
