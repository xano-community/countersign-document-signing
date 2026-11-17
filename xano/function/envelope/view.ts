// What the prepare screen reads: the draft, its people (never their access codes), its fields, and what blocks sending.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { field } from "../../table/envelope/field.js";
import { canRead } from "./access.js";
import { emailStatusFn } from "../email/status.js";
import { loadActor, sendProblems } from "./draft.js";

export const prepareView = defineFunction({
  name: "envelope/prepare_view",
  description: "A draft as the prepare screen shows it.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }) },
  stack: [
    ...loadActor(),
    s.function.run({ fn: canRead, as: "readable", input: { actor_id: inp("actor_id"), envelope_id: inp("envelope_id") } }),
    guard.require(expr(ref("readable"), "=", c.bool(true)), { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "public_id", "title", "status", "sender_id", "visibility", "signing_order", "subject", "message", "expiry_days", "reminder_days", "page_count", "pages", "original_file_id", "is_template", "updated_at"], as: "env" }),
    guard.found("env", { errorType: "notfound", message: "That document doesn't exist, or you can't see it." }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "color", dir: "asc" }],
      output: ["id", "name", "email", "role", "role_name", "step", "color", "identity_check", "user_id", "status", "access_code_hash"], as: "people_raw" }),
    s.set_var("people", c.array([])),
    s.foreach({ list: ref("people_raw"), as: "p", body: [
      s.update_var("people", withFilters(ref("people"), fl.array_push(obj({
        id: ref("p.id"), name: ref("p.name"), email: ref("p.email"), role: ref("p.role"), role_name: ref("p.role_name"), step: ref("p.step"),
        color: ref("p.color"), identity_check: ref("p.identity_check"), user_id: ref("p.user_id"), status: ref("p.status"),
        has_access_code: withFilters(ref("p.access_code_hash"), fl.is_text()),
      })))),
    ] }),
    s.db.query({ table: field, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "id", dir: "asc" }], output: ["id", "recipient_id", "type", "page", "x", "y", "w", "h", "required", "label", "options", "validation"], as: "fields" }),
    s.function.run({ fn: sendProblems, as: "problems", input: { envelope_id: inp("envelope_id") } }),
    s.function.run({ fn: emailStatusFn, as: "mail", input: { test_key: c.text(""), test_from: c.text(""), test_webhook: c.text("") } }),
    s.set_var("editable", c.bool(false)),
    s.conditional({ when: expr(ref("env.status"), "=", c.text("draft")), then: [
      s.conditional({ when: expr(ref("env.sender_id"), "=", inp("actor_id")), then: [s.update_var("editable", c.bool(true))] }),
      s.conditional({ when: rbac.has(ref("actor.role"), "envelope.read_all"), then: [s.update_var("editable", c.bool(true))] }),
    ] }),
  ],
  response: obj({ envelope: ref("env"), recipients: ref("people"), fields: ref("fields"), problems: ref("problems"), email: ref("mail"), editable: ref("editable") }),
});
