// Making the signed PDF. When the last person finishes, the envelope is in `sealing` ("Finishing"); `seal/build` gathers everything
// the PDF says, runs the seal lambda, checks what it stored, and completes the envelope. It runs right after the last signer's
// request (`sealKick`, a post_process step) and from the one-minute sweep (`seal/due`), so it must be safe to run twice:
//
// - Only one run works on an envelope at a time. A run claims it under the row lock by minting a one-time seal key (stored hashed)
//   and leasing it until `seal_next_at`; another run before then answers `busy`. A run that died leaves a lease that simply lapses.
// - A completed envelope answers `already` and changes nothing.
// - A failure counts an attempt and waits 1, 2, 5, then 10 minutes. The fifth flags `seal_failed`, writes it to the trail and tells
//   the sender, and the sweep leaves it alone until someone presses Retry (`seal/retry`).
//
// The PDF bytes never cross into the lambda: it reads the original over HTTP (a short signed link in private storage, or the
// internal `seal` route in table mode) and posts the result back to the internal upload route, both with the seal key.
import { c, caught, cmp, col, defineFunction, env, expr, fl, guard, inp, input, obj, or, ref, s, statements, sys, withFilters, type Value } from "@xano/sdk";
import { lam } from "@xano/sdk/node";
import { changed, notify } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { field } from "../../table/envelope/field.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { signature } from "../../table/signing/signature.js";
import { audit_event } from "../../table/signing/audit_event.js";
import { document_blob, document_file } from "../../table/files/document_file.js";
import { vendor } from "../../table/files/vendor.js";
import { user } from "../../table/user.js";
import { audit, verifyFn } from "../audit/audit.js";
import { enqueueFn } from "../email/outbox.js";
import { discardDocument } from "../documents/documents.js";
import { envelopeTransition, recipientTransition } from "../envelope/transition.js";

const MINUTE_MS = 60_000;
/** How long one run holds an envelope. Longer than the lambda may take, so a live run is never taken over. */
const LEASE_MS = 5 * MINUTE_MS;
const LAMBDA_SECONDS = 240;
/** How long the lambda's link to a privately stored original lives. */
const ORIGINAL_LINK_SECONDS = 600;
export const MOST_SEAL_ATTEMPTS = 5;
/** Waits after the 1st, 2nd, 3rd and 4th failure. */
const BACKOFF_MINUTES = [1, 2, 5, 10];
/** The internal routes the lambda calls: `{base}/api:seal/seal/{envelope_id}/original` and `/final`. */
export const SEAL_GROUP = "seal";
/** The document_file client id a seal stores its result under: one per envelope, so a new attempt replaces an earlier one's. */
/** Binds `seal_cid`, the client id as text: the id is made text first, so it compares and filters as text everywhere. */
export const bindSealClientId = (envelopeId: Value) => statements(
  s.set_var("seal_eid_text", withFilters(envelopeId, fl.to_text())),
  s.set_var("seal_cid", withFilters(c.text("seal:"), fl.concat(ref("seal_eid_text")))),
);

/** The settings row, and the API's base address: the one given, or the one remembered from requests. Binds `org` and `base`. */
export const bindBase = (given: Value) => statements(
  s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["id", "org_name", "api_base_url"], returnType: "single", as: "org" }),
  s.set_var("remembered_base", withFilters(ref("org.api_base_url", { safe: true }), fl.first_notnull(c.text("")))),
  s.set_var("org_name", withFilters(ref("org.org_name", { safe: true }), fl.first_notempty(c.text("Countersign")))),
  s.set_var("base", withFilters(given, fl.first_notempty(ref("remembered_base")), fl.first_notnull(c.text("")), fl.trim(), fl.rtrim(c.text("/")))),
);

