// The signed copy's bytes: the seal lambda's two internal routes (read the original, store the result), each party's personal
// download, members' downloads (the signed PDF, the audit trail as a PDF, and a ZIP of all three), and the public verify check.
//
// Refusals people can meet are states, never HTTP errors. The two internal routes are the exception: they only ever answer the
// lambda, and anything but the envelope's current seal key gets a plain 404, the same as a route that isn't there.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { purged_envelope } from "../../table/envelope/purged_envelope.js";
import { document_blob, document_file } from "../../table/files/document_file.js";
import { canRead } from "../envelope/access.js";
import { cleanName, discardDocument, SIGNED_LIMIT } from "../documents/documents.js";
import { hit } from "../rate/limit.js";
import { auditPdf, bindSealClientId } from "./build.js";

const MB = 1024 * 1024;
/** The most a signed copy may be: the original's limit, plus room for the stamps and certificate. */
const FINAL_LIMIT = SIGNED_LIMIT + 10 * MB;
const DOWNLOAD_LINK_SECONDS = 60;
const NOT_FOUND = "Not found.";
/** Verify checks per IP a minute, and personal downloads per IP a minute. */
const VERIFY_PER_MINUTE = 30;
const DOWNLOAD_PER_MINUTE = 30;

/** Refuses (404) unless `key` is the envelope's current seal key and it's in `sealing`. Binds `sealing_env`. */
const requireSealKey = statements(
  s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "status", "title", "sender_id", "seal_key_hash", "original_file_id"], as: "sealing_env" }),
  guard.found("sealing_env", { errorType: "notfound", message: NOT_FOUND }),
  s.set_var("held_hash", withFilters(ref("sealing_env.seal_key_hash"), fl.first_notnull(c.text("")))),
  guard.require(expr(ref("held_hash"), "!=", c.text("")), { errorType: "notfound", message: NOT_FOUND }),
  guard.require(expr(withFilters(inp("key"), fl.first_notnull(c.text("")), fl.sha256()), "=", ref("held_hash")), { errorType: "notfound", message: NOT_FOUND }),
  guard.require(expr(ref("sealing_env.status"), "=", c.text("sealing")), { errorType: "notfound", message: NOT_FOUND }),
);

/** The original's bytes, for the seal lambda in table mode. */
export const sealOriginal = defineFunction({
  name: "seal/original",
  description: "The table-kept original's bytes, for the seal lambda holding the envelope's seal key.",
  input: { envelope_id: input.int({ required: true }), key: input.text() },
  stack: [
    ...requireSealKey,
    s.db.get({ table: document_file, fieldValue: ref("sealing_env.original_file_id"), output: ["id", "mode"], as: "orig" }),
    guard.found("orig", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("orig.mode"), "=", c.text("table")), { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref("orig.id"), output: ["b64"], as: "blob" }),
    guard.found("blob", { errorType: "notfound", message: NOT_FOUND }),
  ],
  response: { b64: ref("blob.b64") },
  responseShape: {} as { b64: string },
});

/**
 * Keeps the seal lambda's result as the envelope's signed copy, in the same kind of storage as its original, and fingerprints the
 * bytes it received. An earlier attempt's copy is replaced. seal/build then checks this against what the lambda made.
 */
