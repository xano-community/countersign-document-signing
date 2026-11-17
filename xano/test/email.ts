// Email: the outbox, the drain, the templates and Resend's webhook.
//
// Tests can't set env vars, and a test run has no Resend key. The functions take `test_key`/`test_from` stand-ins, which only
// these tests pass: with them the "email is set up" path runs for real against Resend, using a key Resend refuses, so the
// failure path is exercised end to end. Without them a function reads the env, as production does. A run with a real key
// in xano/.env would make the "no key" test fail on purpose: it asserts the deploy has none.
import { c, cmp, col, fl, obj, ref, s, withFilters, workflowTest as plainTest, type Value } from "@xano/sdk";
import { email_outbox } from "../table/email/email_outbox.js";
import { org_setting } from "../table/envelope/org_setting.js";
import { recipient } from "../table/envelope/recipient.js";
import { envelope } from "../table/envelope/envelope.js";
import { signing_link } from "../table/signing/signing_link.js";
import { otp_code } from "../table/signing/otp_code.js";
import { audit_event } from "../table/signing/audit_event.js";
import { notification } from "../base/tables.js";
import { enqueueFn } from "../function/email/outbox.js";
import { claimFn, drainFn, markStuckFn, sendTestFn } from "../function/email/drain.js";
import { emailStatusFn } from "../function/email/status.js";
import { renderFn } from "../function/email/templates.js";
import { layoutFn } from "../function/email/layout.js";
import { applyEventFn, svixVerifyFn } from "../function/email/hooks.js";
import { mintLinkFn, mintOtpFn, otpHashOf } from "../function/signing/links.js";
import { rememberUrlsFn } from "../function/settings/app_url.js";
import { draft, person, signer, workflowTest } from "./fixtures.js";

const APP = "https://app.countersign-test.example";
/** A key Resend refuses: the send really goes to Resend and comes back as an error. */
const BAD_KEY = "re_countersign_invalid_test_key";
const FROM = "Countersign <sign@countersign-test.example>";
const keyed = { test_key: c.text(BAD_KEY), test_from: c.text(FROM) };

const org = (extra: Record<string, Value> = {}) =>
  s.db.add({ table: org_setting, as: "org", row: { org_name: c.text("Fernhill Test"), app_url: c.text(APP), demo_mode: c.bool(false), ...extra } });
const out = (env: string, sender: string, title = "Test lease") => draft(env, sender, title, { status: c.text("in_progress") });
const enqueue = (as: string, input: Record<string, Value>) => s.function.call({ fn: enqueueFn, as, input });
const invite = (as: string, rcp: string, extra: Record<string, Value> = {}) => enqueue(as, { kind: c.text("invite"), recipient_id: ref(`${rcp}.id`), ...extra });
const drain = (as: string, extra: Record<string, Value> = {}) => s.function.call({ fn: drainFn, as, input: { limit: c.int(20), ...extra } });
const row = (as: string, id: Value) => s.db.get({ table: email_outbox, fieldValue: id, as });
const rows = (as: string) => s.db.query({ table: email_outbox, returnType: "count", as });
const eq = (e: Value, v: Value) => s.expect.to_equal({ expr: e, value: v });
const has = (text: Value, part: string) => s.expect.to_be_true({ expr: withFilters(text, fl.contains(c.text(part))) });
const lacks = (text: Value, part: string) => s.expect.to_be_false({ expr: withFilters(text, fl.contains(c.text(part))) });
const dueNow = (id: Value) => s.db.patch({ table: email_outbox, fieldValue: id, data: obj({ next_attempt_at: c.int(0) }) });

// A real Svix signature, made outside Xano with Node's crypto for this exact body, id and timestamp.
const HOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const HOOK_BODY = '{"type":"email.bounced","created_at":"2025-11-16T12:00:00.000Z","data":{"email_id":"re_msg_bounce_1","to":["ana@countersign-test.example"]}}';
const HOOK_ID = "msg_countersign_test";
const HOOK_TS = 1763294400;
const HOOK_SIG = "v1,+K9mRMYRNZDT0/CMaKMsju5SC1ga0vl6/VrSmEHvoZQ=";
const verify = (as: string, body: string, sig: string, nowMs: number, secret = HOOK_SECRET) => s.function.call({ fn: svixVerifyFn, as, input: {
  secret: c.text(secret), id: c.text(HOOK_ID), timestamp: c.text(String(HOOK_TS)), signature: c.text(sig), raw: c.text(body), now_ms: c.int(nowMs),
} });