/** Binds `libs`: pdf-lib, fontkit and the font, as the lambda loads them. */
export const bindLibs = statements(
  s.db.get({ table: vendor, fieldName: "name", fieldValue: c.text("pdf-lib"), output: ["src"], as: "lib_pdf" }),
  s.db.get({ table: vendor, fieldName: "name", fieldValue: c.text("fontkit"), output: ["src"], as: "lib_fontkit" }),
  s.db.get({ table: vendor, fieldName: "name", fieldValue: c.text("noto-sans"), output: ["src"], as: "lib_font" }),
  s.set_var("libs", obj({
    pdflib: withFilters(ref("lib_pdf.src", { safe: true }), fl.first_notnull(c.text(""))),
    fontkit: withFilters(ref("lib_fontkit.src", { safe: true }), fl.first_notnull(c.text(""))),
    font: withFilters(ref("lib_font.src", { safe: true }), fl.first_notnull(c.text(""))),
  })),
);

/**
 * Everything the certificate says about an envelope. Binds `cert_env`, `cert_recipients` (with `host_name`), `cert_events`,
 * `signatures` ({ "<recipient id>:<kind>": png base64 }, the latest of each) and `chain` (audit/verify).
 */
export const bindEvidence = (envelopeId: Value) => statements(
  s.db.get({ table: envelope, fieldValue: envelopeId, output: ["id", "public_id", "title", "sender_id", "original_file_id", "page_count", "original_sha256", "final_sha256", "chain_head", "completed_at", "status"], as: "cert_env" }),
  guard.found("cert_env", { errorType: "notfound", message: "That document doesn't exist." }),
  s.db.get({ table: user, fieldValue: ref("cert_env.sender_id"), output: ["name", "email"], as: "cert_sender" }),
  s.set_var("sender_email", withFilters(ref("cert_sender.email", { safe: true }), fl.first_notnull(c.text("")))),
  s.set_var("sender_label", withFilters(ref("cert_sender.name", { safe: true }), fl.first_notempty(ref("sender_email")))),
  s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", envelopeId), sort: [{ sortBy: "step", dir: "asc" }, { sortBy: "id", dir: "asc" }], output: [
    "id", "role", "role_name", "name", "email", "status", "identity_check", "consented_at", "disclosure_version", "ip", "user_agent", "opened_at", "completed_at", "hosted_by",
  ], as: "cert_rows" }),
  s.set_var("cert_recipients", c.array([])),
  s.set_var("signatures", obj({})),
  s.foreach({ list: ref("cert_rows"), as: "cr", body: [
    s.set_var("host_name", c.text("")),
    s.set_var("host_id", withFilters(ref("cr.hosted_by"), fl.first_notnull(c.int(0)))),
    s.conditional({ when: expr(ref("host_id"), ">", c.int(0)), then: [
      s.db.get({ table: user, fieldValue: ref("host_id"), output: ["name"], as: "host" }),
      s.update_var("host_name", withFilters(ref("host.name", { safe: true }), fl.first_notnull(c.text("")))),
    ] }),
    s.update_var("cert_recipients", withFilters(ref("cert_recipients"), fl.array_push(withFilters(ref("cr"), fl.set("host_name", ref("host_name")))))),
    // Oldest first, so a later adoption replaces an earlier one in the map.
    s.db.query({ table: signature, where: cmp(col("recipient_id"), "=", ref("cr.id")), sort: [{ sortBy: "id", dir: "asc" }], output: ["kind", "png_b64"], as: "cr_sigs" }),
    s.foreach({ list: ref("cr_sigs"), as: "sg", body: [
      s.set_var("sig_key", withFilters(ref("cr.id"), fl.to_text(), fl.concat(c.text(":")), fl.concat(ref("sg.kind")))),
      s.update_var("signatures", withFilters(ref("signatures"), fl.set(ref("sig_key"), ref("sg.png_b64")))),
    ] }),
  ] }),
  s.db.query({ table: audit_event, where: cmp(col("envelope_id"), "=", envelopeId), sort: [{ sortBy: "seq", dir: "asc" }], output: ["seq", "kind", "actor_type", "actor_name", "actor_email", "ip", "user_agent", "data", "at"], as: "cert_events" }),
  s.function.run({ fn: verifyFn, as: "chain", input: { envelope_id: envelopeId } }),
);

