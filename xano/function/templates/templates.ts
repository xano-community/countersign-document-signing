// Templates: a document prepared once, with roles ("Client", "Manager") where the people go, sent again and again. A template
// is an envelope with `is_template` set, so the prepare screen edits it like any draft. Using one copies its document, its roles
// (now people) and its fields into a fresh draft, which can be sent straight away. Bulk sends and public links use it too.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { field } from "../../table/envelope/field.js";
import { public_link } from "../../table/envelope/public_link.js";
import { user } from "../../table/user.js";
import { audit } from "../audit/audit.js";
import { canRead } from "../envelope/access.js";
import { newPublicId } from "../envelope/create.js";
import { loadActor } from "../envelope/draft.js";
import { readScope, visible } from "../envelope/list.js";
import { sendFn } from "../envelope/send.js";

/** Binds `tpl`, a template this actor may see, or refuses. */
const readableTemplate = (id: Value = inp("template_id")) => statements(
  s.db.get({ table: envelope, fieldValue: id, as: "tpl" }),
  guard.found("tpl", { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
  guard.require(expr(ref("tpl.is_template"), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
  s.function.run({ fn: canRead, as: "may_read", input: { actor_id: inp("actor_id"), envelope_id: ref("tpl.id") } }),
  guard.require(expr(ref("may_read"), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
);

/** The word a role gets when it has no name of its own: "Signer 2". */
const ROLE_WORD = { signer: "Signer", approver: "Approver", viewer: "Viewer", cc: "Copy" } as const;

/**
 * A new draft from a template. `people` is a list of { role_id, name, email, identity_check? }: a role left out keeps the
 * name and email the template gives it (a fixed countersigner, say). An `origin_key` makes it safe to run again: a second run
 * with the same key answers the envelope the first one made. No permission checks: callers check first.
 */
export const instantiateFn = defineFunction({
  name: "template/instantiate",
  description: "Make a draft envelope from a template, filling its roles with people.",
  input: {
    template_id: input.int({ required: true }), sender_id: input.int({ required: true }), people: input.json(),
    title: input.text({ methods: ["trim"] }), origin_key: input.text(), bulk_send_id: input.int(),
  },
  stack: [
    s.db.get({ table: envelope, fieldValue: inp("template_id"), as: "tpl" }),
    guard.found("tpl", { errorType: "notfound", message: "That template doesn't exist." }),
    guard.require(expr(ref("tpl.is_template"), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist." }),
    s.set_var("origin", withFilters(inp("origin_key"), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("origin"), "!=", c.text("")), then: [
      s.db.query({ table: envelope, where: cmp(col("origin_key"), "=", ref("origin")), output: ["id"], returnType: "single", as: "earlier" }),
      s.conditional({ when: expr(ref("earlier"), "!=", c.null()), then: [s.return(obj({ envelope_id: withFilters(ref("earlier"), fl.get("id")), repeat: c.bool(true) }))] }),
    ] }),
    ...newPublicId,
    guard.require(expr(ref("public_id"), "!=", c.text("")), { errorType: "badrequest", message: "This document couldn't be created. Try again." }),
    s.set_var("t_title", withFilters(inp("title"), fl.first_notnull(c.text("")), fl.substr(c.int(0), c.int(200)))),
    s.conditional({ when: expr(ref("t_title"), "=", c.text("")), then: [s.update_var("t_title", ref("tpl.title"))] }),
    s.set_var("now_ms", c.now()),
    s.db.add({ table: envelope, as: "made", row: {
      public_id: ref("public_id"), title: ref("t_title"), status: c.text("draft"), sender_id: inp("sender_id"), visibility: ref("tpl.visibility"),
      signing_order: ref("tpl.signing_order"), subject: ref("tpl.subject"), message: ref("tpl.message"), expiry_days: ref("tpl.expiry_days"),
      reminder_days: ref("tpl.reminder_days"), original_file_id: ref("tpl.original_file_id"), original_sha256: ref("tpl.original_sha256"),
      page_count: ref("tpl.page_count"), pages: ref("tpl.pages"), sources: ref("tpl.sources"), is_template: c.bool(false),
      template_id: ref("tpl.id"), bulk_send_id: withFilters(inp("bulk_send_id"), fl.first_notempty(c.int(0))), origin_key: ref("origin"),
      is_demo: ref("tpl.is_demo"), updated_at: ref("now_ms"),
    } }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("tpl.id")), sort: [{ sortBy: "color", dir: "asc" }], as: "roles" }),
    s.set_var("people_in", withFilters(inp("people"), fl.first_notnull(c.array([])))),
    s.set_var("idmap", obj({})),
    s.foreach({ list: ref("roles"), as: "role", body: [
      s.set_var("p_name", withFilters(ref("role.name"), fl.first_notnull(c.text("")))),
      s.set_var("p_email", withFilters(ref("role.email"), fl.first_notnull(c.text("")))),
      s.set_var("p_check", ref("role.identity_check")),
      s.foreach({ list: ref("people_in"), as: "pp", body: [
        s.set_var("pp_role", withFilters(ref("pp"), fl.get("role_id"), fl.first_notempty(c.int(0)), fl.to_int())),
        s.conditional({ when: expr(ref("pp_role"), "=", ref("role.id")), then: [
          s.update_var("p_name", withFilters(ref("pp"), fl.get("name"), fl.first_notnull(c.text("")), fl.trim(), fl.substr(c.int(0), c.int(120)))),
          s.update_var("p_email", withFilters(ref("pp"), fl.get("email"), fl.first_notnull(c.text("")), fl.trim(), fl.lower())),
          s.set_var("pp_check", withFilters(ref("pp"), fl.get("identity_check"), fl.first_notnull(c.text("")))),
          s.conditional({ when: expr(withFilters(c.array(["none", "access_code", "email_code"]), fl.in(ref("pp_check"))), "=", c.bool(true)), then: [
            s.update_var("p_check", ref("pp_check")),
          ] }),
        ] }),
      ] }),
      // A team member on the document finds it in their own "Action required".
      s.set_var("p_member", c.int(0)),
      s.conditional({ when: expr(ref("p_email"), "!=", c.text("")), then: [
        s.db.query({ table: user, where: [cmp(col("email"), "=", ref("p_email")), cmp(col("status"), "=", c.text("active"))], returnType: "single", output: ["id"], as: "member" }),
        s.conditional({ when: expr(ref("member"), "!=", c.null()), then: [s.update_var("p_member", withFilters(ref("member"), fl.get("id")))] }),
      ] }),
      s.db.add({ table: recipient, as: "person", row: {
        envelope_id: ref("made.id"), name: ref("p_name"), email: ref("p_email"), role: ref("role.role"), role_name: ref("role.role_name"),
        step: ref("role.step"), color: ref("role.color"), identity_check: ref("p_check"), access_code_hash: ref("role.access_code_hash"),
        user_id: ref("p_member"), status: c.text("waiting"), round: c.int(1), is_demo: ref("tpl.is_demo"),
      } }),
      s.set_var("role_key", withFilters(ref("role.id"), fl.to_text())),
      s.update_var("idmap", withFilters(ref("idmap"), fl.set(ref("role_key"), ref("person.id")))),
    ] }),
    s.db.query({ table: field, where: cmp(col("envelope_id"), "=", ref("tpl.id")), sort: [{ sortBy: "id", dir: "asc" }], as: "tpl_fields" }),
    s.set_var("rows", c.array([])),
    s.foreach({ list: ref("tpl_fields"), as: "tf", body: [
      s.set_var("tf_key", withFilters(ref("tf.recipient_id"), fl.to_text())),
      s.update_var("rows", withFilters(ref("rows"), fl.array_push(obj({
        envelope_id: ref("made.id"), recipient_id: withFilters(ref("idmap"), fl.get(ref("tf_key"))), type: ref("tf.type"), page: ref("tf.page"),
        x: ref("tf.x"), y: ref("tf.y"), w: ref("tf.w"), h: ref("tf.h"), required: ref("tf.required"), label: ref("tf.label"),
        options: ref("tf.options"), validation: ref("tf.validation"),
      })))),
    ] }),
    s.conditional({ when: expr(withFilters(ref("rows"), fl.count()), ">", c.int(0)), then: [s.db.bulk.add({ table: field, items: ref("rows"), as: "fields_made" })] }),
    s.db.get({ table: user, fieldValue: inp("sender_id"), output: ["id", "name", "email"], as: "by" }),
    audit({
      envelope: ref("made.id"), kind: "envelope.created",
      actor: { type: c.text("user"), id: inp("sender_id"), name: ref("by.name", { safe: true }), email: ref("by.email", { safe: true }) },
      data: obj({ title: ref("t_title"), from_template: ref("tpl.id"), template_title: ref("tpl.title"), sha256: ref("tpl.original_sha256"), page_count: ref("tpl.page_count") }),
    }),
    changed({ entity: "envelope", id: ref("made.id"), op: "created", actor: inp("sender_id") }),
  ],
  response: obj({ envelope_id: ref("made.id"), repeat: c.bool(false) }),
  responseShape: {} as { envelope_id: number; repeat: boolean },
});

/** Every template this member can see, with its roles, how many fields it has, and its public link. */
export const listTemplatesFn = defineFunction({
  name: "template/list",
  description: "The templates a member can see, newest first, with their roles and public link.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...readScope,
    s.db.query({
      table: envelope, where: [cmp(col("is_template"), "=", c.bool(true)), visible()], sort: [{ sortBy: "updated_at", dir: "desc" }],
      output: ["id", "title", "sender_id", "visibility", "signing_order", "page_count", "pages", "original_file_id", "updated_at", "created_at"], as: "found",
    }),
    s.set_var("items", c.array([])),
    s.foreach({ list: ref("found"), as: "t", body: [
      s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("t.id")), sort: [{ sortBy: "color", dir: "asc" }], output: ["id", "role", "role_name", "name", "email", "step", "color"], as: "t_roles" }),
      s.db.query({ table: field, where: cmp(col("envelope_id"), "=", ref("t.id")), returnType: "count", as: "t_fields" }),
      s.db.get({ table: public_link, fieldName: "template_id", fieldValue: ref("t.id"), output: ["slug", "enabled", "uses"], as: "t_link" }),
      s.db.query({ table: envelope, where: cmp(col("template_id"), "=", ref("t.id")), returnType: "count", as: "t_uses" }),
      s.db.get({ table: user, fieldValue: ref("t.sender_id"), output: ["name"], as: "t_owner" }),
      s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("t"), fl.set("roles", ref("t_roles")), fl.set("field_count", ref("t_fields")),
        fl.set("public_link", ref("t_link")), fl.set("uses", ref("t_uses")), fl.set("owner_name", ref("t_owner.name", { safe: true })))))),
    ] }),
  ],
  response: obj({ items: ref("items") }),
});

