// Workflow tests for the seal, verify and the signed copy's downloads. A full seal can't run here: its lambda reaches the
// backend over HTTP, and a test run's rows live in their own database the routes don't see. frontend/scripts/seal-check.mjs seals
// real documents end to end against a deployed backend; these cover every rule around it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { c, cmp, col, defineFunction, fl, ref, s, withFilters, workflowTest as plainTest, type Value } from "@xano/sdk";
import { MOST_SEAL_ATTEMPTS, auditPdf, sealBuild, sealDue, sealRetry } from "../function/seal/build.js";
import { finalForToken, sealOriginal, sealStoreFinal, verifyFinal } from "../function/seal/files.js";
import { envelopeTransition } from "../function/envelope/transition.js";
import { envelope } from "../table/envelope/envelope.js";
import { purged_envelope } from "../table/envelope/purged_envelope.js";
import { audit_event } from "../table/signing/audit_event.js";
import { document_blob, document_file } from "../table/files/document_file.js";
import { vendor } from "../table/files/vendor.js";
import { notification } from "../base/tables.js";
import { recipient } from "../table/envelope/recipient.js";
import { draft, person, signer, workflowTest } from "./fixtures.js";
import { vendorFixture } from "./documents.js";

const require = createRequire(import.meta.url);
const FONTKIT_B64 = readFileSync(require.resolve("@pdf-lib/fontkit/dist/fontkit.umd.min.js")).toString("base64");
const NOTO_B64 = readFileSync(new URL("../seed-files/NotoSans-Regular.ttf", import.meta.url)).toString("base64");

/** Test fixture: the fontkit and Noto Sans rows a test run's empty database lacks (vendorFixture adds pdf-lib). */
export const sealVendorFixture = defineFunction({
  name: "test/vendor_seal",
  description: "Test fixture: adds the fontkit and Noto Sans vendor rows a test run's empty database lacks.",
  stack: [
    s.db.add({ table: vendor, as: "fk", row: { name: c.text("fontkit"), src: withFilters(c.text(FONTKIT_B64), fl.base64_decode()) } }),
    s.db.add({ table: vendor, as: "noto", row: { name: c.text("noto-sans"), src: c.text(NOTO_B64) } }),
  ],
  response: { ok: c.bool(true) },
});
const withLibs = [s.function.run({ fn: vendorFixture, as: "pdf_lib_ready" }), s.function.run({ fn: sealVendorFixture, as: "seal_libs_ready" })];

/** Nothing listens here, so the lambda's read of the original fails like any unreachable backend. */
const NOWHERE = "http://127.0.0.1:9";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const MINIMAL_PDF = "%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

const equal = (path: string, value: Value) => s.expect.to_equal({ expr: ref(path), value });
const build = (env: string, as: string, base = NOWHERE) => s.function.call({ fn: sealBuild, as, input: { envelope_id: ref(`${env}.id`), base_url: c.text(base) } });
const reload = (env: string, as: string) => s.db.get({ table: envelope, fieldValue: ref(`${env}.id`), as });
/** A table-kept original whose bytes aren't a usable PDF, attached to `env`. */
const brokenOriginal = (env: string) => [
  s.db.add({ table: document_file, as: `${env}_file`, row: { name: c.text("Broken.pdf"), size: c.int(20), sha256: c.text(H3), mode: c.text("table"), client_id: c.text(`orig-${env}`) } }),
  s.db.add({ table: document_blob, as: `${env}_blob`, row: { file_id: ref(`${env}_file.id`), b64: withFilters(c.text("%PDF-1.7 not really"), fl.base64_encode()) } }),
  s.db.edit({ table: envelope, fieldValue: ref(`${env}.id`), row: { original_file_id: ref(`${env}_file.id`) }, as: `${env}_linked` }),
];
const sealing = (as: string, sender: string, title: string) => draft(as, sender, title, { status: c.text("sealing") });