/** The optional signing certificate, from the backend's environment: empty values mean seal without a digital signature. */
const signingConfig = () => obj({
  key: withFilters(env("SIGNING_KEY"), fl.first_notnull(c.text(""))), cert: withFilters(env("SIGNING_CERT"), fl.first_notnull(c.text(""))),
  chain: withFilters(env("SIGNING_CHAIN"), fl.first_notnull(c.text(""))), name: ref("org_name"),
});

/** What Settings shows about the signing certificate: whether one is set, who it names, who issued it, until when, and whether the key fits. */
export const signingInfoFn = defineFunction({
  name: "seal/signing_info",
  description: "The configured document-signing certificate, read without signing anything.",
  stack: [
    s.set_var("org_name", c.text("")),
    s.set_var("job", obj({ mode: c.text("certinfo"), signing: signingConfig() })),
    s.set_var("libs", obj({})),
    s.lambda({ as: "info", timeout: c.int(20), code: lam.file("../../lambdas/seal.ts") }),
  ],
  response: ref("info"),
  responseShape: {} as { ok: boolean; configured?: boolean; key_ok?: boolean; subject?: string; issuer?: string; not_before?: number; not_after?: number; self_signed?: boolean; chain?: number; error?: string },
});

/** The envelope part of the lambda's job. */
const jobEnvelope = (extra: Record<string, Value> = {}) => obj({
  public_id: ref("cert_env.public_id"), title: ref("cert_env.title"), page_count: ref("cert_env.page_count"),
  original_sha256: ref("cert_env.original_sha256"), chain_head: ref("chain.head"),
  org_name: ref("org_name"),
  sender: ref("sender_label"),
  ...extra,
});

/**
 * A failed attempt: count it, drop whatever it stored, and either schedule the next try or, at the fifth, flag the envelope, write
 * it to the trail and tell the sender. Leaves a completed envelope alone.
 */
export const sealFail = defineFunction({
  name: "seal/fail",
  description: "Record a failed seal attempt: back off, or flag the envelope and tell the sender after the fifth.",
  input: { envelope_id: input.int({ required: true }), error: input.text() },
  stack: [
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "status", "title", "sender_id", "seal_attempts"], as: "failed_env" }),
    guard.found("failed_env", { errorType: "notfound", message: "That document doesn't exist." }),
    s.conditional({ when: expr(ref("failed_env.status"), "=", c.text("completed")), then: [s.return(obj({ attempts: ref("failed_env.seal_attempts"), flagged: c.bool(false) }))] }),
    ...bindSealClientId(inp("envelope_id")),
    s.db.query({ table: document_file, where: cmp(col("client_id"), "=", ref("seal_cid")), output: ["id"], returnType: "single", as: "leftover" }),
    s.conditional({ when: expr(ref("leftover"), "!=", c.null()), then: [s.function.run({ fn: discardDocument, as: "dropped", input: { file_id: ref("leftover.id", { safe: true }) } })] }),
    s.set_var("attempts", withFilters(ref("failed_env.seal_attempts"), fl.first_notnull(c.int(0)), fl.add(c.int(1)))),
    s.set_var("error_text", withFilters(inp("error"), fl.first_notempty(c.text("The signed copy couldn't be made.")), fl.substr(c.int(0), c.int(500)))),
    s.set_var("now_ms", c.now()),
    s.set_var("wait_ms", c.int(BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1] * MINUTE_MS)),
    ...BACKOFF_MINUTES.map((m, i) => s.conditional({ when: expr(ref("attempts"), "=", c.int(i + 1)), then: [s.update_var("wait_ms", c.int(m * MINUTE_MS))] })),
    s.set_var("next_at", withFilters(ref("now_ms"), fl.add(ref("wait_ms")))),
    s.set_var("flagged", withFilters(ref("attempts"), fl.gte(c.int(MOST_SEAL_ATTEMPTS)))),
    s.db.patch({ table: envelope, fieldValue: inp("envelope_id"), data: obj({
      seal_attempts: ref("attempts"), seal_error: ref("error_text"), seal_key_hash: c.null(), seal_next_at: ref("next_at"),
      seal_failed: ref("flagged"), final_file_id: c.int(0), final_sha256: c.text(""), updated_at: ref("now_ms"),
    }), as: "backed_off" }),
    s.conditional({ when: expr(ref("flagged"), "=", c.bool(true)), then: [
      s.db.patch({ table: envelope, fieldValue: inp("envelope_id"), data: obj({ seal_next_at: c.null() }), as: "parked" }),
      audit({ envelope: inp("envelope_id"), kind: "envelope.seal_failed", data: obj({ attempts: ref("attempts"), error: ref("error_text") }) }),
      notify({
        to: ref("failed_env.sender_id"), kind: "seal_failed", actor: c.int(0),
        title: withFilters(c.text("Couldn't finish “"), fl.concat(ref("failed_env.title")), fl.concat(c.text("”"))),
        body: c.text("Everyone has signed, but the signed copy couldn't be made after 5 tries. Open the document and choose Retry."),
        link: withFilters(c.text("/envelopes/"), fl.concat(inp("envelope_id"))),
      }),
    ] }),
    changed({ entity: "envelope", id: inp("envelope_id"), op: "updated", actor: c.int(0) }),
  ],
  response: { attempts: ref("attempts"), flagged: ref("flagged") },
  responseShape: {} as { attempts: number; flagged: boolean },
});