export const sealStoreFinal = defineFunction({
  name: "seal/store_final",
  description: "Store the seal lambda's signed PDF for the envelope holding this seal key.",
  input: { envelope_id: input.int({ required: true }), key: input.text(), file: input.file() },
  stack: [
    ...requireSealKey,
    s.storage.read_file_resource({ as: "res", value: inp("file") }),
    guard.require(expr(withFilters(ref("res.data"), fl.substr(c.int(0), c.int(5))), "=", c.text("%PDF-")), { errorType: "badrequest", message: "That isn't a PDF." }),
    guard.require(expr(ref("res.size"), "<=", c.int(FINAL_LIMIT)), { errorType: "badrequest", message: "The signed copy is too large." }),
    s.db.get({ table: document_file, fieldValue: ref("sealing_env.original_file_id"), output: ["id", "mode", "name"], as: "orig" }),
    guard.found("orig", { errorType: "notfound", message: NOT_FOUND }),
    ...bindSealClientId(inp("envelope_id")),
    s.db.query({ table: document_file, where: cmp(col("client_id"), "=", ref("seal_cid")), output: ["id"], returnType: "single", as: "earlier" }),
    s.conditional({ when: expr(ref("earlier"), "!=", c.null()), then: [s.function.run({ fn: discardDocument, as: "replaced", input: { file_id: ref("earlier.id", { safe: true }) } })] }),
    s.function.run({ fn: cleanName, as: "name", input: { name: withFilters(c.text("/\\.pdf$/i"), fl.regex_replace(c.text(""), ref("orig.name")), fl.concat(c.text(" (signed).pdf"))) } }),
    s.set_var("sha", withFilters(ref("res.data"), fl.sha256())),
    s.set_var("attachment", c.null()),
    s.set_var("made_id", c.int(0)),
    s.conditional({ when: expr(ref("orig.mode"), "=", c.text("signed")), then: [
      s.storage.create_attachment({ as: "stored", value: inp("file"), access: "private", filename: ref("name") }),
      s.update_var("attachment", ref("stored")),
    ] }),
    s.try_catch({
      try: [s.db.transaction({ body: [
        s.db.add({ table: document_file, as: "made", row: {
          name: ref("name"), size: ref("res.size"), sha256: ref("sha"), mode: ref("orig.mode"), attachment: ref("attachment"),
          uploaded_by: ref("sealing_env.sender_id"), client_id: ref("seal_cid"), is_demo: c.bool(false),
        } }),
        s.conditional({ when: expr(ref("orig.mode"), "=", c.text("table")), then: [
          s.db.add({ table: document_blob, as: "bytes", row: { file_id: ref("made.id"), b64: withFilters(ref("res.data"), fl.base64_encode()) } }),
        ] }),
        s.update_var("made_id", ref("made.id")),
      ] })],
      catch: [
        s.conditional({ when: expr(ref("attachment"), "!=", c.null()), then: [s.storage.delete_file({ pathname: ref("attachment.path", { safe: true }) })] }),
        guard.require(expr(c.bool(false), "=", c.bool(true)), { errorType: "badrequest", message: "The signed copy couldn't be saved." }),
      ],
    }),
  ],
  response: { file_id: ref("made_id"), sha256: ref("sha"), size: ref("res.size") },
  responseShape: {} as { file_id: number; sha256: string; size: number },
});

export type VerifyAnswer = {
  state: "match" | "no_match" | "purged" | "invalid" | "rate_limited";
  completed_at: number | null; signer_count: number; retry_after: number;
  /** Only when the public id given belongs to the same envelope as the fingerprint. */
  signers: { name: string; role: string; role_name: string }[] | null;
};

/**
 * Does this fingerprint belong to a completed envelope's signed copy? The browser hashes the file and sends only the hash. A match
 * says when it completed and how many signed; who signed only when the visitor also has the envelope's public id, which is printed
 * on the PDF, and it's the same envelope. An envelope deleted under retention answers `purged`.
 */
