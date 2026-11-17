// Stored PDFs. A deployment that can sign private links keeps the bytes in private storage and reads them through a short link. One
// that can't (the local Engine) keeps them as base64 in document_blob. Which one is decided by signing a real file, because a
// made-up path fails even where signing works. Every row stays on the path it was written with.
//
// A refusal someone can run into (not a PDF, too big, password-protected, damaged) is an answer, not an HTTP error:
// `{ ok: false, code, message }`, so a screen says so in its own words.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { lam } from "@xano/sdk/node";
import { document_blob, document_file } from "../../table/files/document_file.js";
import { vendor } from "../../table/files/vendor.js";
import { envelope } from "../../table/envelope/envelope.js";
import { canRead } from "../envelope/access.js";

const MB = 1024 * 1024;
/** The largest document in private storage: the most the seal can stamp on cloud. */
export const SIGNED_LIMIT = 15 * MB;
/** The largest document a table holds. */
export const TABLE_LIMIT = 5 * MB;
/** How long the link the PDF check reads a stored file through lives. */
const CHECK_LINK_SECONDS = 120;
/** How long a download link lives. */
const DOWNLOAD_LINK_SECONDS = 60;
const PROBE_SECONDS = 5;
const LONGEST_NAME = 200;
const NOT_FOUND = "That document doesn't exist.";

/** What a person reads when the check refuses a file. */
const CHECK_MESSAGES: Record<string, string> = {
  encrypted: "This PDF is password-protected. Remove the password and upload it again.",
  damaged: "This PDF is damaged and can't be read. Save or export it again, then upload the new copy.",
  unavailable: "This PDF couldn't be checked just now. Try again in a minute.",
};

export type PageInfo = { w: number; h: number; rotation: number; crop: { x: number; y: number; w: number; h: number } };
export type StoredFile = { id: number; name: string; size: number; sha256: string; mode: "signed" | "table" };
export type StoreAnswer = {
  ok: boolean; code: "" | "empty" | "not_pdf" | "too_big" | "encrypted" | "damaged" | "unavailable" | "failed"; message: string;
  file: StoredFile | null; page_count: number; pages: PageInfo[]; repeat: boolean;
};

/** A name as this app keeps it: no path, no control characters, a sane length. */
export const cleanName = defineFunction({
  name: "documents/clean_name",
  description: "A file's name with any path and control characters taken out.",
  input: { name: input.text() },
  stack: [
    s.set_var("flat", withFilters(c.text("/\\\\/u"), fl.regex_replace(c.text("/"), inp("name")))),
    s.set_var("last", withFilters(ref("flat"), fl.split("/"), fl.last())),
    s.set_var("plain", withFilters(c.text("/[\\x00-\\x1f\\x7f]+/u"), fl.regex_replace(c.text(""), ref("last")))),
    s.set_var("clean", withFilters(ref("plain"), fl.trim(), fl.substr(c.int(0), c.int(LONGEST_NAME)))),
    s.conditional({ when: expr(withFilters(c.array(["", ".", ".."]), fl.in(ref("clean"))), "=", c.bool(true)), then: [s.update_var("clean", c.text("Document.pdf"))] }),
  ],
  response: ref("clean"),
});

/** How this deployment keeps documents, and the largest it takes, so the upload screen can name the limit first. */
export const documentStorage = defineFunction({
  name: "documents/storage",
  description: "How this deployment keeps documents, and the largest it takes.",
  stack: [
    s.set_var("mode", c.text("signed")),
    s.storage.create_file_resource({ as: "tiny", filename: c.text("storage-check.txt"), filedata: c.text("x") }),
    s.storage.create_attachment({ as: "check", value: ref("tiny"), access: "private" }),
    s.try_catch({
      try: [s.storage.sign_private_url({ pathname: ref("check.path"), ttl: c.int(PROBE_SECONDS), as: "probed" })],
      catch: [s.update_var("mode", c.text("table"))],
    }),
    s.storage.delete_file({ pathname: ref("check.path") }),
    s.set_var("most", c.int(SIGNED_LIMIT)),
    s.conditional({ when: expr(ref("mode"), "=", c.text("table")), then: [s.update_var("most", c.int(TABLE_LIMIT))] }),
  ],
  response: { mode: ref("mode"), max_upload_bytes: ref("most") },
  responseShape: {} as { mode: "signed" | "table"; max_upload_bytes: number },
});