export type BuildAnswer = {
  ok: boolean;
  /** `completed` now; `already` completed; `busy` another run holds it; `flagged` waiting for Retry; `not_sealing`; `missing`; `failed` this attempt. */
  state: "completed" | "already" | "busy" | "flagged" | "not_sealing" | "missing" | "failed";
  completed: boolean; error: string; final_sha256: string; chain_head: string; pages: number; ms: number;
};
const answer = (state: string, extra: Record<string, Value> = {}) => obj({
  ok: c.bool(state === "completed" || state === "already"), state: c.text(state), completed: c.bool(state === "completed"), error: c.text(""),
  final_sha256: c.text(""), chain_head: c.text(""), pages: c.int(0), ms: c.int(0), ...extra,
});

export const sealBuild = defineFunction({
  name: "seal/build",
  description: "Make an envelope's signed PDF with its certificate, store it, and complete the envelope. Safe to run twice.",
  input: {
    envelope_id: input.int({ required: true }),
    /** The API's base address ("https://x.xano.io"), when the caller knows it; otherwise the one remembered on the settings row. */
    base_url: input.text(),
  },
  stack: [
    s.set_var("started_ms", c.now()),
    s.set_var("claim", c.text("")),
    s.set_var("seal_key", c.text("")),
    s.db.transaction({ body: [
      s.db.get({ table: envelope, fieldValue: inp("envelope_id"), lock: true, output: ["id", "status", "seal_failed", "seal_key_hash", "seal_next_at"], as: "env" }),
      s.conditional({ when: expr(ref("env"), "=", c.null()), then: [s.update_var("claim", c.text("missing"))] }),
      s.conditional({ when: expr(ref("claim"), "=", c.text("")), then: [
        s.conditional({ when: expr(ref("env.status", { safe: true }), "=", c.text("completed")), then: [s.update_var("claim", c.text("already"))] }),
      ] }),
      s.conditional({ when: expr(ref("claim"), "=", c.text("")), then: [
        s.conditional({ when: expr(ref("env.status", { safe: true }), "!=", c.text("sealing")), then: [s.update_var("claim", c.text("not_sealing"))] }),
      ] }),
      s.conditional({ when: expr(ref("claim"), "=", c.text("")), then: [
        s.conditional({ when: expr(ref("env.seal_failed", { safe: true }), "=", c.bool(true)), then: [s.update_var("claim", c.text("flagged"))] }),
      ] }),
      s.conditional({ when: expr(ref("claim"), "=", c.text("")), then: [
        s.conditional({ when: expr(withFilters(ref("env.seal_key_hash", { safe: true }), fl.first_notnull(c.text(""))), "!=", c.text("")), then: [
          s.conditional({ when: expr(withFilters(ref("env.seal_next_at", { safe: true }), fl.first_notnull(c.int(0))), ">", ref("started_ms")), then: [s.update_var("claim", c.text("busy"))] }),
        ] }),
      ] }),
      s.conditional({ when: expr(ref("claim"), "=", c.text("")), then: [
        s.security.random_bytes({ length: c.int(32), as: "key_raw" }),
        s.update_var("seal_key", withFilters(ref("key_raw"), fl.bin2hex())),
        s.db.patch({ table: envelope, fieldValue: inp("envelope_id"), data: obj({
          seal_key_hash: withFilters(ref("seal_key"), fl.sha256()), seal_next_at: withFilters(ref("started_ms"), fl.add(c.int(LEASE_MS))),
        }), as: "claimed" }),
        s.update_var("claim", c.text("claimed")),
      ] }),
    ] }),
    ...(["missing", "already", "not_sealing", "flagged", "busy"] as const).map((st) =>
      s.conditional({ when: expr(ref("claim"), "=", c.text(st)), then: [s.return(answer(st))] })),

    s.set_var("error", c.text("")),
    s.set_var("sealed", obj({ ok: c.bool(false), sha256: c.text(""), pages: c.int(0) })),
    s.set_var("chain", obj({ ok: c.bool(false), head: c.text("") })),
    s.try_catch({
      try: [
        ...bindBase(inp("base_url")),
        ...bindEvidence(inp("envelope_id")),
        s.conditional({ when: expr(ref("chain.ok"), "!=", c.bool(true)), then: [
          s.update_var("error", withFilters(c.text("The audit trail failed its integrity check at event "), fl.concat(ref("chain.broken_at")), fl.concat(c.text(".")))),
        ] }),
        s.conditional({ when: expr(ref("base"), "=", c.text("")), then: [
          s.update_var("error", c.text("This app's address isn't known yet, so the signed copy can't be made. Open Countersign in a browser once.")),
        ] }),
        s.conditional({ when: expr(ref("error"), "=", c.text("")), then: [
          s.db.get({ table: document_file, fieldValue: withFilters(ref("cert_env.original_file_id"), fl.first_notnull(c.int(0))), output: ["id", "mode", "attachment"], as: "orig" }),
          guard.found("orig", { errorType: "notfound", message: "This document's original file is missing." }),
          s.set_var("seal_url", withFilters(ref("base"), fl.concat(c.text(`/api:${SEAL_GROUP}/seal/`)), fl.concat(inp("envelope_id")))),
          s.set_var("get_url", withFilters(ref("seal_url"), fl.concat(c.text("/original")))),
          s.set_var("get_key", c.bool(true)),
          s.conditional({ when: expr(ref("orig.mode"), "=", c.text("signed")), then: [
            s.storage.sign_private_url({ pathname: ref("orig.attachment.path", { safe: true }), ttl: c.int(ORIGINAL_LINK_SECONDS), as: "orig_link" }),
            s.update_var("get_url", ref("orig_link")),
            s.update_var("get_key", c.bool(false)),
          ] }),
          s.db.query({ table: field, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "page", dir: "asc" }, { sortBy: "id", dir: "asc" }], output: ["id", "recipient_id", "type", "page", "x", "y", "w", "h", "value"], as: "fields" }),
          ...bindLibs,
          s.set_var("job", obj({
            mode: c.text("seal"), key: ref("seal_key"), get_url: ref("get_url"), get_key: ref("get_key"),
            put_url: withFilters(ref("seal_url"), fl.concat(c.text("/final"))),
            envelope: jobEnvelope({ completed_at: ref("started_ms") }), fields: ref("fields"), recipients: ref("cert_recipients"), signatures: ref("signatures"), events: ref("cert_events"),
            signing: signingConfig(),
          })),
          s.lambda({ as: "lambda_said", timeout: c.int(LAMBDA_SECONDS), code: lam.file("../../lambdas/seal.ts") }),
          // A lambda that throws answers its error text, not an object: anything without ok: true is a failed attempt.
          s.update_var("sealed", ref("lambda_said")),
          s.conditional({ when: expr(ref("lambda_said.ok", { safe: true }), "!=", c.bool(true)), then: [
            s.set_var("lambda_text", withFilters(ref("lambda_said"), fl.json_encode())),
            s.update_var("error", withFilters(ref("lambda_said.error", { safe: true }), fl.first_notempty(ref("lambda_text")))),
          ] }),
        ] }),
        // What was stored must be exactly what the lambda made: its row's fingerprint, and in table mode a fresh hash of the bytes.
        s.conditional({ when: expr(ref("error"), "=", c.text("")), then: [
          s.db.get({ table: document_file, fieldValue: ref("sealed.file_id"), output: ["id", "mode", "sha256", "client_id"], as: "final_row" }),
          s.set_var("stored_sha", withFilters(ref("final_row.sha256", { safe: true }), fl.first_notnull(c.text("")))),
          s.conditional({ when: expr(ref("final_row.mode", { safe: true }), "=", c.text("table")), then: [
            s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref("sealed.file_id"), output: ["b64"], as: "final_blob" }),
            s.update_var("stored_sha", withFilters(ref("final_blob.b64", { safe: true }), fl.first_notnull(c.text("")), fl.base64_decode(), fl.sha256())),
          ] }),
          s.conditional({ when: expr(ref("stored_sha"), "!=", ref("sealed.sha256")), then: [
            s.update_var("error", c.text("The stored signed copy doesn't match the one that was made.")),
          ] }),
          ...bindSealClientId(inp("envelope_id")),
          s.conditional({ when: expr(ref("final_row.client_id", { safe: true }), "!=", ref("seal_cid")), then: [
            s.update_var("error", c.text("The signed copy was stored for a different document.")),
          ] }),
        ] }),
        s.conditional({ when: expr(ref("error"), "=", c.text("")), then: [
          s.set_var("done_ms", c.now()),
          s.db.patch({ table: envelope, fieldValue: inp("envelope_id"), data: obj({
            final_file_id: ref("sealed.file_id"), final_sha256: ref("sealed.sha256"), chain_head: ref("chain.head"),
            seal_key_hash: c.null(), seal_next_at: c.null(), seal_error: c.text(""), updated_at: ref("done_ms"),
          }), as: "recorded" }),
          // A CC gets a copy rather than signing: they finish with the envelope.
          s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", inp("envelope_id")), cmp(col("role"), "=", c.text("cc")), cmp(col("status"), "=", c.text("waiting"))], output: ["id"], as: "copies" }),
          s.foreach({ list: ref("copies"), as: "cc", body: [
            s.function.run({ fn: recipientTransition, as: "cc_done", input: { recipient_id: ref("cc.id"), to: c.text("completed"), actor_type: c.text("system"), actor_id: c.int(0) } }),
          ] }),
          s.function.run({ fn: envelopeTransition, as: "completed", input: {
            envelope_id: inp("envelope_id"), to: c.text("completed"), actor_type: c.text("system"), actor_id: c.int(0),
            data: obj({ final_sha256: ref("sealed.sha256"), original_sha256: ref("cert_env.original_sha256"), chain_head: ref("chain.head"), pages: ref("sealed.pages") }),
          } }),
          // Everyone on it gets their own link to the signed copy (made when each email is sent), and the sender is told.
          s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", inp("envelope_id")), output: ["id"], as: "everyone" }),
          s.foreach({ list: ref("everyone"), as: "party", body: [
            s.function.run({ fn: enqueueFn, as: "q_copy", input: { kind: c.text("completed"), recipient_id: ref("party.id"), envelope_id: inp("envelope_id") } }),
          ] }),
          s.function.run({ fn: enqueueFn, as: "q_notice", input: { kind: c.text("notice_completed"), recipient_id: c.int(0), user_id: ref("cert_env.sender_id"), source_id: inp("envelope_id"), envelope_id: inp("envelope_id") } }),
          notify({ to: ref("cert_env.sender_id"), kind: "completed", actor: c.int(0), title: withFilters(ref("cert_env.title"), fl.concat(c.text(" is signed by everyone"))), link: withFilters(c.text("/documents/"), fl.concat(inp("envelope_id"))) }),
        ] }),
      ],
      catch: [s.update_var("error", withFilters(caught("message"), fl.first_notempty(c.text("The signed copy couldn't be made."))))],
    }),
    s.conditional({ when: expr(ref("error"), "!=", c.text("")), then: [
      s.function.run({ fn: sealFail, as: "fail", input: { envelope_id: inp("envelope_id"), error: ref("error") } }),
      s.return(answer("failed", { ok: c.bool(false), error: ref("error"), ms: withFilters(c.now(), fl.sub(ref("started_ms"))) })),
    ] }),
  ],
  response: answer("completed", {
    final_sha256: ref("sealed.sha256"), chain_head: ref("chain.head"), pages: ref("sealed.pages"), ms: withFilters(c.now(), fl.sub(ref("started_ms"))),
  }),
  responseShape: {} as BuildAnswer,
});