export const verifyFinal = defineFunction({
  name: "seal/verify",
  description: "Check a SHA-256 fingerprint against completed envelopes' signed copies.",
  input: { sha256: input.text(), public_id: input.text(), ip: input.text() },
  stack: [
    s.set_var("caller_ip", withFilters(inp("ip"), fl.first_notnull(c.text("")))),
    hit(withFilters(c.text("verify:ip:"), fl.concat(ref("caller_ip"))), VERIFY_PER_MINUTE, 60),
    s.conditional({ when: expr(ref("rate.allowed"), "!=", c.bool(true)), then: [
      s.return(obj({ state: c.text("rate_limited"), completed_at: c.null(), signer_count: c.int(0), signers: c.null(), retry_after: ref("rate.retry_after") })),
    ] }),
    s.set_var("sha", withFilters(inp("sha256"), fl.first_notnull(c.text("")), fl.trim(), fl.lower())),
    s.conditional({ when: expr(withFilters(c.regex(/^[0-9a-f]{64}$/), fl.regex_test(ref("sha"))), "!=", c.bool(true)), then: [
      s.return(obj({ state: c.text("invalid"), completed_at: c.null(), signer_count: c.int(0), signers: c.null(), retry_after: c.int(0) })),
    ] }),
    s.db.query({ table: envelope, where: [cmp(col("final_sha256"), "=", ref("sha")), cmp(col("status"), "=", c.text("completed"))], output: ["id", "public_id", "completed_at"], returnType: "single", as: "found" }),
    s.conditional({ when: expr(ref("found"), "=", c.null()), then: [
      s.db.query({ table: purged_envelope, where: cmp(col("final_sha256"), "=", ref("sha")), output: ["completed_at"], returnType: "single", as: "gone" }),
      s.conditional({ when: expr(ref("gone"), "!=", c.null()), then: [
        s.return(obj({ state: c.text("purged"), completed_at: ref("gone.completed_at", { safe: true }), signer_count: c.int(0), signers: c.null(), retry_after: c.int(0) })),
      ] }),
      s.return(obj({ state: c.text("no_match"), completed_at: c.null(), signer_count: c.int(0), signers: c.null(), retry_after: c.int(0) })),
    ] }),
    s.set_var("found_id", ref("found.id", { safe: true })),
    s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("found_id")), cmp(col("role"), "=", c.text("signer"))], returnType: "count", as: "signer_count" }),
    s.set_var("signers", c.null()),
    s.set_var("given_id", withFilters(inp("public_id"), fl.first_notnull(c.text("")), fl.trim(), fl.upper())),
    s.conditional({ when: expr(ref("given_id"), "!=", c.text("")), then: [
      s.conditional({ when: expr(ref("given_id"), "=", ref("found.public_id", { safe: true })), then: [
        s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("found_id")), cmp(col("role"), "in", c.array(["signer", "approver"]))], sort: [{ sortBy: "step", dir: "asc" }, { sortBy: "id", dir: "asc" }], output: ["name", "role", "role_name"], as: "named" }),
        s.update_var("signers", ref("named")),
      ] }),
    ] }),
  ],
  response: { state: c.text("match"), completed_at: ref("found.completed_at", { safe: true }), signer_count: ref("signer_count"), signers: ref("signers"), retry_after: c.int(0) },
  responseShape: {} as VerifyAnswer,
});

export type FinalAnswer = {
  state: "ready" | "expired" | "rate_limited" | "unavailable";
  how: "signed" | "table" | null; url: string | null; name: string | null; retry_after: number;
  envelope: { title: string; public_id: string; final_sha256: string; completed_at: number } | null;
};
const finalRefusal = (state: string, retry: Value = c.int(0)) =>
  s.return(obj({ state: c.text(state), how: c.null(), url: c.null(), name: c.null(), retry_after: retry, envelope: c.null(), b64: c.null() }));

/**
 * A party's personal download: their raw token (from the completion email) to the signed copy. An unknown token, a purged
 * envelope or one that isn't completed are all `expired`. `with_bytes` adds the base64 bytes of a table-kept copy.
 */
