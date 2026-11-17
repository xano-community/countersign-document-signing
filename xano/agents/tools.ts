// Countersign's MCP tools, for ChatGPT, Claude and any MCP client a person connects. Each is a thin agent.tool over the same
// function the app's screens call, acting as the person who connected (`conn.user_id`), so the same visibility and permissions
// apply. Sending and cancelling reach other people, so those ask first: the person approves them under Approvals in the app.
import { c, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { agent } from "../agent.js";
import { approvals } from "../approvals.js";
import { SEGMENTS, envelopeDetail, listEnvelopes } from "../function/envelope/list.js";
import { canRead } from "../function/envelope/access.js";
import { remindFn } from "../function/envelope/manage.js";
import { listTemplatesFn } from "../function/templates/templates.js";
import { memberFinal } from "../function/seal/files.js";
import { envelope } from "../table/envelope/envelope.js";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";

const me = () => ref("conn.user_id");
const NOT_FOUND = "That document doesn't exist, or you can't see it.";

export const listEnvelopesTool = agent.tool({
  name: "list_envelopes", title: "List documents", access: "read",
  description: "The connecting person's documents, newest activity first. `segment`: action (waiting on them), waiting (out with others), completed, drafts, ended, or all. `q` searches titles, names and emails.",
  input: { segment: input.enum([...SEGMENTS]), q: input.text() },
  stack: [
    s.function.run({ fn: listEnvelopes, as: "list", input: { actor_id: me(), segment: withFilters(inp("segment"), fl.first_notempty(c.text("all"))), q: inp("q"), page: c.int(1) } }),
    s.array.map({ source: ref("list.items"), as: "out", transform: {
      id: ref("$this.id"), title: ref("$this.title"), status: ref("$this.status"), sender: ref("$this.sender_name"), sent_at: ref("$this.sent_at"),
      completed_at: ref("$this.completed_at"), expires_at: ref("$this.expires_at"), document_id: ref("$this.public_id"),
    } }),
  ],
  response: obj({ documents: ref("out"), people: ref("list.people"), total: ref("list.total") }),
});

export const getEnvelopeTool = agent.tool({
  name: "get_envelope", title: "Read a document", access: "read",
  description: "One document in full: who's on it and where each person has got to, the emails sent, and its audit trail.",
  input: { envelope_id: input.int({ required: true }) },
  stack: [s.function.run({ fn: envelopeDetail, as: "detail", input: { actor_id: me(), envelope_id: inp("envelope_id") } })],
  response: ref("detail"),
});

export const listTemplatesTool = agent.tool({
  name: "list_templates", title: "List templates", access: "read",
  description: "Templates the person can send, with their roles. To send one, fill each role that has no fixed person by its role id.",
  stack: [s.function.run({ fn: listTemplatesFn, as: "list", input: { actor_id: me() } })],
  response: ref("list"),
});

export const sendFromTemplateTool = agent.tool({
  name: "send_from_template", title: "Send a template for signature", access: "write", asksApproval: true,
  description: "Ask to send a template to people: `people` is [{ role_id, name, email }] for each open role. It is NOT sent yet: the person approves it under Approvals in the app. Tell them it's ready to review.",
  input: { template_id: input.int({ required: true }), people: input.json({ required: true }), title: input.text() },
  logDetail: withFilters(c.text("asked to send template "), fl.concat(inp("template_id"))),
  stack: [
    s.db.get({ table: user, fieldValue: me(), output: ["id", "role"], as: "asker" }),
    rbac.allows(ref("asker.role", { safe: true }), "envelope.send", "Your role can't send documents for signature."),
    s.function.run({ fn: canRead, as: "may_read", input: { actor_id: me(), envelope_id: inp("template_id") } }),
    guard.require(expr(ref("may_read"), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
    s.db.get({ table: envelope, fieldValue: inp("template_id"), output: ["id", "title", "is_template"], as: "tpl" }),
    guard.require(expr(ref("tpl.is_template", { safe: true }), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
    s.set_var("to_whom", withFilters(inp("people"), fl.first_notnull(c.array([])), fl.json_encode())),
    approvals.request({
      ...agent.asker, action: "send_from_template",
      title: withFilters(c.text("Send “"), fl.concat(withFilters(inp("title"), fl.first_notempty(ref("tpl.title")))), fl.concat(c.text("”"))),
      preview: ref("to_whom"), link: c.text("/templates"),
      payload: obj({ template_id: inp("template_id"), people: inp("people"), title: withFilters(inp("title"), fl.first_notempty(ref("tpl.title"))), send: c.bool(true), ip: c.text(""), user_agent: c.text("mcp") }),
    }),
  ],
  response: ref("approval"),
});

export const voidEnvelopeTool = agent.tool({
  name: "void_envelope", title: "Cancel a document", access: "write", asksApproval: true,
  description: "Ask to cancel a document that's out for signature, with the reason everyone will see. It is NOT cancelled yet: the person approves it under Approvals.",
  input: { envelope_id: input.int({ required: true }), reason: input.text({ required: true }) },
  logDetail: withFilters(c.text("asked to cancel document "), fl.concat(inp("envelope_id"))),
  stack: [
    s.function.run({ fn: canRead, as: "may_read", input: { actor_id: me(), envelope_id: inp("envelope_id") } }),
    guard.require(expr(ref("may_read"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "title", "status"], as: "env" }),
    guard.require(expr(ref("env.status", { safe: true }), "=", c.text("in_progress")), { errorType: "badrequest", message: "Only a document that's out for signature can be cancelled." }),
    approvals.request({
      ...agent.asker, action: "void_envelope",
      title: withFilters(c.text("Cancel “"), fl.concat(ref("env.title", { safe: true })), fl.concat(c.text("”"))),
      preview: inp("reason"), link: withFilters(c.text("/documents/"), fl.concat(inp("envelope_id"))),
      payload: obj({ envelope_id: inp("envelope_id"), reason: inp("reason"), ip: c.text(""), user_agent: c.text("mcp") }),
    }),
  ],
  response: ref("approval"),
});

export const remindTool = agent.tool({
  name: "remind", title: "Remind a signer", access: "write",
  description: "Send a reminder now to someone whose turn it is on a document (they already have it, so this goes straight out).",
  input: { envelope_id: input.int({ required: true }), recipient_id: input.int({ required: true }) },
  logDetail: withFilters(c.text("reminded someone on document "), fl.concat(inp("envelope_id"))),
  stack: [s.function.run({ fn: remindFn, as: "done", input: { actor_id: me(), envelope_id: inp("envelope_id"), recipient_id: inp("recipient_id"), ip: c.text(""), user_agent: c.text("mcp") } })],
  response: obj({ ok: c.bool(true) }),
});

export const downloadLinkTool = agent.tool({
  name: "download_link", title: "Get a signed PDF", access: "read",
  description: "Where to get a completed document's signed PDF: a short-lived download `url` when files are in cloud storage, and always the document's page in the app.",
  input: { envelope_id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: memberFinal, as: "file", input: { actor_id: me(), envelope_id: inp("envelope_id"), with_bytes: c.bool(false) } }),
    guard.require(expr(ref("file.state"), "!=", c.text("refused")), { errorType: "notfound", message: NOT_FOUND }),
  ],
  response: obj({ state: ref("file.state"), url: ref("file.url"), name: ref("file.name"), page: withFilters(c.text("/documents/"), fl.concat(inp("envelope_id"))) }),
});

/** Seven, beside the base app's three and check_approval: eleven, under the limit of twelve. */
export const countersignTools = [listEnvelopesTool, getEnvelopeTool, listTemplatesTool, sendFromTemplateTool, voidEnvelopeTool, remindTool, downloadLinkTool];
