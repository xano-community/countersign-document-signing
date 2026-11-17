// Preparing a draft: who's on it, where their fields go, and how it's sent. Everything here works on drafts only, for the
// person who sent it (or an admin who reads every envelope). The prepare screen saves whole lists, so a save is always
// "make it look like this", and a retried save lands the same way.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { envelope } from "../../table/envelope/envelope.js";
import { FIELD_TYPES, field } from "../../table/envelope/field.js";
import { IDENTITY_CHECKS, RECIPIENT_ROLES, recipient } from "../../table/envelope/recipient.js";

export const MOST_RECIPIENTS = 20;
export const MOST_FIELDS = 300;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Binds `actor`, an active member, or refuses. */
export const loadActor = (id: Value = inp("actor_id")) => statements(
  s.db.get({ table: user, fieldValue: id, output: ["id", "name", "email", "role", "status"], as: "actor" }),
  guard.found("actor", { errorType: "unauthorized", message: "Sign in to continue." }),
  guard.require(expr(ref("actor.status"), "=", c.text("active")), { errorType: "unauthorized", message: "Your access to this workspace has ended." }),
);

/** Binds `env`, a draft this actor may edit: they sent it, or they read every envelope. */
export const requireDraft = (id: Value = inp("envelope_id")) => statements(
  ...loadActor(),
  rbac.allows(ref("actor.role"), "envelope.send", "You can read documents here, but not prepare or send them."),
  s.db.get({ table: envelope, fieldValue: id, as: "env" }),
  guard.found("env", { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
  s.conditional({ when: expr(ref("env.sender_id"), "!=", ref("actor.id")), then: [
    rbac.allows(ref("actor.role"), "envelope.read_all", "Only the person who started this document can change it."),
  ] }),
  guard.require(expr(ref("env.status"), "=", c.text("draft")), { errorType: "badrequest", message: "This document has been sent, so it can't be edited. Duplicate it to make changes." }),
);

const textRule = (v: Value, most: number, message: string) =>
  guard.require(expr(withFilters(v, fl.first_notnull(c.text("")), fl.strlen()), "<=", c.int(most)), { errorType: "badrequest", message });

export const updateDraft = defineFunction({
  name: "envelope/update_draft",
  description: "Change a draft's title, message, deadline, reminders, visibility or signing order.",
  input: {
    actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }),
    title: input.text({ methods: ["trim"] }), subject: input.text({ methods: ["trim"] }), message: input.text(),
    expiry_days: input.int(), reminder_days: input.int(), visibility: input.text(), signing_order: input.text(),
  },
  stack: [
    ...requireDraft(),
    guard.require(expr(withFilters(inp("title"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Give the document a title." }),
    textRule(inp("title"), 200, "Keep the title under 200 characters."),
    textRule(inp("subject"), 200, "Keep the email subject under 200 characters."),
    textRule(inp("message"), 2000, "Keep the message under 2,000 characters."),
    guard.require(and(expr(inp("expiry_days"), ">=", c.int(1)), expr(inp("expiry_days"), "<=", c.int(365))), { errorType: "badrequest", message: "Set a deadline between 1 and 365 days." }),
    guard.require(and(expr(inp("reminder_days"), ">=", c.int(0)), expr(inp("reminder_days"), "<=", c.int(30))), { errorType: "badrequest", message: "Remind every 1 to 30 days, or never." }),
    guard.require(expr(withFilters(c.array(["private", "team"]), fl.in(inp("visibility"))), "=", c.bool(true)), { errorType: "badrequest", message: "Choose who on the team can see this document." }),
    guard.require(expr(withFilters(c.array(["parallel", "ordered"]), fl.in(inp("signing_order"))), "=", c.bool(true)), { errorType: "badrequest", message: "Choose an order to sign in." }),
    s.set_var("now_ms", c.now()),
    s.db.patch({ table: envelope, fieldValue: inp("envelope_id"), data: obj({
      title: inp("title"), subject: inp("subject"), message: inp("message"), expiry_days: inp("expiry_days"), reminder_days: inp("reminder_days"),
      visibility: inp("visibility"), signing_order: inp("signing_order"), updated_at: ref("now_ms"),
    }), as: "saved" }),
    changed({ entity: "envelope", id: inp("envelope_id"), actor: inp("actor_id") }),
  ],
  response: ref("saved"),
});

/**
 * Make a draft's recipients exactly this list: rows with an `id` are updated, rows without are added, and anyone left out
 * is removed with their fields. Each item: { id?, name, email, role, step, identity_check, access_code? }. An access code
 * left blank on an existing recipient keeps the one they had.
 */
export const saveRecipients = defineFunction({
  name: "envelope/save_recipients",
  description: "Replace a draft's recipients with this list, keeping the ones that carry an id.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), recipients: input.json({ required: true }) },
  stack: [
    ...requireDraft(),
    guard.require(expr(withFilters(inp("recipients"), fl.count()), "<=", c.int(MOST_RECIPIENTS)), { errorType: "badrequest", message: `A document can have up to ${MOST_RECIPIENTS} people.` }),
    s.set_var("keep", c.array([])),
    s.set_var("position", c.int(0)),
    s.foreach({ list: inp("recipients"), as: "item", body: [
      s.update_var("position", withFilters(ref("position"), fl.add(c.int(1)))),
      s.set_var("r_name", withFilters(ref("item"), fl.get("name"), fl.first_notnull(c.text("")), fl.trim())),
      s.set_var("r_email", withFilters(ref("item"), fl.get("email"), fl.first_notnull(c.text("")), fl.trim(), fl.lower())),
      s.set_var("r_role", withFilters(ref("item"), fl.get("role"), fl.first_notempty(c.text("signer")))),
      s.set_var("r_role_name", withFilters(ref("item"), fl.get("role_name"), fl.first_notnull(c.text("")), fl.trim())),
      s.set_var("r_check", withFilters(ref("item"), fl.get("identity_check"), fl.first_notempty(c.text("none")))),
      s.set_var("r_code", withFilters(ref("item"), fl.get("access_code"), fl.first_notnull(c.text("")), fl.trim())),
      s.set_var("r_step", withFilters(ref("item"), fl.get("step"), fl.first_notempty(c.int(1)), fl.to_int())),
      s.conditional({ when: expr(ref("env.signing_order"), "=", c.text("parallel")), then: [s.update_var("r_step", c.int(1))] }),
      guard.require(expr(withFilters(c.array([...RECIPIENT_ROLES]), fl.in(ref("r_role"))), "=", c.bool(true)), { errorType: "badrequest", message: "Each person needs a role: signer, approver, viewer or copy." }),
      guard.require(expr(withFilters(c.array([...IDENTITY_CHECKS]), fl.in(ref("r_check"))), "=", c.bool(true)), { errorType: "badrequest", message: "Choose how each person proves who they are." }),
      guard.require(and(expr(ref("r_step"), ">=", c.int(1)), expr(ref("r_step"), "<=", c.int(MOST_RECIPIENTS))), { errorType: "badrequest", message: "Signing steps run from 1 upwards." }),
      // A template's recipients are roles; a document's are people.
      s.conditional({ when: expr(ref("env.is_template"), "=", c.bool(true)), then: [
        guard.require(expr(withFilters(ref("r_role_name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Name each role, like \"Client\" or \"Manager\"." }),
      ], else: [
        guard.require(expr(withFilters(ref("r_name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Each person needs a name." }),
        guard.require(expr(withFilters(c.regex(EMAIL), fl.regex_test(ref("r_email"))), "=", c.bool(true)), { errorType: "badrequest", message: "Check each person's email address." }),
      ] }),
      guard.require(expr(withFilters(ref("r_name"), fl.strlen()), "<=", c.int(120)), { errorType: "badrequest", message: "Keep names under 120 characters." }),
      s.set_var("r_code_hash", c.null()),
      s.conditional({ when: expr(withFilters(ref("r_code"), fl.strlen()), ">", c.int(0)), then: [
        guard.require(and(expr(withFilters(ref("r_code"), fl.strlen()), ">=", c.int(4)), expr(withFilters(ref("r_code"), fl.strlen()), "<=", c.int(40))), { errorType: "badrequest", message: "An access code needs 4 to 40 characters." }),
        s.update_var("r_code_hash", withFilters(ref("r_code"), fl.sha256())),
      ] }),
      // Match by id within this envelope only, so a list can't reach another envelope's people.
      s.set_var("r_id", withFilters(ref("item"), fl.get("id"), fl.first_notempty(c.int(0)), fl.to_int())),
      s.set_var("existing", c.null()),
      s.conditional({ when: expr(ref("r_id"), ">", c.int(0)), then: [
        s.db.query({ table: recipient, where: [cmp(col("id"), "=", ref("r_id")), cmp(col("envelope_id"), "=", inp("envelope_id"))], returnType: "single", output: ["id", "access_code_hash"], as: "found" }),
        s.update_var("existing", ref("found")),
      ] }),
      s.set_var("person_id", c.int(0)),
      s.conditional({ when: expr(withFilters(ref("r_email"), fl.strlen()), ">", c.int(0)), then: [
        s.db.query({ table: user, where: [cmp(col("email"), "=", ref("r_email")), cmp(col("status"), "=", c.text("active"))], returnType: "single", output: ["id"], as: "member" }),
        s.conditional({ when: expr(ref("member"), "!=", c.null()), then: [s.update_var("person_id", ref("member.id", { safe: true }))] }),
      ] }),
      s.set_var("row", obj({
        envelope_id: inp("envelope_id"), name: ref("r_name"), email: ref("r_email"), role: ref("r_role"), role_name: ref("r_role_name"),
        step: ref("r_step"), color: ref("position"), identity_check: ref("r_check"), user_id: ref("person_id"), is_demo: ref("env.is_demo"),
      })),
      s.conditional({ when: expr(ref("r_code_hash"), "!=", c.null()), then: [s.update_var("row", withFilters(ref("row"), fl.set("access_code_hash", ref("r_code_hash"))))] }),
      s.conditional({ when: and(expr(ref("r_check"), "=", c.text("access_code")), expr(ref("r_code_hash"), "=", c.null()), expr(ref("existing.access_code_hash", { safe: true }), "=", c.null())), then: [
        guard.require(expr(c.bool(false), "=", c.bool(true)), { errorType: "badrequest", message: "Set an access code for everyone who needs one." }),
      ] }),
      s.conditional({ when: expr(ref("existing"), "!=", c.null()), then: [
        s.set_var("existing_id", withFilters(ref("existing"), fl.get("id"))),
        s.db.patch({ table: recipient, fieldValue: ref("existing_id"), data: ref("row"), as: "kept" }),
        s.update_var("keep", withFilters(ref("keep"), fl.array_push(ref("kept.id")))),
      ], else: [
        s.db.add({ table: recipient, row: {
          envelope_id: inp("envelope_id"), name: ref("r_name"), email: ref("r_email"), role: ref("r_role"), role_name: ref("r_role_name"),
          step: ref("r_step"), color: ref("position"), identity_check: ref("r_check"), access_code_hash: ref("r_code_hash"),
          user_id: ref("person_id"), status: c.text("waiting"), round: c.int(1), is_demo: ref("env.is_demo"),
        }, as: "added" }),
        s.update_var("keep", withFilters(ref("keep"), fl.array_push(ref("added.id")))),
      ] }),
    ] }),
    // Whoever is no longer on the list goes, with their fields.
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", inp("envelope_id")), output: ["id"], as: "before" }),
    s.foreach({ list: ref("before"), as: "old", body: [
      s.conditional({ when: expr(withFilters(ref("keep"), fl.in(ref("old.id"))), "=", c.bool(false)), then: [
        s.db.bulk.delete({ table: field, where: cmp(col("recipient_id"), "=", ref("old.id")), as: "fields_gone" }),
        s.db.del({ table: recipient, fieldValue: ref("old.id") }),
      ] }),
    ] }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "color", dir: "asc" }], output: ["id", "name", "email", "role", "role_name", "step", "color", "identity_check", "user_id"], as: "saved" }),
    changed({ entity: "envelope", id: inp("envelope_id"), actor: inp("actor_id") }),
  ],
  response: ref("saved"),
});

/**
 * Make a draft's fields exactly this list. Each item: { recipient_id, type, page, x, y, w, h, required, label, options,
 * validation }, with x/y/w/h as fractions of the displayed page. A field must sit on the page and belong to someone on it.
 */
export const saveFields = defineFunction({
  name: "envelope/save_fields",
  description: "Replace a draft's fields with this list.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), fields: input.json({ required: true }) },
  stack: [
    ...requireDraft(),
    guard.require(expr(withFilters(inp("fields"), fl.count()), "<=", c.int(MOST_FIELDS)), { errorType: "badrequest", message: `A document can have up to ${MOST_FIELDS} fields.` }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", inp("envelope_id")), output: ["id", "role"], as: "people" }),
    s.set_var("people_ids", c.array([])),
    s.foreach({ list: ref("people"), as: "pp", body: [s.update_var("people_ids", withFilters(ref("people_ids"), fl.array_push(ref("pp.id"))))] }),
    s.set_var("rows", c.array([])),
    s.foreach({ list: inp("fields"), as: "item", body: [
      s.set_var("f_rid", withFilters(ref("item"), fl.get("recipient_id"), fl.first_notempty(c.int(0)), fl.to_int())),
      s.set_var("f_type", withFilters(ref("item"), fl.get("type"), fl.first_notnull(c.text("")))),
      s.set_var("f_page", withFilters(ref("item"), fl.get("page"), fl.first_notempty(c.int(0)), fl.to_int())),
      s.set_var("f_x", withFilters(ref("item"), fl.get("x"), fl.first_notempty(c.int(0)), fl.to_decimal())),
      s.set_var("f_y", withFilters(ref("item"), fl.get("y"), fl.first_notempty(c.int(0)), fl.to_decimal())),
      s.set_var("f_w", withFilters(ref("item"), fl.get("w"), fl.first_notempty(c.int(0)), fl.to_decimal())),
      s.set_var("f_h", withFilters(ref("item"), fl.get("h"), fl.first_notempty(c.int(0)), fl.to_decimal())),
      guard.require(expr(withFilters(ref("people_ids"), fl.in(ref("f_rid"))), "=", c.bool(true)), { errorType: "badrequest", message: "A field belongs to someone who isn't on this document." }),
      guard.require(expr(withFilters(c.array([...FIELD_TYPES]), fl.in(ref("f_type"))), "=", c.bool(true)), { errorType: "badrequest", message: "That kind of field isn't supported." }),
      guard.require(and(expr(ref("f_page"), ">=", c.int(1)), expr(ref("f_page"), "<=", ref("env.page_count"))), { errorType: "badrequest", message: "A field is on a page this document doesn't have." }),
      guard.require(and(expr(ref("f_x"), ">=", c.int(0)), expr(ref("f_y"), ">=", c.int(0)), expr(ref("f_w"), ">", c.int(0)), expr(ref("f_h"), ">", c.int(0)),
        expr(withFilters(ref("f_x"), fl.add(ref("f_w"))), "<=", c.decimal(1.001)), expr(withFilters(ref("f_y"), fl.add(ref("f_h"))), "<=", c.decimal(1.001))),
        { errorType: "badrequest", message: "A field runs off the edge of its page." }),
      textRule(withFilters(ref("item"), fl.get("label")), 120, "Keep field labels under 120 characters."),
      s.update_var("rows", withFilters(ref("rows"), fl.array_push(obj({
        envelope_id: inp("envelope_id"), recipient_id: ref("f_rid"), type: ref("f_type"), page: ref("f_page"),
        x: ref("f_x"), y: ref("f_y"), w: ref("f_w"), h: ref("f_h"),
        required: withFilters(ref("item"), fl.get("required"), fl.first_notnull(c.bool(true)), fl.to_bool()),
        label: withFilters(ref("item"), fl.get("label"), fl.first_notnull(c.text(""))),
        options: withFilters(ref("item"), fl.get("options"), fl.first_notnull(c.array([]))),
        validation: withFilters(ref("item"), fl.get("validation"), fl.first_notnull(obj({}))),
      })))),
    ] }),
    s.db.bulk.delete({ table: field, where: cmp(col("envelope_id"), "=", inp("envelope_id")), as: "cleared" }),
    s.conditional({ when: expr(withFilters(ref("rows"), fl.count()), ">", c.int(0)), then: [
      s.db.bulk.add({ table: field, items: ref("rows"), as: "added" }),
    ] }),
    s.db.query({ table: field, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "id", dir: "asc" }], as: "saved" }),
    changed({ entity: "envelope", id: inp("envelope_id"), actor: inp("actor_id") }),
  ],
  response: ref("saved"),
});

/**
 * What stops a draft from being sent, each in plain words. Empty means it's ready. The Review step shows this list, and
 * sending refuses while it isn't empty.
 */
export const sendProblems = defineFunction({
  name: "envelope/send_problems",
  description: "List what must be fixed before a draft can be sent.",
  input: { envelope_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), as: "e" }),
    guard.found("e", { errorType: "notfound", message: "That document doesn't exist." }),
    s.set_var("problems", c.array([])),
    s.conditional({ when: expr(withFilters(ref("e.original_file_id"), fl.first_notempty(c.int(0))), "=", c.int(0)), then: [
      s.update_var("problems", withFilters(ref("problems"), fl.array_push(obj({ code: c.text("no_document"), message: c.text("Add the document to send.") })))),
    ] }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "color", dir: "asc" }], as: "people" }),
    s.conditional({ when: expr(withFilters(ref("people"), fl.count()), "=", c.int(0)), then: [
      s.update_var("problems", withFilters(ref("problems"), fl.array_push(obj({ code: c.text("no_recipients"), message: c.text("Add at least one person to sign.") })))),
    ] }),
    s.db.query({ table: field, where: cmp(col("envelope_id"), "=", inp("envelope_id")), as: "fields" }),
    s.foreach({ list: ref("people"), as: "p", body: [
      s.set_var("who", withFilters(ref("p.name"), fl.first_notempty(ref("p.role_name")))),
      // Every person on a document needs a name and an address (a template's roles don't: they're filled in each time it's used).
      s.conditional({ when: expr(ref("e.is_template", { safe: true }), "!=", c.bool(true)), then: [
        s.set_var("p_email_ok", withFilters(c.regex(EMAIL), fl.regex_test(withFilters(ref("p.email"), fl.first_notnull(c.text("")))))),
        s.conditional({ when: expr(withFilters(ref("p.name"), fl.first_notnull(c.text("")), fl.trim()), "=", c.text("")), then: [
          s.update_var("problems", withFilters(ref("problems"), fl.array_push(obj({ code: c.text("no_person"), recipient_id: ref("p.id"), message: withFilters(c.text("Add a name for "), fl.concat(ref("who")), fl.concat(c.text("."))) })))),
        ], elif: [{ when: expr(ref("p_email_ok"), "=", c.bool(false)), then: [
          s.update_var("problems", withFilters(ref("problems"), fl.array_push(obj({ code: c.text("no_person"), recipient_id: ref("p.id"), message: withFilters(c.text("Add an email address for "), fl.concat(ref("who")), fl.concat(c.text("."))) })))),
        ] }] }),
      ] }),
      s.db.query({ table: field, where: [cmp(col("recipient_id"), "=", ref("p.id")), cmp(col("type"), "=", c.text("signature"))], returnType: "count", as: "sig_count" }),
      s.db.query({ table: field, where: cmp(col("recipient_id"), "=", ref("p.id")), returnType: "count", as: "field_count" }),
      s.conditional({ when: and(expr(ref("p.role"), "=", c.text("signer")), expr(ref("sig_count"), "=", c.int(0))), then: [
        s.update_var("problems", withFilters(ref("problems"), fl.array_push(obj({ code: c.text("no_signature"), recipient_id: ref("p.id"), message: withFilters(ref("who"), fl.concat(c.text(" has no signature field."))) })))),
      ] }),
      s.conditional({ when: and(expr(ref("p.role"), "=", c.text("cc")), expr(ref("field_count"), ">", c.int(0))), then: [
        s.update_var("problems", withFilters(ref("problems"), fl.array_push(obj({ code: c.text("cc_fields"), recipient_id: ref("p.id"), message: withFilters(ref("who"), fl.concat(c.text(" only gets a copy, so they can't have fields."))) })))),
      ] }),
    ] }),
    s.foreach({ list: ref("fields"), as: "fd", body: [
      s.conditional({ when: and(
        expr(withFilters(c.array(["radio", "dropdown"]), fl.in(ref("fd.type"))), "=", c.bool(true)),
        expr(withFilters(ref("fd.options"), fl.first_notnull(c.array([])), fl.count()), "<", c.int(2)),
      ), then: [
        s.set_var("kind_word", withFilters(ref("fd.type"), fl.string_replace(c.text("radio"), c.text("choice")))),
        s.update_var("problems", withFilters(ref("problems"), fl.array_push(obj({
          code: c.text("no_options"), field_id: ref("fd.id"),
          message: withFilters(c.text("The "), fl.concat(ref("kind_word")), fl.concat(c.text(" on page ")), fl.concat(ref("fd.page")), fl.concat(c.text(" needs at least two options."))),
        })))),
      ] }),
    ] }),
  ],
  response: ref("problems"),
});