export const finalForToken = defineFunction({
  name: "seal/final_for_token",
  description: "Find the signed copy a party's download token opens, rate limited per IP.",
  input: { token: input.text(), ip: input.text(), with_bytes: input.bool() },
  stack: [
    s.set_var("bucket", c.text("final:ip:")),
    s.conditional({ when: expr(inp("with_bytes"), "=", c.bool(true)), then: [s.update_var("bucket", c.text("final-raw:ip:"))] }),
    s.set_var("caller_ip", withFilters(inp("ip"), fl.first_notnull(c.text("")))),
    hit(withFilters(ref("bucket"), fl.concat(ref("caller_ip"))), DOWNLOAD_PER_MINUTE, 60),
    s.conditional({ when: expr(ref("rate.allowed"), "!=", c.bool(true)), then: [finalRefusal("rate_limited", ref("rate.retry_after"))] }),
    s.set_var("token", withFilters(inp("token"), fl.first_notnull(c.text("")), fl.trim())),
    s.conditional({ when: expr(withFilters(ref("token"), fl.strlen()), "<", c.int(20)), then: [finalRefusal("expired")] }),
    s.db.query({ table: recipient, where: cmp(col("download_hash"), "=", withFilters(ref("token"), fl.sha256())), output: ["id", "envelope_id"], returnType: "single", as: "party" }),
    s.conditional({ when: expr(ref("party"), "=", c.null()), then: [finalRefusal("expired")] }),
    s.set_var("party_env", withFilters(ref("party.envelope_id", { safe: true }), fl.first_notnull(c.int(0)))),
    s.db.get({ table: envelope, fieldValue: ref("party_env"), output: ["id", "status", "title", "public_id", "final_sha256", "final_file_id", "completed_at"], as: "env" }),
    s.conditional({ when: expr(ref("env.status", { safe: true }), "!=", c.text("completed")), then: [finalRefusal("expired")] }),
    s.set_var("final_id", withFilters(ref("env.final_file_id", { safe: true }), fl.first_notnull(c.int(0)))),
    s.db.get({ table: document_file, fieldValue: ref("final_id"), output: ["id", "name", "mode", "attachment"], as: "file" }),
    s.conditional({ when: expr(ref("file"), "=", c.null()), then: [finalRefusal("expired")] }),
    ...finalAccess("file"),
  ],
  response: {
    state: ref("access_state"), how: ref("how"), url: ref("url"), name: ref("file.name"), retry_after: c.int(0), b64: ref("b64"),
    envelope: obj({ title: ref("env.title"), public_id: ref("env.public_id"), final_sha256: ref("env.final_sha256"), completed_at: ref("env.completed_at") }),
  },
  responseShape: {} as FinalAnswer & { b64: string | null },
});

/** From a stored file row: a 60-second link (private storage) or, when `with_bytes`, its table bytes. Binds `access_state`, `how`, `url`, `b64`. */
function finalAccess(fileVar: string) {
  return statements(
    s.set_var("access_state", c.text("ready")),
    s.set_var("how", ref(`${fileVar}.mode`)),
    s.set_var("url", c.null()),
    s.set_var("b64", c.null()),
    s.conditional({ when: expr(ref(`${fileVar}.mode`), "=", c.text("signed")), then: [
      s.try_catch({
        try: [s.storage.sign_private_url({ pathname: ref(`${fileVar}.attachment.path`, { safe: true }), ttl: c.int(DOWNLOAD_LINK_SECONDS), as: "signed" }), s.update_var("url", ref("signed"))],
        catch: [s.update_var("access_state", c.text("unavailable"))],
      }),
    ] }),
    s.conditional({ when: expr(ref(`${fileVar}.mode`), "=", c.text("table")), then: [
      s.conditional({ when: expr(inp("with_bytes"), "=", c.bool(true)), then: [
        s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref(`${fileVar}.id`), output: ["b64"], as: "blob" }),
        s.update_var("b64", ref("blob.b64", { safe: true })),
        s.conditional({ when: expr(ref("b64"), "=", c.null()), then: [s.update_var("access_state", c.text("unavailable"))] }),
      ] }),
    ] }),
  );
}

export type MemberFinal = { state: "ready" | "not_ready" | "refused" | "unavailable"; how: "signed" | "table" | null; url: string | null; name: string | null; b64: string | null };
const memberRefusal = (state: string) => s.return(obj({ state: c.text(state), how: c.null(), url: c.null(), name: c.null(), b64: c.null() }));