/** Use a template: a new draft with these people in its roles, sent straight away when `send` is true. */
export const useTemplateFn = defineFunction({
  name: "template/use",
  description: "Make a draft from a template with these people, and send it if asked.",
  input: { actor_id: input.int({ required: true }), template_id: input.int({ required: true }), people: input.json(), title: input.text(), send: input.bool(), ip: input.text(), user_agent: input.text() },
  stack: [
    ...loadActor(),
    rbac.allows(ref("actor.role"), "envelope.send", "Your role can't send documents for signature."),
    ...readableTemplate(),
    s.function.run({ fn: instantiateFn, as: "made", input: { template_id: inp("template_id"), sender_id: ref("actor.id"), people: inp("people"), title: inp("title") } }),
    s.set_var("sent", c.null()),
    s.conditional({ when: expr(inp("send"), "=", c.bool(true)), then: [
      s.function.run({ fn: sendFn, as: "sent_now", input: { actor_id: ref("actor.id"), envelope_id: ref("made.envelope_id"), ip: inp("ip"), user_agent: inp("user_agent") } }),
      s.update_var("sent", ref("sent_now")),
    ] }),
  ],
  response: obj({ envelope_id: ref("made.envelope_id"), sent: ref("sent") }),
});

/** Save a document as a template: its document and fields, with each person turned into a role. The document itself is untouched. */
export const saveAsTemplateFn = defineFunction({
  name: "template/save_from",
  description: "Make a template from a document: the same file and fields, with roles where the people were.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), title: input.text({ methods: ["trim"] }) },
  stack: [
    ...loadActor(),
    rbac.allows(ref("actor.role"), "template.manage", "Your role can't make templates."),
    s.function.run({ fn: canRead, as: "may_read", input: { actor_id: inp("actor_id"), envelope_id: inp("envelope_id") } }),
    guard.require(expr(ref("may_read"), "=", c.bool(true)), { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), as: "src" }),
    guard.found("src", { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    guard.require(expr(ref("src.is_template"), "=", c.bool(false)), { errorType: "badrequest", message: "This is already a template." }),
    ...newPublicId,
    guard.require(expr(ref("public_id"), "!=", c.text("")), { errorType: "badrequest", message: "The template couldn't be created. Try again." }),
    s.set_var("t_title", withFilters(inp("title"), fl.first_notnull(c.text("")), fl.substr(c.int(0), c.int(200)))),
    s.conditional({ when: expr(ref("t_title"), "=", c.text("")), then: [s.update_var("t_title", ref("src.title"))] }),
    s.set_var("now_ms", c.now()),
    s.db.add({ table: envelope, as: "made", row: {
      public_id: ref("public_id"), title: ref("t_title"), status: c.text("draft"), sender_id: ref("actor.id"), visibility: c.text("team"),
      signing_order: ref("src.signing_order"), subject: ref("src.subject"), message: ref("src.message"), expiry_days: ref("src.expiry_days"),
      reminder_days: ref("src.reminder_days"), original_file_id: ref("src.original_file_id"), original_sha256: ref("src.original_sha256"),
      page_count: ref("src.page_count"), pages: ref("src.pages"), sources: ref("src.sources"), is_template: c.bool(true), is_demo: ref("src.is_demo"), updated_at: ref("now_ms"),
    } }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("src.id")), sort: [{ sortBy: "color", dir: "asc" }], as: "src_people" }),
    s.set_var("idmap", obj({})),
    // Unnamed people become "Signer 1", "Signer 2", "Copy": numbered only when there's more than one of a kind.
    s.set_var("kind_total", obj({})),
    s.foreach({ list: ref("src_people"), as: "kp", body: [
      s.set_var("kp_n", withFilters(ref("kind_total"), fl.get(ref("kp.role"), c.int(0)), fl.add(c.int(1)))),
      s.update_var("kind_total", withFilters(ref("kind_total"), fl.set(ref("kp.role"), ref("kp_n")))),
    ] }),
    s.set_var("kind_seen", obj({})),
    s.foreach({ list: ref("src_people"), as: "sp", body: [
      s.set_var("sp_word", withFilters(c.obj(ROLE_WORD), fl.get(ref("sp.role")))),
      s.set_var("sp_nth", withFilters(ref("kind_seen"), fl.get(ref("sp.role"), c.int(0)), fl.add(c.int(1)))),
      s.update_var("kind_seen", withFilters(ref("kind_seen"), fl.set(ref("sp.role"), ref("sp_nth")))),
      s.set_var("sp_of_kind", withFilters(ref("kind_total"), fl.get(ref("sp.role"), c.int(1)))),
      s.set_var("sp_name", withFilters(ref("sp.role_name"), fl.first_notnull(c.text("")))),
      s.conditional({ when: expr(ref("sp_name"), "=", c.text("")), then: [
        s.update_var("sp_name", ref("sp_word")),
        s.conditional({ when: expr(ref("sp_of_kind"), ">", c.int(1)), then: [
          s.update_var("sp_name", withFilters(ref("sp_word"), fl.concat(c.text(" ")), fl.concat(ref("sp_nth")))),
        ] }),
      ] }),
      s.db.add({ table: recipient, as: "role", row: {
        envelope_id: ref("made.id"), name: c.text(""), email: c.text(""), role: ref("sp.role"), role_name: ref("sp_name"), step: ref("sp.step"),
        color: ref("sp.color"), identity_check: ref("sp.identity_check"), user_id: c.int(0), status: c.text("waiting"), round: c.int(1), is_demo: ref("src.is_demo"),
      } }),
      s.set_var("sp_key", withFilters(ref("sp.id"), fl.to_text())),
      s.update_var("idmap", withFilters(ref("idmap"), fl.set(ref("sp_key"), ref("role.id")))),
    ] }),
    s.db.query({ table: field, where: cmp(col("envelope_id"), "=", ref("src.id")), sort: [{ sortBy: "id", dir: "asc" }], as: "src_fields" }),
    s.set_var("rows", c.array([])),
    s.foreach({ list: ref("src_fields"), as: "sf", body: [
      s.set_var("sf_key", withFilters(ref("sf.recipient_id"), fl.to_text())),
      s.update_var("rows", withFilters(ref("rows"), fl.array_push(obj({
        envelope_id: ref("made.id"), recipient_id: withFilters(ref("idmap"), fl.get(ref("sf_key"))), type: ref("sf.type"), page: ref("sf.page"),
        x: ref("sf.x"), y: ref("sf.y"), w: ref("sf.w"), h: ref("sf.h"), required: ref("sf.required"), label: ref("sf.label"),
        options: ref("sf.options"), validation: ref("sf.validation"),
      })))),
    ] }),
    s.conditional({ when: expr(withFilters(ref("rows"), fl.count()), ">", c.int(0)), then: [s.db.bulk.add({ table: field, items: ref("rows"), as: "fields_made" })] }),
    changed({ entity: "envelope", id: ref("made.id"), op: "created", actor: inp("actor_id") }),
  ],
  response: obj({ template_id: ref("made.id") }),
});

