// What the Documents screen reads: the lists by segment, the numbers at the top, and one envelope in full. Every read keeps
// to the visibility rule: your own, the team's when you read the team's, everything when you read all.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, withFilters } from "@xano/sdk";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { email_outbox } from "../../table/email/email_outbox.js";
import { audit_event } from "../../table/signing/audit_event.js";
import { verifyFn } from "../audit/audit.js";
import { canRead } from "./access.js";
import { loadActor } from "./draft.js";

export const SEGMENTS = ["action", "waiting", "completed", "drafts", "ended", "all"] as const;
const PAGE = 30;

/** Binds `scope`: true when this actor reads every envelope, and `team`: true when they read the team's. */
export const readScope = [
  ...loadActor(),
  s.set_var("reads_all", c.bool(false)),
  s.set_var("reads_team", c.bool(false)),
  s.conditional({ when: rbac.has(ref("actor.role"), "envelope.read_all"), then: [s.update_var("reads_all", c.bool(true))] }),
  s.conditional({ when: rbac.has(ref("actor.role"), "envelope.read_team"), then: [s.update_var("reads_team", c.bool(true))] }),
];

/** The visibility rule as a search: everything, or mine plus the team's when allowed. */
export const visible = () => or(
  expr(ref("reads_all"), "=", c.bool(true)),
  cmp(col("sender_id"), "=", ref("actor.id")),
  and(expr(ref("reads_team"), "=", c.bool(true)), cmp(col("visibility"), "=", c.text("team"))),
);