/** A member's way to the signed copy: `refused` when they can't read the envelope, `not_ready` before it completes. */
export const memberFinal = defineFunction({
  name: "seal/member_final",
  description: "How a member gets an envelope's signed PDF right now; with_bytes adds a table-kept copy's bytes.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), with_bytes: input.bool() },
  stack: [
    s.function.run({ fn: canRead, as: "readable", input: { actor_id: inp("actor_id"), envelope_id: inp("envelope_id") } }),
    s.conditional({ when: expr(ref("readable"), "!=", c.bool(true)), then: [memberRefusal("refused")] }),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "status", "final_file_id"], as: "env" }),
    s.conditional({ when: expr(ref("env.status", { safe: true }), "!=", c.text("completed")), then: [memberRefusal("not_ready")] }),
    s.set_var("final_id", withFilters(ref("env.final_file_id", { safe: true }), fl.first_notnull(c.int(0)))),
    s.db.get({ table: document_file, fieldValue: ref("final_id"), output: ["id", "name", "mode", "attachment"], as: "file" }),
    s.conditional({ when: expr(ref("file"), "=", c.null()), then: [memberRefusal("unavailable")] }),
    ...finalAccess("file"),
  ],
  response: { state: ref("access_state"), how: ref("how"), url: ref("url"), name: ref("file.name"), b64: ref("b64") },
  responseShape: {} as MemberFinal,
});

/** The audit trail PDF for a member who may read the envelope. */
export const memberAuditPdf = defineFunction({
  name: "seal/member_audit_pdf",
  description: "An envelope's audit trail as a PDF, for a member who may read it.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: canRead, as: "readable", input: { actor_id: inp("actor_id"), envelope_id: inp("envelope_id") } }),
    s.conditional({ when: expr(ref("readable"), "!=", c.bool(true)), then: [s.return(obj({ state: c.text("refused"), name: c.null(), b64: c.null() }))] }),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["title", "public_id"], as: "env" }),
    guard.found("env", { errorType: "notfound", message: "That document doesn't exist." }),
    s.function.run({ fn: auditPdf, as: "trail", input: { envelope_id: inp("envelope_id") } }),
    s.conditional({ when: expr(ref("trail.ok"), "!=", c.bool(true)), then: [s.return(obj({ state: c.text("unavailable"), name: c.null(), b64: c.null() }))] }),
    s.function.run({ fn: cleanName, as: "name", input: { name: withFilters(ref("env.title"), fl.concat(c.text(" - audit trail.pdf"))) } }),
  ],
  response: { state: c.text("ready"), name: ref("name"), b64: ref("trail.b64") },
  responseShape: {} as { state: "ready" | "refused" | "unavailable"; name: string | null; b64: string | null },
});

/**
 * The original, the signed copy and the audit trail in one ZIP. Only table-kept documents can be read back into an archive here
 * (a privately stored file's bytes can't be), and building an archive needs a paid Xano instance: either way the answer is
 * `unavailable` and the files download one at a time.
 */