export const emailTests = [
  workflowTest({
    name: "email: with no key, sending makes link-only rows and calls nothing",
    description: "Without RESEND_API_KEY an invite is written link_only, the drain finds nothing to send, and no link is minted.",
    stack: [
      person("sender"), org(), out("env", "sender"), signer("ana", "env", "ana@countersign-test.example"),
      s.function.call({ fn: emailStatusFn, as: "ready", input: {} }),
      eq(ref("ready.state"), c.text("missing_key")),
      eq(ref("ready.can_send"), c.bool(false)),
      invite("q", "ana"),
      eq(ref("q.status"), c.text("link_only")),
      drain("d"),
      eq(ref("d.due"), c.int(0)),
      row("r", ref("q.id")),
      eq(ref("r.status"), c.text("link_only")),
      eq(ref("r.attempts"), c.int(0)),
      eq(withFilters(ref("r.params"), fl.get(c.text("link_only_reason"), c.text(""))), c.text("missing_key")),
      s.db.query({ table: signing_link, returnType: "count", as: "links" }),
      eq(ref("links"), c.int(0)),
    ],
  }),
  workflowTest({
    name: "email: the same invite queued twice is one row, and a sent row is never sent again",
    description: "A repeated enqueue is a no-op; a row recorded as sent is untouched by the drain; only one of two claims wins.",
    stack: [
      person("sender"), org(), out("env", "sender"), signer("ana", "env", "ana@countersign-test.example"),
      invite("q1", "ana", keyed),
      invite("q2", "ana", keyed),
      eq(ref("q1.created"), c.bool(true)),
      eq(ref("q2.created"), c.bool(false)),
      eq(ref("q2.id"), ref("q1.id")),
      eq(ref("q1.dedupe_key"), withFilters(c.text("r:"), fl.concat(ref("ana.id")), fl.concat(c.text(":invite:1")))),
      rows("n"),
      eq(ref("n"), c.int(1)),
      // Recorded as sent: no drain, sweep or retry sends it again.
      s.db.patch({ table: email_outbox, fieldValue: ref("q1.id"), data: obj({ status: c.text("sent"), attempts: c.int(1), next_attempt_at: c.int(0) }) }),
      drain("d", keyed),
      eq(ref("d.due"), c.int(0)),
      row("r", ref("q1.id")),
      eq(ref("r.status"), c.text("sent")),
      eq(ref("r.attempts"), c.int(1)),
      s.function.call({ fn: claimFn, as: "claim_sent", input: { outbox_id: ref("q1.id") } }),
      eq(ref("claim_sent"), c.bool(false)),
      // Two drains reaching one queued row: the first claim wins, the second gets nothing.
      enqueue("rem", { kind: c.text("reminder"), recipient_id: ref("ana.id"), n: c.int(1), ...keyed }),
      s.function.call({ fn: claimFn, as: "claim_a", input: { outbox_id: ref("rem.id") } }),
      s.function.call({ fn: claimFn, as: "claim_b", input: { outbox_id: ref("rem.id") } }),
      eq(ref("claim_a"), c.bool(true)),
      eq(ref("claim_b"), c.bool(false)),
    ],
  }),
  workflowTest({
    name: "email: a refused send is retried with backoff, then failed after three attempts",
    description: "Resend refuses a bad key: the error is recorded, the next try waits, the unused link is revoked, and the third failure is final.",
    stack: [
      person("sender"), org(), out("env", "sender"), signer("ana", "env", "ana@countersign-test.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ status: c.text("sent") }) }),
      invite("q", "ana", keyed),
      eq(ref("q.status"), c.text("queued")),
      s.set_var("before", c.now()),
      drain("d1", keyed),
      eq(ref("d1.due"), c.int(1)),
      row("r1", ref("q.id")),
      eq(ref("r1.status"), c.text("queued")),
      eq(ref("r1.attempts"), c.int(1)),
      s.expect.to_not_equal({ expr: ref("r1.last_error"), value: c.text("") }),
      s.expect.to_be_greater_than({ expr: ref("r1.next_attempt_at"), value: ref("before") }),
      // The link made for that email never reached anyone, so it was revoked.
      s.db.query({ table: signing_link, where: cmp(col("recipient_id"), "=", ref("ana.id")), returnType: "single", as: "link" }),
      eq(ref("link.revoked"), c.bool(true)),
      eq(ref("link.via"), c.text("email")),
      // Not due yet: a drain now leaves it alone.
      drain("early", keyed),
      eq(ref("early.due"), c.int(0)),
      dueNow(ref("q.id")),
      drain("d2", keyed),
      row("r2", ref("q.id")),
      eq(ref("r2.attempts"), c.int(2)),
      eq(ref("r2.status"), c.text("queued")),
      dueNow(ref("q.id")),
      drain("d3", keyed),
      row("r3", ref("q.id")),
      eq(ref("r3.attempts"), c.int(3)),
      eq(ref("r3.status"), c.text("failed")),
      dueNow(ref("q.id")),
      drain("d4", keyed),
      eq(ref("d4.due"), c.int(0)),
    ],
  }),
  workflowTest({
    name: "email: an email stuck in sending becomes unknown and is never resent",
    description: "A row claimed over 5 minutes ago is marked unknown; a fresh claim is left alone; neither is sent by the drain.",
    stack: [
      person("sender"), org(), out("env", "sender"), signer("ana", "env", "ana@countersign-test.example"),
      s.set_var("now", c.now()),
      s.set_var("long_ago", withFilters(ref("now"), fl.sub(c.int(6 * 60_000)))),
      s.set_var("just_now", withFilters(ref("now"), fl.sub(c.int(60_000)))),
      s.db.add({ table: email_outbox, as: "old", row: { dedupe_key: c.text("r:1:invite:1"), kind: c.text("invite"), envelope_id: ref("env.id"), recipient_id: ref("ana.id"), to: c.text("ana@countersign-test.example"), status: c.text("sending"), attempts: c.int(0), claimed_at: ref("long_ago"), next_attempt_at: c.int(0) } }),
      s.db.add({ table: email_outbox, as: "fresh", row: { dedupe_key: c.text("r:1:invite:2"), kind: c.text("invite"), envelope_id: ref("env.id"), recipient_id: ref("ana.id"), to: c.text("ana@countersign-test.example"), status: c.text("sending"), attempts: c.int(0), claimed_at: ref("just_now"), next_attempt_at: c.int(0) } }),
      s.function.call({ fn: markStuckFn, as: "m", input: {} }),
      eq(ref("m.marked"), c.int(1)),
      drain("d", keyed),
      eq(ref("d.due"), c.int(0)),
      row("r_old", ref("old.id")),
      eq(ref("r_old.status"), c.text("unknown")),
      eq(ref("r_old.attempts"), c.int(0)),
      row("r_fresh", ref("fresh.id")),
      eq(ref("r_fresh.status"), c.text("sending")),
    ],
  }),
  plainTest({
    name: "email: each reminder and each code is its own email",
    description: "A second reminder and a second code for the same recipient and round make new rows; repeating one doesn't.",
    stack: [
      person("sender"), org(), out("env", "sender"), signer("ana", "env", "ana@countersign-test.example"),
      enqueue("rem1", { kind: c.text("reminder"), recipient_id: ref("ana.id"), n: c.int(1), ...keyed }),
      enqueue("rem2", { kind: c.text("reminder"), recipient_id: ref("ana.id"), n: c.int(2), ...keyed }),
      enqueue("rem1_again", { kind: c.text("reminder"), recipient_id: ref("ana.id"), n: c.int(1), ...keyed }),
      s.expect.to_not_equal({ expr: ref("rem2.id"), value: ref("rem1.id") }),
      eq(ref("rem1_again.created"), c.bool(false)),
      s.db.add({ table: otp_code, as: "code1", row: { subject: withFilters(c.text("recipient:"), fl.concat(ref("ana.id"))), email: c.text("ana@countersign-test.example"), attempts: c.int(0) } }),
      s.db.add({ table: otp_code, as: "code2", row: { subject: withFilters(c.text("recipient:"), fl.concat(ref("ana.id"))), email: c.text("ana@countersign-test.example"), attempts: c.int(0) } }),
      enqueue("otp1", { kind: c.text("otp"), otp_id: ref("code1.id"), recipient_id: ref("ana.id"), ...keyed }),
      enqueue("otp2", { kind: c.text("otp"), otp_id: ref("code2.id"), recipient_id: ref("ana.id"), ...keyed }),
      enqueue("otp1_again", { kind: c.text("otp"), otp_id: ref("code1.id"), recipient_id: ref("ana.id"), ...keyed }),
      eq(ref("otp1.dedupe_key"), withFilters(c.text("otp:"), fl.concat(ref("code1.id")))),
      eq(ref("otp1_again.created"), c.bool(false)),
      rows("n"),
      eq(ref("n"), c.int(4)),
    ],
  }),
  workflowTest({
    name: "email: mail to a member deduplicates on member, kind and source",
    description: "Sender notices have no recipient row: their key is u:{user}:{kind}:{source}.",
    stack: [
      person("sender"), org(), out("env", "sender"),
      enqueue("a", { kind: c.text("notice_declined"), user_id: ref("sender.id"), source_id: ref("env.id"), envelope_id: ref("env.id"), ...keyed }),
      enqueue("a_again", { kind: c.text("notice_declined"), user_id: ref("sender.id"), source_id: ref("env.id"), envelope_id: ref("env.id"), ...keyed }),
      enqueue("b", { kind: c.text("notice_completed"), user_id: ref("sender.id"), source_id: ref("env.id"), envelope_id: ref("env.id"), ...keyed }),
      enqueue("c", { kind: c.text("notice_declined"), user_id: ref("sender.id"), source_id: c.int(999), ...keyed }),
      eq(ref("a_again.created"), c.bool(false)),
      eq(ref("a.dedupe_key"), withFilters(c.text("u:"), fl.concat(ref("sender.id")), fl.concat(c.text(":notice_declined:")), fl.concat(ref("env.id")))),
      rows("n"),
      eq(ref("n"), c.int(3)),
      row("r", ref("a.id")),
      eq(ref("r.to"), c.text("sender@countersign-test.example")),
    ],
  }),
  plainTest({
    name: "email: names, titles and messages are escaped in the HTML",
    description: "Markup typed into a name, a title or a message shows as text; a non-web link is never placed in an href.",
    stack: [
      person("sender"), org(),
      draft("env", "sender", "Lease & <b>terms</b>", { status: c.text("in_progress") }),
      s.db.patch({ table: envelope, fieldValue: ref("env.id"), data: obj({ message: c.text("Line one\n<script>alert(1)</script>") }) }),
      signer("ana", "env", "ana@countersign-test.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ name: c.text("<a href=\"x\">Ana</a>") }) }),
      s.function.call({ fn: renderFn, as: "mail", input: { kind: c.text("invite"), recipient_id: ref("ana.id"), envelope_id: ref("env.id"), url: c.text(`${APP}/sign/abc`) } }),
      has(ref("mail.html"), "&lt;a href=&quot;x&quot;&gt;Ana&lt;/a&gt;"),
      lacks(ref("mail.html"), "<a href=\"x\">"),
      has(ref("mail.html"), "Lease &amp; &lt;b&gt;terms&lt;/b&gt;"),
      lacks(ref("mail.html"), "<b>terms"),
      has(ref("mail.html"), "&lt;script&gt;"),
      lacks(ref("mail.html"), "<script>"),
      has(ref("mail.html"), "Line one<br>"),
      has(ref("mail.html"), `href="${APP}/sign/abc"`),
      has(ref("mail.subject"), "Lease & <b>terms</b>"),
      s.function.call({ fn: layoutFn, as: "bad_link", input: { heading: c.text("Hi"), button_label: c.text("Open"), url: c.text("javascript:alert(1)"), org_name: c.text("<i>Org</i>") } }),
      lacks(ref("bad_link"), "javascript:"),
      has(ref("bad_link"), "&lt;i&gt;Org&lt;/i&gt;"),
    ],
  }),
  workflowTest({
    name: "email: no outbox row holds a raw signing token or one-time code",
    description: "Links and codes are made at send time; the outbox keeps only the kind and plain parameters.",
    stack: [
      person("sender"), org(), out("env", "sender"), signer("ana", "env", "ana@countersign-test.example"),
      s.db.patch({ table: recipient, fieldValue: ref("ana.id"), data: obj({ status: c.text("sent") }) }),
      s.function.call({ fn: mintLinkFn, as: "copied", input: { recipient_id: ref("ana.id"), round: c.int(1), via: c.text("copied") } }),
      has(ref("copied.url"), `${APP}/sign/`),
      s.set_var("token", withFilters(ref("copied.url"), fl.split(c.text("/sign/")), fl.last())),
      s.expect.to_be_greater_than({ expr: withFilters(ref("token"), fl.strlen()), value: c.int(40) }),
      s.db.query({ table: signing_link, where: cmp(col("token_hash"), "=", withFilters(ref("token"), fl.sha256())), returnType: "count", as: "by_hash" }),
      eq(ref("by_hash"), c.int(1)),
      s.db.add({ table: otp_code, as: "code_row", row: { subject: c.text("recipient:ana"), email: c.text("ana@countersign-test.example"), attempts: c.int(0) } }),
      invite("q", "ana", keyed),
      enqueue("otp", { kind: c.text("otp"), otp_id: ref("code_row.id"), recipient_id: ref("ana.id"), ...keyed }),
      drain("d", keyed),
      eq(ref("d.due"), c.int(2)),
      // The drain made a link and a code for those sends; neither reached a row.
      s.db.query({ table: email_outbox, as: "all" }),
      s.set_var("dump", withFilters(ref("all"), fl.json_encode())),
      lacks(ref("dump"), "/sign/"),
      lacks(ref("dump"), "/signed/"),
      s.set_var("token_in_dump", withFilters(ref("dump"), fl.contains(ref("token")))),
      eq(ref("token_in_dump"), c.bool(false)),
      row("otp_row", ref("otp.id")),
      eq(withFilters(ref("otp_row.params"), fl.get(c.text("code"), c.text("none"))), c.text("none")),
      s.db.get({ table: otp_code, fieldValue: ref("code_row.id"), as: "code_after" }),
      eq(withFilters(ref("code_after.code_hash"), fl.strlen()), c.int(64)),
      // A code made directly is six digits, and only its hash is kept.
      s.function.call({ fn: mintOtpFn, as: "minted", input: { subject: c.text("recipient:test"), email: c.text("ana@countersign-test.example") } }),
      s.expect.to_match({ expr: ref("minted.code"), value: c.regex(/^[0-9]{6}$/) }),
      s.db.get({ table: otp_code, fieldValue: ref("minted.id"), as: "minted_row" }),
      eq(ref("minted_row.code_hash"), otpHashOf(c.text("recipient:test"), ref("minted.code"))),
      s.expect.to_be_greater_than({ expr: ref("minted_row.expires_at"), value: c.now() }),
    ],
  }),
  workflowTest({
    name: "email: in demo mode only team members are emailed",
    description: "With a key set and demo mode on, an invite to a stranger is link-only and one to a member is queued; a demo envelope never emails.",
    stack: [
      person("sender"), person("member"), org({ demo_mode: c.bool(true) }), out("env", "sender"),
      signer("stranger", "env", "stranger@elsewhere.example"),
      signer("colleague", "env", "member@countersign-test.example"),
      invite("to_stranger", "stranger", keyed),
      invite("to_member", "colleague", keyed),
      eq(ref("to_stranger.status"), c.text("link_only")),
      eq(ref("to_member.status"), c.text("queued")),
      row("r", ref("to_stranger.id")),
      eq(withFilters(ref("r.params"), fl.get(c.text("link_only_reason"), c.text(""))), c.text("demo_mode")),
      draft("seeded", "sender", "Seeded lease", { status: c.text("in_progress") }),
      s.db.patch({ table: envelope, fieldValue: ref("seeded.id"), data: obj({ is_demo: c.bool(true) }) }),
      signer("member_on_demo", "seeded", "member@countersign-test.example"),
      invite("demo_env", "member_on_demo", keyed),
      eq(ref("demo_env.status"), c.text("link_only")),
    ],
  }),
  plainTest({
    name: "email: a Resend webhook is believed only with a valid, recent signature",
    description: "A real Svix signature passes; a tampered body, a wrong signature, an old timestamp and a missing secret are refused.",
    stack: [
      verify("good", HOOK_BODY, HOOK_SIG, HOOK_TS * 1000 + 1000),
      eq(ref("good.ok"), c.bool(true)),
      verify("rotated", HOOK_BODY, `v1,AAAA ${HOOK_SIG}`, HOOK_TS * 1000 + 1000),
      eq(ref("rotated.ok"), c.bool(true)),
      verify("tampered", HOOK_BODY.replace("bounced", "delivered"), HOOK_SIG, HOOK_TS * 1000 + 1000),
      eq(ref("tampered.reason"), c.text("bad_signature")),
      verify("wrong", HOOK_BODY, "v1,AAAA", HOOK_TS * 1000 + 1000),
      eq(ref("wrong.reason"), c.text("bad_signature")),
      verify("old", HOOK_BODY, HOOK_SIG, HOOK_TS * 1000 + 600_000),
      eq(ref("old.reason"), c.text("stale")),
      verify("no_secret", HOOK_BODY, HOOK_SIG, HOOK_TS * 1000 + 1000, ""),
      eq(ref("no_secret.reason"), c.text("missing_secret")),
    ],
  }),
  workflowTest({
    name: "email: a bounce marks the email, flags the recipient and tells the sender",
    description: "email.bounced matched by Resend's id: row bounced, recipient flagged, audit event, notification and a notice email. A late delivered doesn't undo it.",
    stack: [
      person("sender"), org(), out("env", "sender"), signer("ana", "env", "ana@countersign-test.example"),
      s.db.add({ table: email_outbox, as: "sent", row: { dedupe_key: c.text("r:ana:invite:1"), kind: c.text("invite"), envelope_id: ref("env.id"), recipient_id: ref("ana.id"), to: c.text("ana@countersign-test.example"), status: c.text("sent"), attempts: c.int(1), resend_id: c.text("re_msg_bounce_1"), sent_at: c.int(1763294000000), next_attempt_at: c.int(0) } }),
      s.function.call({ fn: applyEventFn, as: "applied", input: { event: withFilters(c.text(HOOK_BODY), fl.json_decode()) } }),
      eq(ref("applied.status"), c.text("bounced")),
      row("r", ref("sent.id")),
      eq(ref("r.status"), c.text("bounced")),
      s.db.get({ table: recipient, fieldValue: ref("ana.id"), as: "ana_now" }),
      eq(ref("ana_now.bounced"), c.bool(true)),
      s.db.query({ table: audit_event, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("kind"), "=", c.text("recipient.bounced"))], returnType: "count", as: "audited" }),
      eq(ref("audited"), c.int(1)),
      s.db.query({ table: notification, where: cmp(col("user_id"), "=", ref("sender.id")), returnType: "count", as: "told" }),
      eq(ref("told"), c.int(1)),
      s.db.query({ table: email_outbox, where: cmp(col("kind"), "=", c.text("notice_bounced")), returnType: "count", as: "notice" }),
      eq(ref("notice"), c.int(1)),
      s.function.call({ fn: applyEventFn, as: "late", input: { event: obj({ type: c.text("email.delivered"), data: obj({ email_id: c.text("re_msg_bounce_1") }) }) } }),
      row("r_after", ref("sent.id")),
      eq(ref("r_after.status"), c.text("bounced")),
      // The same bounce again changes nothing and isn't audited twice.
      s.function.call({ fn: applyEventFn, as: "again", input: { event: withFilters(c.text(HOOK_BODY), fl.json_decode()) } }),
      s.db.query({ table: audit_event, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("kind"), "=", c.text("recipient.bounced"))], returnType: "count", as: "audited_again" }),
      eq(ref("audited_again"), c.int(1)),
    ],
  }),
  workflowTest({
    name: "email: a delivery event without a message id matches by address and send time",
    description: "When the row has no Resend id, the sent email to that address nearest before the event is the one updated.",
    stack: [
      person("sender"), org(), out("env", "sender"), signer("ana", "env", "ana@countersign-test.example"),
      s.db.add({ table: email_outbox, as: "older", row: { dedupe_key: c.text("k1"), kind: c.text("invite"), envelope_id: ref("env.id"), to: c.text("ana@countersign-test.example"), status: c.text("sent"), sent_at: c.int(1763290000000), next_attempt_at: c.int(0) } }),
      s.db.add({ table: email_outbox, as: "newer", row: { dedupe_key: c.text("k2"), kind: c.text("reminder"), envelope_id: ref("env.id"), to: c.text("ana@countersign-test.example"), status: c.text("sent"), sent_at: c.int(1763294000000), next_attempt_at: c.int(0) } }),
      s.function.call({ fn: applyEventFn, as: "applied", input: { event: obj({ type: c.text("email.delivered"), created_at: c.text("2025-11-16T12:00:00.000Z"), data: obj({ email_id: c.text("unknown-id"), to: c.array(["Ana@countersign-test.example"]) }) }) } }),
      eq(ref("applied.outbox_id"), ref("newer.id")),
      row("r_new", ref("newer.id")),
      eq(ref("r_new.status"), c.text("delivered")),
      row("r_old", ref("older.id")),
      eq(ref("r_old.status"), c.text("sent")),
    ],
  }),
  plainTest({
    name: "email: the test email reports the missing setting or Resend's exact error",
    description: "With no key it says missing_key and queues nothing; with a refused key it returns the error and doesn't retry.",
    stack: [
      person("admin", "admin"), org(),
      s.function.call({ fn: sendTestFn, as: "unset", input: { actor_id: ref("admin.id") } }),
      eq(ref("unset.ok"), c.bool(false)),
      eq(ref("unset.state"), c.text("missing_key")),
      rows("none"),
      eq(ref("none"), c.int(0)),
      s.function.call({ fn: sendTestFn, as: "refused", input: { actor_id: ref("admin.id"), ...keyed } }),
      eq(ref("refused.ok"), c.bool(false)),
      eq(ref("refused.status"), c.text("failed")),
      // Resend's own words, passed through untouched.
      eq(ref("refused.error"), c.text("API key is invalid")),
      eq(ref("refused.to"), c.text("admin@countersign-test.example")),
    ],
  }),
  plainTest({
    name: "email: status names the missing setting and never a value",
    description: "missing_key, then missing_from, then webhook_missing, then ready.",
    stack: [
      s.function.call({ fn: emailStatusFn, as: "no_from", input: { test_key: c.text(BAD_KEY) } }),
      eq(ref("no_from.state"), c.text("missing_from")),
      s.function.call({ fn: emailStatusFn, as: "no_hook", input: keyed }),
      eq(ref("no_hook.state"), c.text("webhook_missing")),
      eq(ref("no_hook.can_send"), c.bool(true)),
      s.function.call({ fn: emailStatusFn, as: "all", input: { ...keyed, test_webhook: c.text(HOOK_SECRET) } }),
      eq(ref("all.state"), c.text("ready")),
      s.set_var("all_text", withFilters(ref("all"), fl.json_encode())),
      lacks(ref("all_text"), BAD_KEY),
    ],
  }),
  workflowTest({
    name: "email: the app's address is learned once, and only an admin changes it",
    description: "Any member's request sets an empty address; a member can't replace it; an admin can; a non-web value is ignored.",
    stack: [
      person("admin", "admin"), person("member"),
      s.db.add({ table: org_setting, as: "org", row: { org_name: c.text("Fernhill Test"), app_url: c.text("") } }),
      s.function.call({ fn: rememberUrlsFn, as: "first", input: { actor_id: ref("member.id"), origin: c.text("https://sign.fernhill.example/") } }),
      s.function.call({ fn: rememberUrlsFn, as: "forged", input: { actor_id: ref("member.id"), origin: c.text("https://evil.example") } }),
      s.db.get({ table: org_setting, fieldValue: ref("org.id"), as: "o1" }),
      eq(ref("o1.app_url"), c.text("https://sign.fernhill.example")),
      s.function.call({ fn: rememberUrlsFn, as: "junk", input: { actor_id: ref("admin.id"), app_url: c.text("javascript:alert(1)") } }),
      s.function.call({ fn: rememberUrlsFn, as: "moved", input: { actor_id: ref("admin.id"), app_url: c.text("https://countersign.fernhill.example"), api_base: c.text("https://x123.xano.io") } }),
      s.db.get({ table: org_setting, fieldValue: ref("org.id"), as: "o2" }),
      eq(ref("o2.app_url"), c.text("https://countersign.fernhill.example")),
      eq(ref("o2.api_base_url"), c.text("https://x123.xano.io")),
    ],
  }),
];