/**
 * Opens a stored document with the seal's own pdf-lib and reads its pages. `code` says why not: `encrypted`, `damaged`, or
 * `unavailable` when the check itself couldn't run. Only the library, the base64 (table mode) or a link (signed mode) reach the
 * lambda, so this function binds nothing else big.
 */
export const checkDocument = defineFunction({
  name: "documents/check",
  description: "Open a stored PDF the way the seal will, and read each page's size, rotation and crop box.",
  input: { file_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: document_file, fieldValue: inp("file_id"), output: ["id", "mode", "attachment"], as: "doc" }),
    guard.found("doc", { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: vendor, fieldName: "name", fieldValue: c.text("pdf-lib"), output: ["src"], as: "lib_row" }),
    s.set_var("url", c.text("")),
    s.set_var("blob", c.null()),
    s.conditional({
      when: expr(ref("doc.mode"), "=", c.text("signed")),
      then: [s.try_catch({
        try: [s.storage.sign_private_url({ pathname: ref("doc.attachment.path", { safe: true }), ttl: c.int(CHECK_LINK_SECONDS), as: "link" }), s.update_var("url", ref("link"))],
        catch: [s.return(obj({ ok: c.bool(false), code: c.text("unavailable"), page_count: c.int(0), pages: c.array([]), error: c.text("The stored file couldn't be reached.") }))],
      })],
      else: [s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: inp("file_id"), output: ["b64"], as: "blob" })],
    }),
    s.lambda({ as: "seen", timeout: c.int(120), code: lam.file("../../lambdas/pdf-check.ts") }),
    // A lambda that throws answers its error text, not an object, so anything without `ok: true` is a failed check.
    s.set_var("answer", obj({ ok: c.bool(true), code: c.text(""), page_count: ref("seen.page_count", { safe: true }), pages: ref("seen.pages", { safe: true }), error: c.text("") })),
    s.conditional({ when: expr(ref("seen.ok", { safe: true }), "!=", c.bool(true)), then: [
      s.set_var("said", withFilters(ref("seen"), fl.json_encode())),
      s.update_var("answer", obj({
        ok: c.bool(false),
        code: withFilters(ref("seen.code", { safe: true }), fl.first_notempty(c.text("unavailable"))),
        page_count: c.int(0), pages: c.array([]),
        error: withFilters(ref("seen.error", { safe: true }), fl.first_notempty(ref("said"))),
      })),
    ] }),
  ],
  response: ref("answer"),
  responseShape: {} as { ok: boolean; code: "" | "encrypted" | "damaged" | "unavailable"; page_count: number; pages: PageInfo[]; error: string },
});