/**
 * Statements for a request that may have just put an envelope into `sealing` (the last signer's finish, Retry): start the seal
 * once the response has gone. The API's address comes from this request, so it works before the settings row has one. If it
 * fails, the sweep picks it up.
 */
export const sealKick = (envelopeId: Value) => statements(
  s.set_var("kick_base", withFilters(c.regex(/\/api:.*$/), fl.regex_replace(c.text(""), sys.apiBaseUrl()))),
  s.util.post_process([s.function.run({ fn: sealBuild, as: "kicked", input: { envelope_id: envelopeId, base_url: ref("kick_base") } })]),
);

/** Retry a seal that gave up: the sender or an admin. Clears the flag and the count; the caller kicks it off at once. */
export const sealRetry = defineFunction({
  name: "seal/retry",
  description: "Try again to make the signed copy of an envelope whose seal failed: its sender or an admin.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }), ip: input.text(), user_agent: input.text() },
  stack: [
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "status", "sender_id", "seal_failed"], as: "env" }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "name", "email", "role", "status"], as: "actor" }),
    s.conditional({ when: expr(ref("actor"), "=", c.null()), then: [s.return(obj({ ok: c.bool(false), state: c.text("refused") }))] }),
    s.conditional({ when: expr(ref("env"), "=", c.null()), then: [s.return(obj({ ok: c.bool(false), state: c.text("refused") }))] }),
    s.set_var("allowed", c.bool(false)),
    s.conditional({ when: expr(ref("actor.status", { safe: true }), "=", c.text("active")), then: [
      s.conditional({ when: expr(ref("env.sender_id", { safe: true }), "=", inp("actor_id")), then: [s.update_var("allowed", c.bool(true))] }),
      s.conditional({ when: rbac.has(ref("actor.role", { safe: true }), "envelope.read_all"), then: [s.update_var("allowed", c.bool(true))] }),
    ] }),
    s.conditional({ when: expr(ref("allowed"), "=", c.bool(false)), then: [s.return(obj({ ok: c.bool(false), state: c.text("refused") }))] }),
    s.conditional({ when: expr(ref("env.status", { safe: true }), "=", c.text("completed")), then: [s.return(obj({ ok: c.bool(true), state: c.text("completed") }))] }),
    s.conditional({ when: expr(ref("env.status", { safe: true }), "!=", c.text("sealing")), then: [s.return(obj({ ok: c.bool(false), state: c.text("not_sealing") }))] }),
    s.db.patch({ table: envelope, fieldValue: inp("envelope_id"), data: obj({
      seal_failed: c.bool(false), seal_attempts: c.int(0), seal_error: c.text(""), seal_next_at: c.null(), seal_key_hash: c.null(), updated_at: c.now(),
    }), as: "reset" }),
    audit({
      envelope: inp("envelope_id"), kind: "envelope.seal_retried",
      actor: { type: c.text("user"), id: inp("actor_id"), name: ref("actor.name"), email: ref("actor.email"), ip: inp("ip"), ua: inp("user_agent") },
      data: obj({ was_flagged: withFilters(ref("env.seal_failed"), fl.first_notnull(c.bool(false))) }),
    }),
    changed({ entity: "envelope", id: inp("envelope_id"), op: "updated", actor: inp("actor_id") }),
  ],
  response: { ok: c.bool(true), state: c.text("scheduled") },
  responseShape: {} as { ok: boolean; state: "scheduled" | "completed" | "not_sealing" | "refused" },
});

