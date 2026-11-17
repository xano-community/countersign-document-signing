// A new draft envelope from an uploaded PDF, in one call: store the file, check it opens, then make the draft. The browser combines
// several files into one before upload; the server records that one file as the original and fingerprints it itself. What the browser
// says about the separate files it combined is kept as it said it, and labelled as reported by the client.
import { c, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { user } from "../../table/user.js";
import { audit } from "../audit/audit.js";
import { storeDocument, type PageInfo, type StoreAnswer } from "../documents/documents.js";

const LONGEST_TITLE = 200;
const MOST_SOURCES = 50;
/** Tries at a public id before giving up; a clash among 2^48 ids is already very unlikely. */
const ID_TRIES = 3;

const ENVELOPE_VIEW = ["id", "public_id", "title", "status", "visibility", "original_file_id", "original_sha256", "page_count", "pages", "sources"] as const;

export type SourceFile = { name: string; sha256: string; pages: number };
export type NewEnvelope = {
  id: number; public_id: string; title: string; status: "draft"; visibility: "private" | "team"; original_file_id: number; original_sha256: string;
  page_count: number; pages: PageInfo[]; sources: SourceFile[];
};
export type CreateAnswer = { ok: boolean; code: StoreAnswer["code"]; message: string; envelope: NewEnvelope | null; repeat: boolean };

/** A random public id like CS-7F3A-09BC-D41E: printed on the signed PDF and typed into the verify page, never the row id. */
export const newPublicId = [
  s.set_var("public_id", c.text("")),
  s.foreach({ list: c.array(Array.from({ length: ID_TRIES }, (_, i) => i)), as: "try_no", body: [
    s.conditional({ when: expr(ref("public_id"), "=", c.text("")), then: [
      s.security.random_bytes({ length: c.int(6), as: "raw_id" }),
      s.set_var("hex", withFilters(ref("raw_id"), fl.bin2hex(), fl.upper())),
      s.set_var("part1", withFilters(ref("hex"), fl.substr(c.int(0), c.int(4)))),
      s.set_var("part2", withFilters(ref("hex"), fl.substr(c.int(4), c.int(4)))),
      s.set_var("part3", withFilters(ref("hex"), fl.substr(c.int(8), c.int(4)))),
      s.set_var("candidate", withFilters(c.text("CS-"), fl.concat(ref("part1")), fl.concat(c.text("-")), fl.concat(ref("part2")), fl.concat(c.text("-")), fl.concat(ref("part3")))),
      s.db.get({ table: envelope, fieldName: "public_id", fieldValue: ref("candidate"), output: ["id"], as: "taken" }),
      s.conditional({ when: expr(ref("taken"), "=", c.null()), then: [s.update_var("public_id", ref("candidate"))] }),
    ] }),
  ] }),
];

/** Keeps only name, sha256 and pages from each reported source, as plain values: the browser's word, bounded. */
const cleanSources = [
  s.set_var("sources", c.array([])),
  s.conditional({ when: expr(withFilters(inp("sources"), fl.is_array()), "=", c.bool(true)), then: [
    s.foreach({ list: withFilters(inp("sources"), fl.array_slice(c.int(0), c.int(MOST_SOURCES))), as: "src", body: [
      s.set_var("one_source", obj({
        name: withFilters(ref("src.name", { safe: true }), fl.first_notnull(c.text("")), fl.to_text(), fl.substr(c.int(0), c.int(LONGEST_TITLE))),
        sha256: withFilters(ref("src.sha256", { safe: true }), fl.first_notnull(c.text("")), fl.to_text(), fl.lower(), fl.substr(c.int(0), c.int(64))),
        pages: withFilters(ref("src.pages", { safe: true }), fl.first_notnull(c.int(0)), fl.to_int()),
      })),
      s.update_var("sources", withFilters(ref("sources"), fl.array_push(ref("one_source")))),
    ] }),
  ] }),
];

export const createEnvelope = defineFunction({
  name: "envelope/create",
  description: "Store an uploaded PDF and make a draft envelope from it, with its fingerprint and pages. A retry with the same client id answers the same draft.",
  input: {
    actor_id: input.int({ required: true }), file: input.file(), client_id: input.text(), title: input.text(), visibility: input.text(), sources: input.json(),
    /** True to start a template instead of a document. */
    as_template: input.bool(),
    ip: input.text(), user_agent: input.text(),
  },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "name", "email", "role", "status"], as: "actor" }),
    rbac.allows(ref("actor.role", { safe: true }), "envelope.send", "Your role can't send documents for signature."),
    s.set_var("as_template", withFilters(inp("as_template"), fl.first_notnull(c.bool(false)))),
    s.conditional({ when: expr(ref("as_template"), "=", c.bool(true)), then: [
      rbac.allows(ref("actor.role", { safe: true }), "template.manage", "Your role can't make templates."),
    ] }),
    ...cleanSources,
    s.set_var("visibility", c.text("private")),
    s.conditional({ when: expr(inp("visibility"), "=", c.text("team")), then: [s.update_var("visibility", c.text("team"))] }),

    s.function.run({ fn: storeDocument, as: "stored", input: { actor_id: inp("actor_id"), file: inp("file"), client_id: inp("client_id") } }),
    s.conditional({ when: expr(ref("stored.ok"), "!=", c.bool(true)), then: [
      s.return(obj({ ok: c.bool(false), code: ref("stored.code"), message: ref("stored.message"), envelope: c.null(), repeat: c.bool(false) })),
    ] }),
    // A retried upload whose draft was already made answers that draft.
    s.conditional({ when: expr(ref("stored.repeat"), "=", c.bool(true)), then: [
      s.db.get({ table: envelope, fieldName: "original_file_id", fieldValue: ref("stored.file.id"), output: ENVELOPE_VIEW, as: "existing" }),
      s.conditional({ when: expr(ref("existing"), "!=", c.null()), then: [
        s.return(obj({ ok: c.bool(true), code: c.text(""), message: c.text(""), envelope: ref("existing"), repeat: c.bool(true) })),
      ] }),
    ] }),

    // The title the sender typed, or the file's name without ".pdf".
    s.set_var("title", withFilters(inp("title"), fl.first_notnull(c.text("")), fl.trim(), fl.substr(c.int(0), c.int(LONGEST_TITLE)))),
    s.conditional({ when: expr(ref("title"), "=", c.text("")), then: [
      s.update_var("title", withFilters(c.text("/\\.pdf$/i"), fl.regex_replace(c.text(""), ref("stored.file.name")))),
      s.conditional({ when: expr(ref("title"), "=", c.text("")), then: [s.update_var("title", c.text("Untitled document"))] }),
    ] }),

    ...newPublicId,
    s.conditional({ when: expr(ref("public_id"), "=", c.text("")), then: [
      s.return(obj({ ok: c.bool(false), code: c.text("failed"), message: c.text("This document couldn't be created. Try again."), envelope: c.null(), repeat: c.bool(false) })),
    ] }),
    s.set_var("now_ms", c.now()),
    // New documents start with the organisation's defaults; the sender changes them under Review.
    s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["default_expiry_days", "default_reminder_days"], returnType: "single", as: "defaults" }),
    s.set_var("start_expiry", withFilters(ref("defaults.default_expiry_days", { safe: true }), fl.first_notempty(c.int(30)))),
    s.set_var("start_reminders", withFilters(ref("defaults.default_reminder_days", { safe: true }), fl.first_notnull(c.int(3)))),
    s.db.add({ table: envelope, as: "made", row: {
      public_id: ref("public_id"), title: ref("title"), status: c.text("draft"), sender_id: inp("actor_id"), visibility: ref("visibility"),
      original_file_id: ref("stored.file.id"), original_sha256: ref("stored.file.sha256"), page_count: ref("stored.page_count"), pages: ref("stored.pages"),
      sources: ref("sources"), expiry_days: ref("start_expiry"), reminder_days: ref("start_reminders"), is_template: ref("as_template"), is_demo: c.bool(false), updated_at: ref("now_ms"),
    } }),
    audit({
      envelope: ref("made.id"),
      kind: "envelope.created",
      actor: { type: c.text("user"), id: inp("actor_id"), name: ref("actor.name"), email: ref("actor.email"), ip: inp("ip"), ua: inp("user_agent") },
      data: obj({
        title: ref("title"), file_name: ref("stored.file.name"), size: ref("stored.file.size"), sha256: ref("stored.file.sha256"),
        page_count: ref("stored.page_count"), storage: ref("stored.file.mode"),
        // Fingerprints the sender's browser computed for each file it combined. The server never saw those files on their own.
        sources_reported_by_client: ref("sources"),
      }),
    }),
    changed({ entity: "envelope", id: ref("made.id"), op: "created", actor: inp("actor_id") }),
    s.db.get({ table: envelope, fieldValue: ref("made.id"), output: ENVELOPE_VIEW, as: "view" }),
  ],
  response: { ok: c.bool(true), code: c.text(""), message: c.text(""), envelope: ref("view"), repeat: c.bool(false) },
  responseShape: {} as CreateAnswer,
});

export const createFunctions = [createEnvelope];