/** Removes a stored document entirely: its private file, its table bytes and its row. */
export const discardDocument = defineFunction({
  name: "documents/discard",
  description: "Delete a stored document's bytes, wherever they are, and its row.",
  input: { file_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: document_file, fieldValue: inp("file_id"), output: ["id", "mode", "attachment"], as: "doc" }),
    s.conditional({ when: expr(ref("doc"), "!=", c.null()), then: [
      s.set_var("path", withFilters(ref("doc.attachment.path", { safe: true }), fl.first_notnull(c.text("")))),
      s.conditional({ when: expr(ref("path"), "!=", c.text("")), then: [s.try_catch({ try: [s.storage.delete_file({ pathname: ref("path") })], catch: [] })] }),
      s.db.bulk.delete({ table: document_blob, where: cmp(col("file_id"), "=", inp("file_id")), as: "bytes_gone" }),
      s.db.del({ table: document_file, fieldValue: inp("file_id") }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

const fileView = (id: Value, as: string) =>
  s.db.query({ table: document_file, where: cmp(col("id"), "=", id), returnType: "single", output: ["id", "name", "size", "sha256", "mode"], as });

const refuse = (code: string, message: Value) =>
  s.return(obj({ ok: c.bool(false), code: c.text(code), message, file: c.null(), page_count: c.int(0), pages: c.array([]), repeat: c.bool(false) }));

/** The answer for a failed check, in a person's words. */
const refuseChecked = (checked: string) => [
  s.set_var("why", c.text(CHECK_MESSAGES.unavailable)),
  ...Object.entries(CHECK_MESSAGES).map(([code, text]) =>
    s.conditional({ when: expr(ref(`${checked}.code`), "=", c.text(code)), then: [s.update_var("why", c.text(text))] })),
  s.return(obj({ ok: c.bool(false), code: ref(`${checked}.code`), message: ref("why"), file: c.null(), page_count: c.int(0), pages: c.array([]), repeat: c.bool(false) })),
];

/**
 * Takes an uploaded PDF in. A retry under the same client id answers the row it made. The file must start like a PDF, be under the
 * limit for where it will live, and open in the seal's pdf-lib; one that doesn't is removed again. The fingerprint is the SHA-256 of
 * the stored bytes.
 */
export const storeDocument = defineFunction({
  name: "documents/store",
  description: "Keep an uploaded PDF in private storage or a table, fingerprint it and check it opens.",
  input: { actor_id: input.int({ required: true }), file: input.file(), client_id: input.text() },
  stack: [
    guard.require(expr(withFilters(inp("client_id"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "This upload has no id." }),
    guard.require(expr(withFilters(inp("client_id"), fl.strlen()), "<=", c.int(64)), { errorType: "badrequest", message: "This upload's id is too long." }),
    s.set_var("key", withFilters(inp("actor_id"), fl.to_text(), fl.concat(c.text(":")), fl.concat(inp("client_id")))),
    s.db.query({ table: document_file, where: cmp(col("client_id"), "=", ref("key")), output: ["id"], returnType: "single", as: "before" }),
    s.conditional({ when: expr(ref("before"), "!=", c.null()), then: [
      s.set_var("before_id", ref("before.id", { safe: true })),
      s.function.run({ fn: checkDocument, as: "rechecked", input: { file_id: ref("before_id") } }),
      fileView(ref("before_id"), "view"),
      s.return(obj({ ok: c.bool(true), code: c.text(""), message: c.text(""), file: ref("view"), page_count: ref("rechecked.page_count"), pages: ref("rechecked.pages"), repeat: c.bool(true) })),
    ] }),

    s.storage.read_file_resource({ as: "res", value: inp("file") }),
    s.conditional({ when: expr(withFilters(ref("res.size"), fl.first_notnull(c.int(0))), "=", c.int(0)), then: [refuse("empty", c.text("This file is empty."))] }),
    // The bytes decide, not the name or the stated type: a PDF starts with "%PDF-".
    s.set_var("head", withFilters(ref("res.data"), fl.substr(c.int(0), c.int(5)))),
    s.conditional({ when: expr(ref("head"), "!=", c.text("%PDF-")), then: [refuse("not_pdf", c.text("This file isn't a PDF. Only PDF files can be sent for signature."))] }),
    s.conditional({ when: expr(ref("res.size"), ">", c.int(SIGNED_LIMIT)), then: [refuse("too_big", c.text(`This file is over the ${SIGNED_LIMIT / MB} MB limit.`))] }),
    s.function.run({ fn: cleanName, as: "name", input: { name: ref("res.name") } }),
    s.set_var("sha", withFilters(ref("res.data"), fl.sha256())),

    // Private storage if this deployment can sign a link to the very file just stored; otherwise a table.
    s.set_var("mode", c.text("signed")),
    s.set_var("attachment", c.null()),
    s.try_catch({
      try: [
        s.storage.create_attachment({ as: "stored", value: inp("file"), access: "private", filename: ref("name") }),
        s.update_var("attachment", ref("stored")),
        s.storage.sign_private_url({ pathname: ref("stored.path"), ttl: c.int(PROBE_SECONDS), as: "probed" }),
      ],
      catch: [
        s.conditional({ when: expr(ref("attachment"), "!=", c.null()), then: [s.storage.delete_file({ pathname: ref("attachment.path", { safe: true }) })] }),
        s.update_var("mode", c.text("table")),
        s.update_var("attachment", c.null()),
      ],
    }),
    s.conditional({ when: expr(ref("mode"), "=", c.text("table")), then: [
      s.conditional({ when: expr(ref("res.size"), ">", c.int(TABLE_LIMIT)), then: [refuse("too_big", c.text(`This file is over the ${TABLE_LIMIT / MB} MB limit for this deployment.`))] }),
    ] }),

    // The row and its table bytes together, or neither. A failure leaves nothing behind, in storage either.
    s.set_var("kept", c.int(0)),
    s.try_catch({
      try: [s.db.transaction({ body: [
        s.db.add({ table: document_file, as: "made", row: {
          name: ref("name"), size: ref("res.size"), sha256: ref("sha"), mode: ref("mode"), attachment: ref("attachment"),
          uploaded_by: inp("actor_id"), client_id: ref("key"), is_demo: c.bool(false),
        } }),
        s.conditional({ when: expr(ref("mode"), "=", c.text("table")), then: [
          s.db.add({ table: document_blob, as: "bytes", row: { file_id: ref("made.id"), b64: withFilters(ref("res.data"), fl.base64_encode()) } }),
        ] }),
        s.update_var("kept", ref("made.id")),
      ] })],
      catch: [
        s.update_var("kept", c.int(0)),
        s.conditional({ when: expr(ref("attachment"), "!=", c.null()), then: [s.storage.delete_file({ pathname: ref("attachment.path", { safe: true }) })] }),
      ],
    }),
    // Losing a race to the same retry isn't a failure: the other copy is the file.
    s.conditional({ when: expr(ref("kept"), "=", c.int(0)), then: [
      s.db.query({ table: document_file, where: cmp(col("client_id"), "=", ref("key")), output: ["id"], returnType: "single", as: "winner" }),
      s.conditional({ when: expr(ref("winner"), "=", c.null()), then: [refuse("failed", c.text("This file couldn't be saved. Try again."))] }),
      s.update_var("kept", ref("winner.id", { safe: true })),
    ] }),

    s.function.run({ fn: checkDocument, as: "checked", input: { file_id: ref("kept") } }),
    s.conditional({ when: expr(ref("checked.ok"), "!=", c.bool(true)), then: [
      s.function.run({ fn: discardDocument, as: "discarded", input: { file_id: ref("kept") } }),
      ...refuseChecked("checked"),
    ] }),
    fileView(ref("kept"), "view"),
  ],
  response: { ok: c.bool(true), code: c.text(""), message: c.text(""), file: ref("view"), page_count: ref("checked.page_count"), pages: ref("checked.pages"), repeat: c.bool(false) },
  responseShape: {} as StoreAnswer,
});

/** Binds `env_file`: the stored original of an envelope this actor may read, or null. */
const readableOriginal = [
  s.function.run({ fn: canRead, as: "readable", input: { actor_id: inp("actor_id"), envelope_id: inp("envelope_id") } }),
  s.set_var("env_file", c.null()),
  s.conditional({ when: expr(ref("readable"), "=", c.bool(true)), then: [
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "original_file_id"], as: "env" }),
    s.set_var("original_id", withFilters(ref("env.original_file_id", { safe: true }), fl.first_notnull(c.int(0)))),
    s.conditional({ when: expr(ref("original_id"), ">", c.int(0)), then: [
      s.db.get({ table: document_file, fieldValue: ref("original_id"), output: ["id", "name", "mode", "attachment"], as: "found_file" }),
      s.update_var("env_file", ref("found_file")),
    ] }),
  ] }),
];

/**
 * How this reader gets an envelope's original right now. `signed` with a 60-second link, `table` for the bytes route, `refused`
 * (no such envelope, no original yet, or not theirs to read: the same answer), or `unavailable` when storage won't sign right now.
 */
export const originalLink = defineFunction({
  name: "documents/original_link",
  description: "How a member gets an envelope's original PDF right now.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }) },
  stack: [
    ...readableOriginal,
    s.conditional({ when: expr(ref("env_file"), "=", c.null()), then: [s.return(obj({ how: c.text("refused"), url: c.null(), name: c.null() }))] }),
    s.set_var("how", c.text("table")),
    s.set_var("url", c.null()),
    s.conditional({ when: expr(ref("env_file.mode"), "=", c.text("signed")), then: [
      s.try_catch({
        try: [
          s.storage.sign_private_url({ pathname: ref("env_file.attachment.path", { safe: true }), ttl: c.int(DOWNLOAD_LINK_SECONDS), as: "signed" }),
          s.update_var("url", ref("signed")),
          s.update_var("how", c.text("signed")),
        ],
        catch: [s.update_var("how", c.text("unavailable"))],
      }),
    ] }),
  ],
  response: { how: ref("how"), url: ref("url"), name: ref("env_file.name") },
  responseShape: {} as { how: "signed" | "table" | "refused" | "unavailable"; url: string | null; name: string | null },
});

/** A table-kept original's name and bytes, for a member who may read the envelope. Anything else is not found. */
export const originalBytes = defineFunction({
  name: "documents/original_bytes",
  description: "The name and base64 bytes of an envelope's table-kept original.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }) },
  stack: [
    ...readableOriginal,
    guard.found("env_file", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("env_file.mode"), "=", c.text("table")), { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref("env_file.id"), output: ["b64"], as: "blob" }),
    guard.found("blob", { errorType: "notfound", message: NOT_FOUND }),
  ],
  response: { name: ref("env_file.name"), b64: ref("blob.b64") },
  responseShape: {} as { name: string; b64: string },
});

export const documentFunctions = [cleanName, documentStorage, checkDocument, discardDocument, storeDocument, originalLink, originalBytes];