export const sealTests = [
  workflowTest({
    name: "seal: a failed attempt backs off; the fifth flags it, notes it on the trail and tells the sender",
    description: "The lambda can't read the original. Each attempt counts and clears its key; the fifth parks the envelope until Retry.",
    stack: [
      ...withLibs,
      person("sender"),
      sealing("env", "sender", "Broken lease"),
      ...brokenOriginal("env"),
      s.set_var("before", c.now()),
      build("env", "first", NOWHERE),
      equal("first.state", c.text("failed")),
      equal("first.ok", c.bool(false)),
      s.expect.to_not_equal({ expr: ref("first.error"), value: c.text("") }),
      reload("env", "after1"),
      equal("after1.seal_attempts", c.int(1)),
      equal("after1.status", c.text("sealing")),
      equal("after1.seal_failed", c.bool(false)),
      s.expect.to_be_null({ expr: ref("after1.seal_key_hash") }),
      // One minute after the first failure.
      s.expect.to_be_greater_than({ expr: ref("after1.seal_next_at"), value: withFilters(ref("before"), fl.add(c.int(59_000))) }),
      s.expect.to_be_less_than({ expr: ref("after1.seal_next_at"), value: withFilters(c.now(), fl.add(c.int(61_000))) }),
      build("env", "second", NOWHERE),
      reload("env", "after2"),
      equal("after2.seal_attempts", c.int(2)),
      s.expect.to_be_greater_than({ expr: ref("after2.seal_next_at"), value: withFilters(ref("before"), fl.add(c.int(119_000))) }),
      build("env", "third", NOWHERE),
      build("env", "fourth", NOWHERE),
      reload("env", "after4"),
      equal("after4.seal_failed", c.bool(false)),
      build("env", "fifth", NOWHERE),
      reload("env", "after5"),
      equal("after5.seal_attempts", c.int(MOST_SEAL_ATTEMPTS)),
      equal("after5.seal_failed", c.bool(true)),
      equal("after5.status", c.text("sealing")),
      s.expect.to_be_null({ expr: ref("after5.seal_next_at") }),
      s.db.query({ table: audit_event, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("kind"), "=", c.text("envelope.seal_failed"))], returnType: "single", as: "noted" }),
      s.set_var("noted_data", withFilters(ref("noted.data"), fl.json_decode())),
      equal("noted_data.attempts", c.int(5)),
      s.db.query({ table: notification, where: [cmp(col("user_id"), "=", ref("sender.id")), cmp(col("kind"), "=", c.text("seal_failed"))], returnType: "count", as: "told" }),
      equal("told", c.int(1)),
      // Parked: neither another run nor the sweep touches it.
      build("env", "sixth", NOWHERE),
      equal("sixth.state", c.text("flagged")),
      s.function.call({ fn: sealDue, as: "swept", input: { limit: c.int(5) } }),
      equal("swept.ran", c.int(0)),
      reload("env", "still"),
      equal("still.seal_attempts", c.int(5)),
    ],
  }),
  workflowTest({
    name: "seal: Retry clears the flag for the sender or an admin, and no one else",
    description: "A flagged envelope's count, error and flag reset and it's due at once; another member is refused.",
    stack: [
      person("sender"), person("mate"), person("boss", "admin"),
      draft("env", "sender", "Parked lease", { status: c.text("sealing"), seal_attempts: c.int(5), seal_error: c.text("boom") }),
      s.db.edit({ table: envelope, fieldValue: ref("env.id"), row: { seal_failed: c.bool(true) }, as: "parked" }),
      s.function.call({ fn: sealRetry, as: "nope", input: { actor_id: ref("mate.id"), envelope_id: ref("env.id") } }),
      equal("nope.state", c.text("refused")),
      reload("env", "untouched"),
      equal("untouched.seal_failed", c.bool(true)),
      s.function.call({ fn: sealRetry, as: "again", input: { actor_id: ref("sender.id"), envelope_id: ref("env.id") } }),
      equal("again.state", c.text("scheduled")),
      reload("env", "reset"),
      equal("reset.seal_failed", c.bool(false)),
      equal("reset.seal_attempts", c.int(0)),
      equal("reset.seal_error", c.text("")),
      s.expect.to_be_null({ expr: ref("reset.seal_next_at") }),
      s.db.query({ table: audit_event, where: [cmp(col("envelope_id"), "=", ref("env.id")), cmp(col("kind"), "=", c.text("envelope.seal_retried"))], returnType: "count", as: "noted" }),
      equal("noted", c.int(1)),
      s.db.edit({ table: envelope, fieldValue: ref("env.id"), row: { seal_failed: c.bool(true) }, as: "parked_again" }),
      s.function.call({ fn: sealRetry, as: "by_admin", input: { actor_id: ref("boss.id"), envelope_id: ref("env.id") } }),
      equal("by_admin.state", c.text("scheduled")),
    ],
  }),
  workflowTest({
    name: "seal: a second run on a completed envelope does nothing",
    description: "The envelope, its trail and its counters are untouched, and the answer says it was already done.",
    stack: [
      person("sender"),
      draft("env", "sender", "Done lease", { status: c.text("completed"), final_sha256: c.text(H1), seal_attempts: c.int(0) }),
      build("env", "again"),
      equal("again.ok", c.bool(true)),
      equal("again.state", c.text("already")),
      equal("again.completed", c.bool(false)),
      reload("env", "same"),
      equal("same.final_sha256", c.text(H1)),
      equal("same.seal_attempts", c.int(0)),
      s.expect.to_be_null({ expr: ref("same.seal_key_hash") }),
      s.db.query({ table: audit_event, where: cmp(col("envelope_id"), "=", ref("env.id")), returnType: "count", as: "events" }),
      equal("events", c.int(0)),
    ],
  }),
  workflowTest({
    name: "seal: a run already holding the envelope makes another answer busy, until its lease lapses",
    description: "Two runs at once can't both seal: the second sees the live key. A lease that ran out is taken over.",
    stack: [
      person("sender"),
      sealing("env", "sender", "Busy lease"),
      s.set_var("later", withFilters(c.now(), fl.add(c.int(120_000)))),
      s.db.edit({ table: envelope, fieldValue: ref("env.id"), row: { seal_key_hash: c.text(H2), seal_next_at: ref("later") }, as: "held" }),
      build("env", "second"),
      equal("second.state", c.text("busy")),
      reload("env", "held_still"),
      equal("held_still.seal_key_hash", c.text(H2)),
      s.set_var("earlier", withFilters(c.now(), fl.sub(c.int(1_000)))),
      s.db.edit({ table: envelope, fieldValue: ref("env.id"), row: { seal_next_at: ref("earlier") }, as: "lapsed" }),
      build("env", "takeover"),
      equal("takeover.state", c.text("failed")),
      reload("env", "after"),
      equal("after.seal_attempts", c.int(1)),
    ],
  }),
  workflowTest({
    name: "seal: the sweep runs only envelopes that are sealing, due and not flagged",
    description: "Not yet due, flagged and completed envelopes are left alone.",
    stack: [
      person("sender"),
      sealing("due", "sender", "Due lease"),
      sealing("later", "sender", "Later lease"),
      sealing("parked", "sender", "Parked lease"),
      draft("done", "sender", "Done lease", { status: c.text("completed") }),
      s.set_var("soon", withFilters(c.now(), fl.add(c.int(300_000)))),
      s.db.edit({ table: envelope, fieldValue: ref("later.id"), row: { seal_next_at: ref("soon") }, as: "l" }),
      s.db.edit({ table: envelope, fieldValue: ref("parked.id"), row: { seal_failed: c.bool(true) }, as: "p" }),
      s.function.call({ fn: sealDue, as: "swept", input: { limit: c.int(5) } }),
      s.expect.to_equal({ expr: withFilters(ref("swept.results"), fl.first(), fl.get("envelope_id")), value: ref("due.id") }),
      reload("due", "due_after"),
      equal("due_after.seal_attempts", c.int(1)),
      // No address was ever remembered here, which is a counted failure that says so.
      s.expect.to_contain({ expr: ref("due_after.seal_error"), value: c.text("address") }),
      reload("later", "later_after"),
      s.expect.to_be_null({ expr: ref("later_after.seal_attempts") }),
    ],
  }),
  workflowTest({
    name: "seal: the internal routes answer only the envelope's current seal key",
    description: "The right key reads the original and stores the signed copy, once per envelope; a wrong key or a finished seal is not found.",
    stack: [
      person("sender"),
      sealing("env", "sender", "Keyed lease"),
      s.db.add({ table: document_file, as: "orig", row: { name: c.text("Lease.pdf"), size: c.int(10), sha256: c.text(H3), mode: c.text("table"), client_id: c.text("orig-keyed") } }),
      s.db.add({ table: document_blob, as: "orig_blob", row: { file_id: ref("orig.id"), b64: withFilters(c.text(MINIMAL_PDF), fl.base64_encode()) } }),
      s.db.edit({ table: envelope, fieldValue: ref("env.id"), row: { original_file_id: ref("orig.id"), seal_key_hash: withFilters(c.text("the-key"), fl.sha256()) }, as: "keyed" }),
      s.function.call({ fn: sealOriginal, as: "read", input: { envelope_id: ref("env.id"), key: c.text("the-key") } }),
      s.expect.to_equal({ expr: withFilters(ref("read.b64"), fl.base64_decode()), value: c.text(MINIMAL_PDF) }),
      s.storage.create_file_resource({ as: "made", filename: c.text("signed.pdf"), filedata: c.text(MINIMAL_PDF) }),
      s.function.call({ fn: sealStoreFinal, as: "stored", input: { envelope_id: ref("env.id"), key: c.text("the-key"), file: ref("made") } }),
      equal("stored.sha256", withFilters(c.text(MINIMAL_PDF), fl.sha256())),
      s.function.call({ fn: sealStoreFinal, as: "stored_again", input: { envelope_id: ref("env.id"), key: c.text("the-key"), file: ref("made") } }),
      s.set_var("env_id_text", withFilters(ref("env.id"), fl.to_text())),
      s.set_var("seal_cid", withFilters(c.text("seal:"), fl.concat(ref("env_id_text")))),
      s.db.query({ table: document_file, where: cmp(col("client_id"), "=", ref("seal_cid")), returnType: "count", as: "copies" }),
      equal("copies", c.int(1)),
      s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref("stored_again.file_id"), as: "kept" }),
      s.expect.to_equal({ expr: withFilters(ref("kept.b64"), fl.base64_decode(), fl.sha256()), value: ref("stored_again.sha256") }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: envelope, where: cmp(col("title"), "=", c.text("Keyed lease")), returnType: "single", as: "e" }),
          s.function.call({ fn: sealOriginal, as: "wrong", input: { envelope_id: ref("e.id"), key: c.text("not-the-key") } }),
        ],
        exception: c.text("Not found"),
      }),
      s.db.edit({ table: envelope, fieldValue: ref("env.id"), row: { seal_key_hash: c.null() }, as: "cleared" }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: envelope, where: cmp(col("title"), "=", c.text("Keyed lease")), returnType: "single", as: "e" }),
          s.function.call({ fn: sealOriginal, as: "late", input: { envelope_id: ref("e.id"), key: c.text("the-key") } }),
        ],
        exception: c.text("Not found"),
      }),
    ],
  }),
  plainTest({
    name: "verify: a fingerprint matches, with names only alongside the same envelope's public id",
    description: "A hash alone gives the date and signer count; a wrong public id adds nothing; a tombstone is purged; anything else no match.",
    stack: [
      person("sender"),
      draft("env", "sender", "Verified lease", { status: c.text("completed"), final_sha256: c.text(H1), public_id: c.text("CS-AAAA-BBBB-CCCC"), completed_at: c.int(1_763_000_000_000) }),
      draft("other", "sender", "Other lease", { status: c.text("completed"), final_sha256: c.text(H2), public_id: c.text("CS-1111-2222-3333") }),
      signer("ana", "env", "ana@countersign-test.example"),
      signer("bo", "env", "bo@countersign-test.example"),
      signer("cy", "env", "cy@countersign-test.example", 1, "cc"),
      s.db.add({ table: purged_envelope, as: "tomb", row: { public_id: c.text("CS-DEAD-DEAD-DEAD"), final_sha256: c.text(H3), completed_at: c.int(1_700_000_000_000) } }),
      s.function.call({ fn: verifyFinal, as: "alone", input: { sha256: c.text(H1.toUpperCase()), ip: c.text("v1") } }),
      equal("alone.state", c.text("match")),
      equal("alone.completed_at", c.int(1_763_000_000_000)),
      equal("alone.signer_count", c.int(2)),
      s.expect.to_be_null({ expr: ref("alone.signers") }),
      s.function.call({ fn: verifyFinal, as: "wrong_id", input: { sha256: c.text(H1), public_id: c.text("CS-1111-2222-3333"), ip: c.text("v1") } }),
      equal("wrong_id.state", c.text("match")),
      s.expect.to_be_null({ expr: ref("wrong_id.signers") }),
      s.function.call({ fn: verifyFinal, as: "both", input: { sha256: c.text(H1), public_id: c.text(" cs-aaaa-bbbb-cccc "), ip: c.text("v1") } }),
      s.expect.to_equal({ expr: withFilters(ref("both.signers"), fl.count()), value: c.int(2) }),
      s.expect.to_equal({ expr: withFilters(ref("both.signers"), fl.first(), fl.get("name")), value: c.text("ana") }),
      s.expect.to_equal({ expr: withFilters(ref("both.signers"), fl.first(), fl.get("role")), value: c.text("signer") }),
      s.function.call({ fn: verifyFinal, as: "gone", input: { sha256: c.text(H3), public_id: c.text("CS-DEAD-DEAD-DEAD"), ip: c.text("v1") } }),
      equal("gone.state", c.text("purged")),
      s.expect.to_be_null({ expr: ref("gone.signers") }),
      s.function.call({ fn: verifyFinal, as: "none", input: { sha256: c.text("d".repeat(64)), ip: c.text("v1") } }),
      equal("none.state", c.text("no_match")),
      s.function.call({ fn: verifyFinal, as: "junk", input: { sha256: c.text("not a hash"), ip: c.text("v1") } }),
      equal("junk.state", c.text("invalid")),
    ],
  }),
  plainTest({
    name: "verify: more than 30 checks a minute from one address are turned away",
    description: "The 31st answers rate_limited with how long to wait; another address is unaffected.",
    stack: [
      s.foreach({ list: c.array(Array.from({ length: 30 }, (_, i) => i)), as: "n", body: [
        s.function.call({ fn: verifyFinal, as: "one", input: { sha256: c.text(H1), ip: c.text("busy-ip") } }),
      ] }),
      s.function.call({ fn: verifyFinal, as: "over", input: { sha256: c.text(H1), ip: c.text("busy-ip") } }),
      equal("over.state", c.text("rate_limited")),
      s.expect.to_be_greater_than({ expr: ref("over.retry_after"), value: c.int(0) }),
      s.function.call({ fn: verifyFinal, as: "elsewhere", input: { sha256: c.text(H1), ip: c.text("calm-ip") } }),
      equal("elsewhere.state", c.text("no_match")),
    ],
  }),
  plainTest({
    name: "final: a party's download token opens the signed copy, and nothing once it's gone",
    description: "Only the token's hash is stored. An unknown token, an unfinished envelope or a purged one answer expired.",
    stack: [
      person("sender"),
      draft("env", "sender", "Downloaded lease", { status: c.text("completed"), final_sha256: c.text(H1) }),
      s.db.add({ table: document_file, as: "fin", row: { name: c.text("Lease (signed).pdf"), size: c.int(10), sha256: c.text(H1), mode: c.text("table"), client_id: c.text("seal-test") } }),
      s.db.add({ table: document_blob, as: "fin_blob", row: { file_id: ref("fin.id"), b64: withFilters(c.text(MINIMAL_PDF), fl.base64_encode()) } }),
      s.db.edit({ table: envelope, fieldValue: ref("env.id"), row: { final_file_id: ref("fin.id") }, as: "linked" }),
      signer("cc", "env", "cy@countersign-test.example", 1, "cc"),
      s.set_var("token", c.text("Zm9vYmFyYmF6cXV4LXRva2VuLWZvci10ZXN0cw")),
      s.db.edit({ table: recipient, fieldValue: ref("cc.id"), row: { download_hash: withFilters(ref("token"), fl.sha256()) }, as: "minted" }),
      s.function.call({ fn: finalForToken, as: "link", input: { token: ref("token"), ip: c.text("f1"), with_bytes: c.bool(false) } }),
      equal("link.state", c.text("ready")),
      equal("link.how", c.text("table")),
      equal("link.name", c.text("Lease (signed).pdf")),
      equal("link.envelope.final_sha256", c.text(H1)),
      s.expect.to_be_null({ expr: ref("link.b64") }),
      s.function.call({ fn: finalForToken, as: "raw", input: { token: ref("token"), ip: c.text("f1"), with_bytes: c.bool(true) } }),
      s.expect.to_equal({ expr: withFilters(ref("raw.b64"), fl.base64_decode()), value: c.text(MINIMAL_PDF) }),
      s.function.call({ fn: finalForToken, as: "stranger", input: { token: c.text("a-token-nobody-was-ever-given-0000"), ip: c.text("f1"), with_bytes: c.bool(false) } }),
      equal("stranger.state", c.text("expired")),
      s.expect.to_be_null({ expr: ref("stranger.envelope") }),
      s.db.del({ table: envelope, fieldValue: ref("env.id") }),
      s.function.call({ fn: finalForToken, as: "purged", input: { token: ref("token"), ip: c.text("f1"), with_bytes: c.bool(true) } }),
      equal("purged.state", c.text("expired")),
      s.expect.to_be_null({ expr: ref("purged.b64") }),
    ],
  }),
  plainTest({
    name: "seal: the audit trail renders as its own PDF",
    description: "The same lambda draws the certificate and every event, with a name outside plain ASCII, and passes the chain check.",
    stack: [
      ...withLibs,
      person("sender"),
      draft("env", "sender", "Zoë's lease"),
      s.db.add({ table: recipient, as: "zoe", row: { envelope_id: ref("env.id"), name: c.text("Zoë Ng"), email: c.text("zoe@countersign-test.example"), role: c.text("signer"), status: c.text("waiting"), user_agent: c.text("Agent 山田") } }),
      s.function.call({ fn: envelopeTransition, as: "m1", input: { envelope_id: ref("env.id"), to: c.text("in_progress"), actor_type: c.text("user"), actor_id: ref("sender.id"), actor_name: c.text("Test sender") } }),
      s.function.call({ fn: auditPdf, as: "trail", input: { envelope_id: ref("env.id") } }),
      equal("trail.ok", c.bool(true)),
      s.expect.to_equal({ expr: withFilters(ref("trail.b64"), fl.base64_decode(), fl.substr(c.int(0), c.int(5))), value: c.text("%PDF-") }),
    ],
  }),
];

