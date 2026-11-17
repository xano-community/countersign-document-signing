// Documents over HTTP: taking a PDF in as a new draft, and giving a member the original back. Each route is a thin wrapper around its
// function in function/documents/ or function/envelope/, so the same rule holds whoever calls it.
import { apiGroup, auth, c, fl, inp, input, query, ref, respond, s, sys, withFilters } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { documentStorage, originalBytes, originalLink } from "../function/documents/documents.js";
import { createEnvelope, type CreateAnswer } from "../function/envelope/create.js";

export const documentsGroup = apiGroup({
  name: "documents", canonical: "documents", middleware: { pre: [gateActive] },
  description: "Uploading PDFs as new drafts, and downloading an envelope's original.",
});

const id = () => input.int({ required: true });

export const documentStorageRoute = query({
  apiGroup: documentsGroup, auth: user, name: "document-storage", verb: "GET",
  description: "How this deployment keeps documents, and the largest PDF it takes.",
  stack: [...rbac.signedIn(), s.function.run({ fn: documentStorage, as: "storage" })],
  response: ref("storage"), responseShape: {} as { mode: "signed" | "table"; max_upload_bytes: number },
});

/**
 * Upload and create in one multipart call: `file` (the PDF; several files are combined in the browser first), `client_id` (chosen
 * by the browser, so a retry answers the same draft), `title`, `visibility` (`private` or `team`) and `sources` (JSON: what the
 * browser read from each file it combined). Refusals answer 200 with `ok: false`, a `code` and a message to show.
 */
export const createEnvelopeRoute = query({
  apiGroup: documentsGroup, auth: user, name: "envelopes", verb: "POST",
  description: "Upload a PDF and make a draft envelope from it.",
  input: {
    file: input.file(), client_id: input.text({ required: true }), title: input.text({ methods: ["trim"] }), visibility: input.text(), sources: input.json(), as_template: input.bool(),
  },
  stack: [
    ...rbac.require("envelope.send"),
    s.set_var("user_agent", withFilters(sys.httpHeaders(), fl.get("User-Agent", ""))),
    s.function.run({ fn: createEnvelope, as: "answer", input: {
      actor_id: auth("id"), file: inp("file"), client_id: inp("client_id"), title: inp("title"), visibility: inp("visibility"), sources: inp("sources"), as_template: inp("as_template"),
      ip: sys.remoteIp(), user_agent: ref("user_agent"),
    } }),
  ],
  response: ref("answer"), responseShape: {} as CreateAnswer,
});

/** Ask this first: how to get the original right now. A signed link, the bytes route, or a refusal, always at 200. */
export const originalLinkRoute = query({
  apiGroup: documentsGroup, auth: user, name: "envelopes/{id}/original", verb: "GET",
  description: "How to download an envelope's original PDF right now.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: originalLink, as: "link", input: { actor_id: auth("id"), envelope_id: inp("id") } })],
  response: ref("link"), responseShape: {} as { how: "signed" | "table" | "refused" | "unavailable"; url: string | null; name: string | null },
});

/**
 * A table-kept original's exact bytes. Each header is on purpose: the file always downloads, never renders on this origin, and
 * isn't cached.
 */
export const originalRawRoute = query({
  apiGroup: documentsGroup, auth: user, name: "envelopes/{id}/original/raw", verb: "GET",
  description: "An envelope's original PDF, as a download.",
  input: { id: id() },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: originalBytes, as: "stored", input: { actor_id: auth("id"), envelope_id: inp("id") } }),
    s.set_var("plain_name", withFilters(c.text("/[^A-Za-z0-9._ -]+/u"), fl.regex_replace(c.text("_"), ref("stored.name")))),
    s.set_var("encoded_name", withFilters(ref("stored.name"), fl.url_encode_rfc3986())),
    s.util.set_header({ value: c.text("Content-Type: application/pdf"), duplicates: "replace" }),
    s.util.set_header({ value: withFilters(c.text('Content-Disposition: attachment; filename="'), fl.concat(ref("plain_name")), fl.concat(c.text(`"; filename*=UTF-8''`)), fl.concat(ref("encoded_name"))), duplicates: "replace" }),
    respond.header("X-Content-Type-Options", "nosniff"),
    respond.header("Content-Security-Policy", "sandbox; default-src 'none'"),
    respond.header("Cache-Control", "private, no-store"),
    s.set_var("bytes", withFilters(ref("stored.b64"), fl.base64_decode())),
  ],
  response: ref("bytes"),
  history: false,
});

export const documentQueries = [documentStorageRoute, createEnvelopeRoute, originalLinkRoute, originalRawRoute];
