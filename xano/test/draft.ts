// Preparing a draft: replacing recipients and fields, and what blocks sending.
import { c, cmp, col, fl, obj, ref, s, withFilters } from "@xano/sdk";
import { saveFields, saveRecipients, sendProblems } from "../function/envelope/draft.js";
import { envelope } from "../table/envelope/envelope.js";
import { recipient } from "../table/envelope/recipient.js";
import { field } from "../table/envelope/field.js";
import { user } from "../table/user.js";
import { draft, person, workflowTest } from "./fixtures.js";

const ready = { original_file_id: c.int(1), page_count: c.int(2) };
const people = (...ps: { name: string; email: string; role?: string; id?: string }[]) => c.array(ps.map((p) => ({ name: p.name, email: p.email, role: p.role ?? "signer", identity_check: "none" })));

export const draftTests = [
  workflowTest({
    name: "draft: saving recipients replaces the list and drops the removed person's fields",
    description: "Two people saved, one field each, then a save with only the first: the second and their field are gone.",
    stack: [
      person("sender"),
      draft("env", "sender", "Lease", ready),
      s.function.call({ fn: saveRecipients, as: "first", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id"), recipients: people({ name: "Ana", email: "ana@x.example" }, { name: "Ben", email: "ben@x.example" }) } }),
      s.db.query({ table: recipient, where: cmp(col("email"), "=", c.text("ana@x.example")), returnType: "single", as: "ana" }),
      s.db.query({ table: recipient, where: cmp(col("email"), "=", c.text("ben@x.example")), returnType: "single", as: "ben" }),
      s.function.call({ fn: saveFields, as: "f", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id"), fields: c.array([]) } }),
      s.db.add({ table: field, as: "benfield", row: { envelope_id: ref("env.id"), recipient_id: ref("ben.id"), type: c.text("signature"), page: c.int(1), x: c.decimal(0.1), y: c.decimal(0.1), w: c.decimal(0.2), h: c.decimal(0.05) } }),
      s.function.call({ fn: saveRecipients, as: "second", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id"), recipients: c.array([]) } }),
      s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("env.id")), returnType: "count", as: "left" }),
      s.expect.to_equal({ expr: ref("left"), value: c.int(0) }),
      s.db.query({ table: field, where: cmp(col("envelope_id"), "=", ref("env.id")), returnType: "count", as: "fields_left" }),
      s.expect.to_equal({ expr: ref("fields_left"), value: c.int(0) }),
    ],
  }),
  workflowTest({
    name: "draft: a field that runs off its page is refused",
    description: "x + w past the page edge is refused with a plain message.",
    stack: [
      person("sender"),
      draft("env", "sender", "Edge", ready),
      s.function.call({ fn: saveRecipients, as: "saved", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id"), recipients: people({ name: "Ana", email: "ana@x.example" }) } }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: envelope, where: cmp(col("title"), "=", c.text("Edge")), returnType: "single", as: "e" }),
          s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("e.id")), returnType: "single", as: "r" }),
          s.set_var("one", withFilters(c.array([]), fl.array_push(obj({ recipient_id: ref("r.id"), type: c.text("signature"), page: c.int(1), x: c.decimal(0.9), y: c.decimal(0.1), w: c.decimal(0.3), h: c.decimal(0.05) })))),
          s.function.call({ fn: saveFields, as: "f", input: { actor_id: ref("e.sender_id"), envelope_id: ref("e.id"), fields: ref("one") } }),
        ],
        exception: c.text("runs off the edge"),
      }),
    ],
  }),
  workflowTest({
    name: "draft: a signer without a signature field blocks sending, by name",
    description: "send_problems names the signer, and a CC with a field is flagged too.",
    stack: [
      person("sender"),
      draft("env", "sender", "Blocked", ready),
      s.function.call({ fn: saveRecipients, as: "saved", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id"), recipients: people({ name: "Ana", email: "ana@x.example" }, { name: "Accounts", email: "acc@x.example", role: "cc" }) } }),
      s.db.query({ table: recipient, where: cmp(col("email"), "=", c.text("acc@x.example")), returnType: "single", as: "cc" }),
      s.db.add({ table: field, as: "ccfield", row: { envelope_id: ref("env.id"), recipient_id: ref("cc.id"), type: c.text("text"), page: c.int(1), x: c.decimal(0.1), y: c.decimal(0.1), w: c.decimal(0.2), h: c.decimal(0.05) } }),
      s.function.call({ fn: sendProblems, as: "problems", input: { envelope_id: ref("env.id") } }),
      s.expect.to_equal({ expr: ref("problems.0.message"), value: c.text("Ana has no signature field.") }),
      s.expect.to_equal({ expr: ref("problems.1.code"), value: c.text("cc_fields") }),
    ],
  }),
  workflowTest({
    name: "draft: a viewer member can't prepare a document",
    description: "Saving recipients as a viewer is refused.",
    stack: [
      person("sender"),
      person("viewer", "viewer"),
      draft("env", "sender", "Viewer try", ready),
      s.expect.to_throw({
        body: [
          s.db.query({ table: envelope, where: cmp(col("title"), "=", c.text("Viewer try")), returnType: "single", as: "e" }),
          s.db.query({ table: user, where: cmp(col("role"), "=", c.text("viewer")), returnType: "single", as: "v" }),
          s.function.call({ fn: saveRecipients, as: "x", input: { actor_id: ref("v.id"), envelope_id: ref("e.id"), recipients: c.array([]) } }),
        ],
        exception: c.text("not prepare or send"),
      }),
    ],
  }),
];