export const memberZip = defineFunction({
  name: "seal/member_zip",
  description: "Build a ZIP of an envelope's original, signed copy and audit trail, for a member who may read it.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: canRead, as: "readable", input: { actor_id: inp("actor_id"), envelope_id: inp("envelope_id") } }),
    s.conditional({ when: expr(ref("readable"), "!=", c.bool(true)), then: [s.return(obj({ state: c.text("refused"), name: c.null(), b64: c.null() }))] }),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "status", "title", "original_file_id", "final_file_id"], as: "env" }),
    s.conditional({ when: expr(ref("env.status", { safe: true }), "!=", c.text("completed")), then: [s.return(obj({ state: c.text("not_ready"), name: c.null(), b64: c.null() }))] }),
    s.set_var("orig_id", withFilters(ref("env.original_file_id", { safe: true }), fl.first_notnull(c.int(0)))),
    s.set_var("fin_id", withFilters(ref("env.final_file_id", { safe: true }), fl.first_notnull(c.int(0)))),
    s.db.get({ table: document_file, fieldValue: ref("orig_id"), output: ["id", "name", "mode"], as: "orig" }),
    s.db.get({ table: document_file, fieldValue: ref("fin_id"), output: ["id", "name", "mode"], as: "fin" }),
    s.set_var("orig_mode", withFilters(ref("orig.mode", { safe: true }), fl.first_notnull(c.text("")))),
    s.set_var("fin_mode", withFilters(ref("fin.mode", { safe: true }), fl.first_notnull(c.text("")))),
    s.set_var("orig_name", withFilters(ref("orig.name", { safe: true }), fl.first_notnull(c.text("document.pdf")))),
    s.set_var("fin_name", withFilters(ref("fin.name", { safe: true }), fl.first_notnull(c.text("document (signed).pdf")))),
    s.conditional({ when: expr(withFilters(ref("orig_mode"), fl.concat(c.text(",")), fl.concat(ref("fin_mode"))), "!=", c.text("table,table")), then: [
      s.return(obj({ state: c.text("unavailable"), name: c.null(), b64: c.null() })),
    ] }),
    s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref("orig_id"), output: ["b64"], as: "orig_blob" }),
    s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref("fin_id"), output: ["b64"], as: "fin_blob" }),
    s.function.run({ fn: auditPdf, as: "trail", input: { envelope_id: inp("envelope_id") } }),
    s.function.run({ fn: cleanName, as: "zip_name", input: { name: withFilters(ref("env.title"), fl.concat(c.text(".zip"))) } }),
    s.set_var("zipped", c.null()),
    s.try_catch({
      try: [
        s.zip.create_archive({ as: "zip", filename: ref("zip_name") }),
        s.storage.create_file_resource({ as: "f_orig", filename: c.text("original.pdf"), filedata: withFilters(ref("orig_blob.b64", { safe: true }), fl.base64_decode()) }),
        s.zip.add_to_archive({ file: ref("f_orig"), filename: withFilters(c.text("Original - "), fl.concat(ref("orig_name"))), zip: ref("zip") }),
        s.storage.create_file_resource({ as: "f_fin", filename: c.text("signed.pdf"), filedata: withFilters(ref("fin_blob.b64", { safe: true }), fl.base64_decode()) }),
        s.zip.add_to_archive({ file: ref("f_fin"), filename: withFilters(c.text("Signed - "), fl.concat(ref("fin_name"))), zip: ref("zip") }),
        s.conditional({ when: expr(ref("trail.ok"), "=", c.bool(true)), then: [
          s.storage.create_file_resource({ as: "f_trail", filename: c.text("audit.pdf"), filedata: withFilters(ref("trail.b64"), fl.base64_decode()) }),
          s.zip.add_to_archive({ file: ref("f_trail"), filename: c.text("Audit trail.pdf"), zip: ref("zip") }),
        ] }),
        s.storage.read_file_resource({ as: "zip_res", value: ref("zip") }),
        s.update_var("zipped", withFilters(ref("zip_res.data"), fl.base64_encode())),
      ],
      catch: [],
    }),
    s.conditional({ when: expr(ref("zipped"), "=", c.null()), then: [s.return(obj({ state: c.text("unavailable"), name: c.null(), b64: c.null() }))] }),
  ],
  response: { state: c.text("ready"), name: ref("zip_name"), b64: ref("zipped") },
  responseShape: {} as { state: "ready" | "refused" | "not_ready" | "unavailable"; name: string | null; b64: string | null },
});

export const sealFileFunctions = [sealOriginal, sealStoreFinal, verifyFinal, finalForToken, memberFinal, memberAuditPdf, memberZip];