/** The sweep's step: seal what's due, a few at a time, oldest first. One envelope's failure doesn't stop the rest. */
export const sealDue = defineFunction({
  name: "seal/due",
  description: "Run the seal for envelopes in sealing whose next try is due and that haven't been flagged.",
  input: { limit: input.int() },
  stack: [
    s.set_var("now_ms", c.now()),
    s.set_var("batch", withFilters(inp("limit"), fl.first_notempty(c.int(5)))),
    s.db.query({ table: envelope, where: [
      cmp(col("status"), "=", c.text("sealing")),
      cmp(col("seal_failed"), "!=", c.bool(true)),
      or(cmp(col("seal_next_at"), "=", c.null()), expr(col("seal_next_at"), "<=", ref("now_ms"))),
    ], sort: [{ sortBy: "seal_next_at", dir: "asc" }, { sortBy: "id", dir: "asc" }], paging: { per_page: 20, metadata: false }, output: ["id"], as: "due" }),
    s.set_var("results", c.array([])),
    s.foreach({ list: withFilters(ref("due"), fl.array_slice(c.int(0), ref("batch"))), as: "one", body: [
      s.set_var("result", obj({ envelope_id: ref("one.id"), state: c.text("failed") })),
      s.try_catch({
        try: [
          s.function.run({ fn: sealBuild, as: "built", input: { envelope_id: ref("one.id"), base_url: c.text("") } }),
          s.update_var("result", obj({ envelope_id: ref("one.id"), state: ref("built.state") })),
        ],
        catch: [],
      }),
      s.update_var("results", withFilters(ref("results"), fl.array_push(ref("result")))),
    ] }),
  ],
  response: { ran: withFilters(ref("results"), fl.count()), results: ref("results") },
});