export const listEnvelopes = defineFunction({
  name: "envelope/list",
  description: "One segment of the Documents list, newest activity first, with who's on each envelope.",
  input: { actor_id: input.int({ required: true }), segment: input.text(), q: input.text({ methods: ["trim"] }), page: input.int() },
  stack: [
    ...readScope,
    s.set_var("seg", withFilters(inp("segment"), fl.first_notempty(c.text("all")))),
    guard.require(expr(withFilters(c.array([...SEGMENTS]), fl.in(ref("seg"))), "=", c.bool(true)), { errorType: "badrequest", message: "That isn't a list on this screen." }),
    s.set_var("page_n", withFilters(inp("page"), fl.first_notempty(c.int(1)))),
    // Envelopes waiting on me as a recipient, for "Action required".
    s.db.query({ table: recipient, where: [cmp(col("user_id"), "=", ref("actor.id")), cmp(col("status"), "in", c.array(["sent", "opened"]))], output: ["envelope_id"], as: "mine_to_sign" }),
    s.set_var("my_turn_ids", c.array([0])),
    s.foreach({ list: ref("mine_to_sign"), as: "m", body: [s.update_var("my_turn_ids", withFilters(ref("my_turn_ids"), fl.array_push(ref("m.envelope_id"))))] }),
    s.set_var("statuses", c.array(["draft", "in_progress", "sealing", "completed", "declined", "voided", "expired"])),
    s.conditional({ when: expr(ref("seg"), "=", c.text("waiting")), then: [s.update_var("statuses", c.array(["in_progress", "sealing"]))] }),
    s.conditional({ when: expr(ref("seg"), "=", c.text("completed")), then: [s.update_var("statuses", c.array(["completed"]))] }),
    s.conditional({ when: expr(ref("seg"), "=", c.text("drafts")), then: [s.update_var("statuses", c.array(["draft"]))] }),
    s.conditional({ when: expr(ref("seg"), "=", c.text("ended")), then: [s.update_var("statuses", c.array(["declined", "voided", "expired"]))] }),
    s.set_var("needle", withFilters(inp("q"), fl.first_notnull(c.text("")))),
    s.set_var("no_needle", c.bool(true)),
    s.conditional({ when: expr(withFilters(ref("needle"), fl.strlen()), ">", c.int(0)), then: [s.update_var("no_needle", c.bool(false))] }),
    // Search reaches titles and the people on them.
    s.set_var("hit_ids", c.array([0])),
    s.conditional({ when: expr(withFilters(ref("needle"), fl.strlen()), ">", c.int(0)), then: [
      s.db.query({ table: recipient, where: or(cmp(col("email"), "includes", ref("needle")), cmp(col("name"), "includes", ref("needle"))), output: ["envelope_id"], paging: { per_page: 500, metadata: false }, as: "people_hits" }),
      s.foreach({ list: ref("people_hits"), as: "h", body: [s.update_var("hit_ids", withFilters(ref("hit_ids"), fl.array_push(ref("h.envelope_id"))))] }),
    ] }),
    s.conditional({ when: expr(ref("seg"), "=", c.text("action")), then: [
      s.db.query({ table: envelope, where: [
        cmp(col("is_template"), "!=", c.bool(true)),
        or(cmp(col("id"), "in", ref("my_turn_ids")), and(cmp(col("status"), "=", c.text("draft")), cmp(col("sender_id"), "=", ref("actor.id"))), and(cmp(col("seal_failed"), "=", c.bool(true)), cmp(col("sender_id"), "=", ref("actor.id")))),
        or(expr(ref("no_needle"), "=", c.bool(true)), cmp(col("title"), "includes", ref("needle")), cmp(col("id"), "in", ref("hit_ids"))),
      ], sort: [{ sortBy: "updated_at", dir: "desc" }, { sortBy: "id", dir: "desc" }], paging: { page: ref("page_n"), per_page: PAGE, metadata: true, totals: true },
        bind: [{ table: user, as: "by", join: "left", where: expr(col("sender_id"), "=", col("by.id")) }], eval: [{ name: "by.name", as: "sender_name" }],
        output: ["items.id", "items.public_id", "items.title", "items.status", "items.sender_id", "items.visibility", "items.signing_order", "items.sent_at", "items.expires_at", "items.completed_at", "items.ended_at", "items.updated_at", "items.created_at", "items.seal_failed", "items.page_count", "items.is_demo", "items.sender_name", "nextPage", "itemsTotal", "curPage"], as: "page" }),
    ], else: [
      s.db.query({ table: envelope, where: [
        cmp(col("is_template"), "!=", c.bool(true)),
        cmp(col("status"), "in", ref("statuses")),
        visible(),
        or(expr(ref("no_needle"), "=", c.bool(true)), cmp(col("title"), "includes", ref("needle")), cmp(col("id"), "in", ref("hit_ids"))),
      ], sort: [{ sortBy: "updated_at", dir: "desc" }, { sortBy: "id", dir: "desc" }], paging: { page: ref("page_n"), per_page: PAGE, metadata: true, totals: true },
        bind: [{ table: user, as: "by", join: "left", where: expr(col("sender_id"), "=", col("by.id")) }], eval: [{ name: "by.name", as: "sender_name" }],
        output: ["items.id", "items.public_id", "items.title", "items.status", "items.sender_id", "items.visibility", "items.signing_order", "items.sent_at", "items.expires_at", "items.completed_at", "items.ended_at", "items.updated_at", "items.created_at", "items.seal_failed", "items.page_count", "items.is_demo", "items.sender_name", "nextPage", "itemsTotal", "curPage"], as: "page" }),
    ] }),
    // Who's on each, in order, with where they've got to: the rows draw avatars and "1 of 3 signed".
    s.set_var("ids", c.array([0])),
    s.foreach({ list: ref("page.items"), as: "e", body: [s.update_var("ids", withFilters(ref("ids"), fl.array_push(ref("e.id"))))] }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "in", ref("ids")), sort: [{ sortBy: "step", dir: "asc" }, { sortBy: "color", dir: "asc" }],
      output: ["id", "envelope_id", "name", "email", "role", "status", "step", "color", "user_id", "bounced"], paging: { per_page: 2000, metadata: false }, as: "people" }),
  ],
  response: obj({ items: ref("page.items"), people: ref("people"), my_turn: ref("my_turn_ids"), next_page: ref("page.nextPage"), total: ref("page.itemsTotal") }),
});

