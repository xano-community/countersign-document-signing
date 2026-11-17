// Bulk send: one template, many people, from a spreadsheet. The browser reads the CSV and matches its columns to the template's
// roles; the server checks every row again, keeps the bad ones as failed with a reason, and the sweep sends the rest in batches.
// Each row's envelope is keyed to the row, so a batch cut short and run again never sends anyone a second copy.
import { c, caught, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { bulk_send, bulk_send_row } from "../../table/envelope/bulk_send.js";
import { canRead } from "../envelope/access.js";
import { loadActor } from "../envelope/draft.js";
import { sendFn } from "../envelope/send.js";
import { instantiateFn } from "./templates.js";

export const MOST_ROWS = 500;
/** Rows sent per sweep run. */
const BATCH = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Start a bulk send. `rows`: [{ line, people: [{ role_id, name, email }] }], one per spreadsheet line. Every role without a
 * fixed person on the template needs a name and a valid email on every row; rows that don't are kept as failed, with why.
 */
export const bulkCreateFn = defineFunction({
  name: "bulk/create",
  description: "Start sending a template to many people. Bad rows are recorded as failed; the rest are sent in the background.",
  input: { actor_id: input.int({ required: true }), template_id: input.int({ required: true }), rows: input.json({ required: true }), title: input.text({ methods: ["trim"] }) },
  stack: [
    ...loadActor(),
    rbac.allows(ref("actor.role"), "envelope.send", "Your role can't send documents for signature."),
    s.db.get({ table: envelope, fieldValue: inp("template_id"), output: ["id", "title", "is_template"], as: "tpl" }),
    guard.found("tpl", { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
    guard.require(expr(ref("tpl.is_template"), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
    s.function.run({ fn: canRead, as: "may_read", input: { actor_id: inp("actor_id"), envelope_id: inp("template_id") } }),
    guard.require(expr(ref("may_read"), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
    s.set_var("row_count", withFilters(inp("rows"), fl.count())),
    guard.require(expr(ref("row_count"), ">=", c.int(1)), { errorType: "badrequest", message: "The spreadsheet has no rows to send." }),
    guard.require(expr(ref("row_count"), "<=", c.int(MOST_ROWS)), { errorType: "badrequest", message: `Send to up to ${MOST_ROWS} rows at a time.` }),
    // The roles each row must fill: those with no fixed person on the template.
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("tpl.id")), output: ["id", "role_name", "email"], as: "roles" }),
    s.set_var("open_roles", c.array([])),
    s.foreach({ list: ref("roles"), as: "r", body: [
      s.conditional({ when: expr(withFilters(ref("r.email"), fl.first_notnull(c.text(""))), "=", c.text("")), then: [
        s.update_var("open_roles", withFilters(ref("open_roles"), fl.array_push(ref("r")))),
      ] }),
    ] }),
    s.set_var("b_title", withFilters(inp("title"), fl.first_notnull(c.text("")), fl.substr(c.int(0), c.int(200)))),
    s.conditional({ when: expr(ref("b_title"), "=", c.text("")), then: [s.update_var("b_title", ref("tpl.title"))] }),
    s.db.add({ table: bulk_send, row: { template_id: ref("tpl.id"), sender_id: ref("actor.id"), title: ref("b_title"), status: c.text("running"), total: ref("row_count"), sent: c.int(0), failed: c.int(0) }, as: "bulk" }),
    s.set_var("items", c.array([])),
    s.set_var("bad", c.int(0)),
    s.set_var("n", c.int(0)),
    s.foreach({ list: inp("rows"), as: "row", body: [
      s.update_var("n", withFilters(ref("n"), fl.add(c.int(1)))),
      s.set_var("line", withFilters(ref("row"), fl.get("line"), fl.first_notempty(ref("n")), fl.to_int())),
      s.set_var("given", withFilters(ref("row"), fl.get("people"), fl.first_notnull(c.array([])))),
      s.set_var("problem", c.text("")),
      s.set_var("clean", c.array([])),
      s.foreach({ list: ref("open_roles"), as: "need", body: [
        s.set_var("found", c.null()),
        s.foreach({ list: ref("given"), as: "g", body: [
          s.set_var("g_role", withFilters(ref("g"), fl.get("role_id"), fl.first_notempty(c.int(0)), fl.to_int())),
          s.conditional({ when: expr(ref("g_role"), "=", ref("need.id")), then: [s.update_var("found", ref("g"))] }),
        ] }),
        s.set_var("f_name", withFilters(ref("found"), fl.get("name"), fl.first_notnull(c.text("")), fl.trim())),
        s.set_var("f_email", withFilters(ref("found"), fl.get("email"), fl.first_notnull(c.text("")), fl.trim(), fl.lower())),
        s.conditional({ when: expr(ref("problem"), "=", c.text("")), then: [
          s.conditional({ when: expr(withFilters(ref("f_name"), fl.strlen()), "<", c.int(1)), then: [
            s.update_var("problem", withFilters(c.text("No name for "), fl.concat(ref("need.role_name")), fl.concat(c.text(".")))),
          ], elif: [{ when: expr(withFilters(c.regex(EMAIL), fl.regex_test(ref("f_email"))), "=", c.bool(false)), then: [
            s.update_var("problem", withFilters(c.text("Check the email for "), fl.concat(ref("need.role_name")), fl.concat(c.text(".")))),
          ] }] }),
        ] }),
        s.update_var("clean", withFilters(ref("clean"), fl.array_push(obj({ role_id: ref("need.id"), name: withFilters(ref("f_name"), fl.substr(c.int(0), c.int(120))), email: ref("f_email") })))),
      ] }),
      s.set_var("status", c.text("pending")),
      s.conditional({ when: expr(ref("problem"), "!=", c.text("")), then: [s.update_var("status", c.text("failed")), s.update_var("bad", withFilters(ref("bad"), fl.add(c.int(1))))] }),
      s.update_var("items", withFilters(ref("items"), fl.array_push(obj({
        bulk_send_id: ref("bulk.id"), line: ref("line"), people: ref("clean"), status: ref("status"), envelope_id: c.int(0), error: ref("problem"),
      })))),
    ] }),
    s.db.bulk.add({ table: bulk_send_row, items: ref("items"), as: "rows_made" }),
    s.db.patch({ table: bulk_send, fieldValue: ref("bulk.id"), data: obj({ failed: ref("bad") }), as: "counted" }),
    changed({ entity: "bulk_send", id: ref("bulk.id"), op: "created", actor: inp("actor_id") }),
    // Start straight away rather than waiting for the next minute.
    s.util.post_process([s.function.run({ fn: "bulk/step", as: "first_batch" })]),
  ],
  response: obj({ bulk_send_id: ref("bulk.id"), total: ref("row_count"), failed: ref("bad") }),
});

/** One batch: send the next rows still pending, then close any bulk send with nothing left. Safe to run again at any point. */
export const bulkStepFn = defineFunction({
  name: "bulk/step",
  description: "Send the next batch of bulk-send rows, and mark finished bulk sends done.",
  stack: [
    s.db.query({ table: bulk_send_row, where: cmp(col("status"), "=", c.text("pending")), sort: [{ sortBy: "id", dir: "asc" }], paging: { per_page: c.int(BATCH), page: c.int(1) }, as: "due" }),
    s.foreach({ list: ref("due.items"), as: "row", body: [
      s.db.get({ table: bulk_send, fieldValue: ref("row.bulk_send_id"), output: ["id", "template_id", "sender_id", "title", "status"], as: "bs" }),
      s.conditional({ when: expr(ref("bs.status", { safe: true }), "=", c.text("cancelled")), then: [
        s.db.patch({ table: bulk_send_row, fieldValue: ref("row.id"), data: obj({ status: c.text("failed"), error: c.text("Not sent: the bulk send was stopped.") }), as: "skipped" }),
      ], else: [
        s.set_var("row_key", withFilters(c.text("bulk:"), fl.concat(ref("row.id")))),
        s.try_catch({
          try: [
            s.function.run({ fn: instantiateFn, as: "made", input: {
              template_id: ref("bs.template_id"), sender_id: ref("bs.sender_id"), people: ref("row.people"), title: ref("bs.title"),
              origin_key: ref("row_key"), bulk_send_id: ref("bs.id"),
            } }),
            s.db.get({ table: envelope, fieldValue: ref("made.envelope_id"), output: ["id", "status"], as: "copy" }),
            guard.found("copy", { errorType: "notfound", message: "This row's document couldn't be made." }),
            s.conditional({ when: expr(ref("copy.status"), "=", c.text("draft")), then: [
              s.function.run({ fn: sendFn, as: "sent", input: { actor_id: ref("bs.sender_id"), envelope_id: ref("copy.id"), ip: c.text(""), user_agent: c.text("bulk send") } }),
            ] }),
            s.db.patch({ table: bulk_send_row, fieldValue: ref("row.id"), data: obj({ status: c.text("sent"), envelope_id: ref("copy.id"), error: c.text("") }), as: "done_row" }),
            changed({ entity: "bulk_send", id: ref("bs.id"), actor: ref("bs.sender_id") }),
          ],
          catch: [
            s.set_var("why", withFilters(caught("message"), fl.first_notempty(c.text("This row couldn't be sent.")), fl.substr(c.int(0), c.int(300)))),
            s.db.patch({ table: bulk_send_row, fieldValue: ref("row.id"), data: obj({ status: c.text("failed"), error: ref("why") }), as: "failed_row" }),
          ],
        }),
      ] }),
    ] }),
    // Counts come from the rows themselves, so a row run twice is never counted twice. Every running bulk send with nothing
    // pending is done (one with only bad rows finishes here too).
    s.db.query({ table: bulk_send, where: [cmp(col("status"), "in", c.array(["running", "cancelled"])), cmp(col("finished_at"), "=", c.null())], output: ["id", "sender_id", "status", "sent", "failed"], as: "open_sends" }),
    s.set_var("now_ms", c.now()),
    s.foreach({ list: ref("open_sends"), as: "rb", body: [
      s.db.query({ table: bulk_send_row, where: [cmp(col("bulk_send_id"), "=", ref("rb.id")), cmp(col("status"), "=", c.text("pending"))], returnType: "count", as: "left" }),
      s.db.query({ table: bulk_send_row, where: [cmp(col("bulk_send_id"), "=", ref("rb.id")), cmp(col("status"), "=", c.text("sent"))], returnType: "count", as: "n_sent" }),
      s.db.query({ table: bulk_send_row, where: [cmp(col("bulk_send_id"), "=", ref("rb.id")), cmp(col("status"), "=", c.text("failed"))], returnType: "count", as: "n_failed" }),
      s.set_var("tally", obj({ sent: ref("n_sent"), failed: ref("n_failed") })),
      s.conditional({ when: expr(ref("left"), "=", c.int(0)), then: [
        s.update_var("tally", withFilters(ref("tally"), fl.set("finished_at", ref("now_ms")))),
        s.conditional({ when: expr(ref("rb.status"), "=", c.text("running")), then: [s.update_var("tally", withFilters(ref("tally"), fl.set("status", c.text("done"))))] }),
      ] }),
      s.conditional({ when: expr(c.expression("$var.n_sent != $var.rb.sent || $var.n_failed != $var.rb.failed || $var.left == 0"), "=", c.bool(true)), then: [
        s.db.patch({ table: bulk_send, fieldValue: ref("rb.id"), data: ref("tally"), as: "tallied" }),
        changed({ entity: "bulk_send", id: ref("rb.id"), actor: ref("rb.sender_id") }),
      ] }),
    ] }),
  ],
  response: obj({ processed: withFilters(ref("due.items"), fl.count()) }),
});

/** A bulk send's progress, with every row that failed and why. For whoever started it, or anyone who reads every envelope. */
export const bulkDetailFn = defineFunction({
  name: "bulk/detail",
  description: "A bulk send's progress and its failed rows.",
  input: { actor_id: input.int({ required: true }), bulk_send_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    s.db.get({ table: bulk_send, fieldValue: inp("bulk_send_id"), as: "bs" }),
    guard.found("bs", { errorType: "notfound", message: "That bulk send doesn't exist, or you can't see it." }),
    s.conditional({ when: expr(ref("bs.sender_id"), "!=", ref("actor.id")), then: [
      rbac.allows(ref("actor.role"), "envelope.read_all", "Only the person who started this bulk send can see it."),
    ] }),
    s.db.query({ table: bulk_send_row, where: [cmp(col("bulk_send_id"), "=", ref("bs.id")), cmp(col("status"), "=", c.text("failed"))], sort: [{ sortBy: "line", dir: "asc" }], output: ["line", "people", "error"], as: "failed_rows" }),
  ],
  response: obj({ bulk: ref("bs"), failed_rows: ref("failed_rows") }),
});

/** Stop a running bulk send: rows not yet sent are marked cancelled. Documents already sent stay out. */
export const bulkCancelFn = defineFunction({
  name: "bulk/cancel",
  description: "Stop a bulk send. What's already gone out stays out.",
  input: { actor_id: input.int({ required: true }), bulk_send_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    s.db.get({ table: bulk_send, fieldValue: inp("bulk_send_id"), as: "bs" }),
    guard.found("bs", { errorType: "notfound", message: "That bulk send doesn't exist, or you can't see it." }),
    s.conditional({ when: expr(ref("bs.sender_id"), "!=", ref("actor.id")), then: [
      rbac.allows(ref("actor.role"), "envelope.read_all", "Only the person who started this bulk send can stop it."),
    ] }),
    s.conditional({ when: expr(ref("bs.status"), "=", c.text("running")), then: [
      s.db.patch({ table: bulk_send, fieldValue: ref("bs.id"), data: obj({ status: c.text("cancelled") }), as: "stopped" }),
      changed({ entity: "bulk_send", id: ref("bs.id"), actor: inp("actor_id") }),
    ] }),
  ],
  response: obj({ ok: c.bool(true) }),
});

export const bulkFunctions = [bulkCreateFn, bulkStepFn, bulkDetailFn, bulkCancelFn];