/** The audit trail as its own PDF, for a member who may read the envelope. Small, so it comes back as base64. */
export const auditPdf = defineFunction({
  name: "seal/audit_pdf",
  description: "Render an envelope's certificate and audit trail as a PDF of its own.",
  input: { envelope_id: input.int({ required: true }) },
  stack: [
    ...bindBase(c.text("")),
    ...bindEvidence(inp("envelope_id")),
    ...bindLibs,
    s.set_var("job", obj({
      mode: c.text("audit"), recipients: ref("cert_recipients"), signatures: ref("signatures"), events: ref("cert_events"),
      envelope: jobEnvelope({
        final_sha256: withFilters(ref("cert_env.final_sha256"), fl.first_notnull(c.text(""))), completed_at: ref("cert_env.completed_at"),
        chain_ok: ref("chain.ok"), broken_at: ref("chain.broken_at"),
      }),
    })),
    s.lambda({ as: "made", timeout: c.int(120), code: lam.file("../../lambdas/seal.ts") }),
    s.set_var("result", obj({ ok: c.bool(true), b64: ref("made.b64", { safe: true }), error: c.text("") })),
    s.conditional({ when: expr(ref("made.ok", { safe: true }), "!=", c.bool(true)), then: [
      s.set_var("made_text", withFilters(ref("made"), fl.json_encode())),
      s.update_var("result", obj({ ok: c.bool(false), b64: c.text(""), error: withFilters(ref("made.error", { safe: true }), fl.first_notempty(ref("made_text"))) })),
    ] }),
  ],
  response: ref("result"),
  responseShape: {} as { ok: boolean; b64: string; error: string },
});

export const sealFunctions = [sealFail, sealBuild, sealRetry, sealDue, auditPdf, signingInfoFn];