/** Delete a template. Documents already made from it keep their own copy of everything; the file stays for them. */
export const deleteTemplateFn = defineFunction({
  name: "template/delete",
  description: "Delete a template and its public link. Documents made from it are unaffected.",
  input: { actor_id: input.int({ required: true }), template_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    rbac.allows(ref("actor.role"), "template.manage", "Your role can't change templates."),
    ...readableTemplate(),
    s.db.bulk.delete({ table: field, where: cmp(col("envelope_id"), "=", ref("tpl.id")), as: "fields_gone" }),
    s.db.bulk.delete({ table: recipient, where: cmp(col("envelope_id"), "=", ref("tpl.id")), as: "roles_gone" }),
    s.db.bulk.delete({ table: public_link, where: cmp(col("template_id"), "=", ref("tpl.id")), as: "link_gone" }),
    s.db.del({ table: envelope, fieldValue: ref("tpl.id") }),
    changed({ entity: "envelope", id: ref("tpl.id"), op: "deleted", actor: inp("actor_id") }),
  ],
  response: obj({ ok: c.bool(true) }),
});

/**
 * What stops a template from having a public link: the first role must be someone who signs, and every other role needs a
 * fixed name and email, since nobody is there to fill them in. Answers a list of plain-language problems.
 */
export const publicProblemsFn = defineFunction({
  name: "template/public_problems",
  description: "Why a template can't have a public link, if it can't.",
  input: { template_id: input.int({ required: true }) },
  stack: [
    s.set_var("problems", c.array([])),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", inp("template_id")), sort: [{ sortBy: "step", dir: "asc" }, { sortBy: "color", dir: "asc" }], as: "pr_roles" }),
    s.db.query({ table: field, where: cmp(col("envelope_id"), "=", inp("template_id")), returnType: "count", as: "pr_fields" }),
    s.conditional({ when: expr(withFilters(ref("pr_roles"), fl.count()), "=", c.int(0)), then: [
      s.update_var("problems", withFilters(ref("problems"), fl.array_push(c.text("Add the role the visitor signs as.")))),
    ], else: [
      s.set_var("pr_first", withFilters(ref("pr_roles"), fl.first())),
      s.conditional({ when: expr(withFilters(ref("pr_first"), fl.get("role")), "!=", c.text("signer")), then: [
        s.update_var("problems", withFilters(ref("problems"), fl.array_push(c.text("The first role must be someone who signs: that's the visitor.")))),
      ] }),
      s.set_var("pr_n", c.int(0)),
      s.foreach({ list: ref("pr_roles"), as: "pr", body: [
        s.update_var("pr_n", withFilters(ref("pr_n"), fl.add(c.int(1)))),
        s.conditional({ when: and(expr(ref("pr_n"), ">", c.int(1)), expr(withFilters(ref("pr.email"), fl.first_notnull(c.text(""))), "=", c.text(""))), then: [
          s.update_var("problems", withFilters(ref("problems"), fl.array_push(withFilters(c.text("Give "), fl.concat(ref("pr.role_name")), fl.concat(c.text(" a name and email: nobody fills it in on a public link.")))))),
        ] }),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("pr_fields"), "=", c.int(0)), then: [
      s.update_var("problems", withFilters(ref("problems"), fl.array_push(c.text("Place at least one field for the visitor.")))),
    ] }),
  ],
  response: ref("problems"),
  responseShape: [] as string[],
});

export const templateFunctions = [instantiateFn, listTemplatesFn, useTemplateFn, saveAsTemplateFn, deleteTemplateFn, publicProblemsFn];
