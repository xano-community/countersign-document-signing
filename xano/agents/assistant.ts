// The in-app assistant's tools: it reads documents and templates as the person chatting (the chatbot passes the user table, so
// auth("id") is them) through the same functions the screens use, and can send a reminder. Sending and cancelling stay in the app,
// where the person sees exactly what goes out. Names differ from the MCP tools' (a tool's name is its identity in the workspace).
import { auth, c, fl, inp, input, obj, ref, s, tool, withFilters } from "@xano/sdk";
import { SEGMENTS, envelopeDetail, listEnvelopes } from "../function/envelope/list.js";
import { remindFn } from "../function/envelope/manage.js";
import { listTemplatesFn } from "../function/templates/templates.js";

export const findDocumentsTool = tool({
  name: "find_documents", title: "Find documents", annotations: { readOnlyHint: true },
  description: "The person's documents, newest activity first. segment: action (waiting on them: to sign, or drafts to finish), waiting (out with others), completed, drafts, ended (declined, cancelled or expired), or all. q searches titles, names and emails.",
  input: { segment: input.enum([...SEGMENTS]), q: input.text() },
  stack: [
    s.function.run({ fn: listEnvelopes, as: "list", input: { actor_id: auth("id"), segment: withFilters(inp("segment"), fl.first_notempty(c.text("all"))), q: inp("q"), page: c.int(1) } }),
    s.array.map({ source: ref("list.items"), as: "docs", transform: {
      id: ref("$this.id"), title: ref("$this.title"), status: ref("$this.status"), sender: ref("$this.sender_name"), sent_at: ref("$this.sent_at"),
      completed_at: ref("$this.completed_at"), deadline: ref("$this.expires_at"), link: withFilters(c.text("/documents/"), fl.concat(ref("$this.id"))),
    } }),
  ],
  response: obj({ documents: ref("docs"), people: ref("list.people"), waiting_on_them: ref("list.my_turn"), total: ref("list.total") }),
});

export const readDocumentTool = tool({
  name: "read_document", title: "Read a document", annotations: { readOnlyHint: true },
  description: "One document in full: each person and where they've got to, the emails sent, and the audit trail, newest first.",
  input: { document_id: input.int({ required: true }) },
  stack: [s.function.run({ fn: envelopeDetail, as: "detail", input: { actor_id: auth("id"), envelope_id: inp("document_id") } })],
  response: ref("detail"),
});

export const browseTemplatesTool = tool({
  name: "browse_templates", title: "Browse templates", annotations: { readOnlyHint: true },
  description: "The templates the person can send, with their roles and how often each has been used.",
  stack: [s.function.run({ fn: listTemplatesFn, as: "list", input: { actor_id: auth("id") } })],
  response: ref("list"),
});

export const remindSignerTool = tool({
  name: "remind_signer", title: "Send a reminder", annotations: { readOnlyHint: false },
  description: "Send a reminder now to someone whose turn it is on one of the person's documents. Only when they ask for it.",
  input: { document_id: input.int({ required: true }), recipient_id: input.int({ required: true }) },
  stack: [s.function.run({ fn: remindFn, as: "done", input: { actor_id: auth("id"), envelope_id: inp("document_id"), recipient_id: inp("recipient_id"), ip: c.text(""), user_agent: c.text("assistant") } })],
  response: obj({ ok: c.bool(true) }),
});

export const countersignAssistantTools = [findDocumentsTool, readDocumentTool, browseTemplatesTool, remindSignerTool];

export const COUNTERSIGN_PROMPT = [
  "You are the assistant inside Countersign, where a team sends documents for electronic signature and keeps the signed copies.",
  "The records: documents (a PDF with the people who sign, approve, view or get a copy, in order or all at once; a document is a draft, out for signature, finishing, completed, declined, cancelled or expired), templates (a document prepared once with roles, used again and again, to one person or a spreadsheet of people), and each document's audit trail and signed copy with its certificate.",
  "Which tool when: find_documents for what's waiting, what's out, or a document by name or person (segment action is what waits on the person); read_document for where one document stands and who has or hasn't signed; browse_templates for what can be sent; remind_signer only when the person asks you to remind someone.",
  "You can't send, cancel or sign anything: say where in the app to do it (New document, a template's Use button, or the document's page). Link to a document as /documents/<id>.",
  "Times are milliseconds since 1970: say them as dates. A tool's refusal is the answer: say plainly why. Never make up a document, person or status.",
].join(" ");