/** The numbers at the top of Documents. */
export const envelopeStats = defineFunction({
  name: "envelope/stats",
  description: "How many are waiting on you, out, completed this month, and how long completing takes.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...readScope,
    s.db.query({ table: recipient, where: [cmp(col("user_id"), "=", ref("actor.id")), cmp(col("status"), "in", c.array(["sent", "opened"]))], returnType: "count", as: "waiting_on_you" }),
    s.db.query({ table: envelope, where: [cmp(col("status"), "in", c.array(["in_progress", "sealing"])), cmp(col("is_template"), "!=", c.bool(true)), visible()], returnType: "count", as: "out" }),
    s.set_var("now_ms", c.now()),
    s.set_var("month_start", withFilters(ref("now_ms"), fl.epochms_date(c.text("Y-m-01 00:00:00"), c.text("UTC")), fl.to_epochms(c.text("UTC")))),
    s.db.query({ table: envelope, where: [cmp(col("status"), "=", c.text("completed")), expr(col("completed_at"), ">=", ref("month_start")), visible()], returnType: "count", as: "completed_month" }),
    s.set_var("thirty_days", withFilters(ref("now_ms"), fl.sub(c.int(30 * 86_400_000)), fl.to_int())),
    s.db.query({ table: envelope, where: [cmp(col("status"), "=", c.text("completed")), expr(col("completed_at"), ">=", ref("thirty_days")), visible()], output: ["sent_at", "completed_at"], paging: { per_page: 1000, metadata: false }, as: "recent" }),
    s.set_var("durations", c.array([])),
    s.foreach({ list: ref("recent"), as: "r", body: [
      s.conditional({ when: expr(ref("r.sent_at"), "!=", c.null()), then: [s.update_var("durations", withFilters(ref("durations"), fl.array_push(withFilters(ref("r.completed_at"), fl.sub(ref("r.sent_at"))))))] }),
    ] }),
    s.set_var("sorted", withFilters(ref("durations"), fl.sort())),
    s.set_var("n", withFilters(ref("sorted"), fl.count())),
    s.set_var("median_ms", c.null()),
    s.conditional({ when: expr(ref("n"), ">", c.int(0)), then: [
      s.set_var("mid", withFilters(ref("n"), fl.div(c.int(2)), fl.floor(), fl.to_int())),
      s.update_var("median_ms", withFilters(ref("sorted"), fl.get(ref("mid")))),
    ] }),
  ],
  response: obj({ waiting_on_you: ref("waiting_on_you"), out: ref("out"), completed_this_month: ref("completed_month"), median_ms: ref("median_ms"), completed_last_30: ref("n") }),
});

/** One envelope in full: who's on it and where they are, each email's delivery, the timeline, and whether the trail holds. */
export const envelopeDetail = defineFunction({
  name: "envelope/detail",
  description: "An envelope as its page shows it.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    s.function.run({ fn: canRead, as: "readable", input: { actor_id: inp("actor_id"), envelope_id: inp("envelope_id") } }),
    guard.require(expr(ref("readable"), "=", c.bool(true)), { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.db.query({ table: envelope, where: cmp(col("id"), "=", inp("envelope_id")), returnType: "single",
      bind: [{ table: user, as: "by", join: "left", where: expr(col("sender_id"), "=", col("by.id")) }], eval: [{ name: "by.name", as: "sender_name" }],
      output: ["id", "public_id", "title", "status", "sender_id", "sender_name", "visibility", "signing_order", "subject", "message", "expires_at", "reminder_days", "sent_at", "completed_at", "ended_at", "end_reason", "page_count", "pages", "original_sha256", "final_sha256", "chain_head", "seal_failed", "seal_error", "seal_attempts", "is_template", "is_demo", "created_at", "updated_at"], as: "env" }),
    guard.found("env", { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "step", dir: "asc" }, { sortBy: "color", dir: "asc" }],
      output: ["id", "name", "email", "role", "role_name", "status", "step", "color", "identity_check", "user_id", "opened_at", "completed_at", "declined_at", "decline_reason", "bounced", "reminders_sent", "last_reminded_at", "hosted_by"], as: "people" }),
    // Each recipient's latest email and how it went.
    s.db.query({ table: email_outbox, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "id", dir: "desc" }],
      output: ["id", "kind", "recipient_id", "to", "status", "sent_at", "last_error", "created_at"], paging: { per_page: 200, metadata: false }, as: "mail" }),
    s.db.query({ table: audit_event, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "seq", dir: "asc" }],
      output: ["seq", "kind", "actor_type", "actor_name", "actor_email", "ip", "user_agent", "data", "at"], paging: { per_page: 1000, metadata: false }, as: "events" }),
    s.function.run({ fn: verifyFn, as: "integrity", input: { envelope_id: inp("envelope_id") } }),
    s.set_var("can_manage", c.bool(false)),
    s.conditional({ when: expr(ref("env.sender_id"), "=", ref("actor.id")), then: [s.update_var("can_manage", c.bool(true))] }),
    s.conditional({ when: rbac.has(ref("actor.role"), "envelope.read_all"), then: [s.update_var("can_manage", c.bool(true))] }),
    s.conditional({ when: rbac.lacks(ref("actor.role"), "envelope.send"), then: [s.update_var("can_manage", c.bool(false))] }),
  ],
  response: obj({ envelope: ref("env"), recipients: ref("people"), emails: ref("mail"), events: ref("events"), integrity: ref("integrity"), can_manage: ref("can_manage") }),
});

export const listFunctions = [listEnvelopes, envelopeStats, envelopeDetail];
