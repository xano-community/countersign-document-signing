// Workflow tests for uploads: what the server refuses, what it keeps, and who gets the original back. A real multipart upload and the
// size limits at full size go through frontend/scripts/upload-check.mjs against a deployed backend.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { c, cmp, col, defineFunction, fl, ref, s, withFilters, workflowTest as plainTest, type Value } from "@xano/sdk";
import { verifyFn } from "../function/audit/audit.js";
import { originalBytes, originalLink, storeDocument } from "../function/documents/documents.js";
import { canRead } from "../function/envelope/access.js";
import { createEnvelope } from "../function/envelope/create.js";
import { audit_event } from "../table/signing/audit_event.js";
import { envelope } from "../table/envelope/envelope.js";
import { document_blob, document_file } from "../table/files/document_file.js";
import { user } from "../table/user.js";
import { vendor } from "../table/files/vendor.js";
import { draft, person, workflowTest } from "./fixtures.js";

/** Small PDFs made with pdf-lib (and pypdf for the owner password). `three` has a page rotated 90 degrees and one with a crop box. */
const PDF = {
  three: { b64: "JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgNSAwIFIgNiAwIFIgXQovQ291bnQgMwo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0PgovTW9kRGF0ZSAoRDoxOTcwMDEwMTAwMDAwMFopCi9DcmVhdG9yIDxGRUZGMDA3ND4KL0NyZWF0aW9uRGF0ZSAoRDoxOTcwMDEwMTAwMDAwMFopCj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQo+PgplbmRvYmoKCjUgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAxIDAgUgovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAgMCA2MTIgNzkyIF0KL1JvdGF0ZSA5MAo+PgplbmRvYmoKCjYgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAxIDAgUgovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAgMCA1OTUgODQyIF0KL0Nyb3BCb3ggWyAxMCAyMCAzMTAgNDIwIF0KPj4KZW5kb2JqCgp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA4OCAwMDAwMCBuIAowMDAwMDAwMTM4IDAwMDAwIG4gCjAwMDAwMDAyNjQgMDAwMDAgbiAKMDAwMDAwMDM1NSAwMDAwMCBuIAowMDAwMDAwNDU3IDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo1NzUKJSVFT0Y=", sha256: "fefb0d21830a8d3e28e6eb49a28afe3e95338908e343eb4d4514a3a2e49a155b" },
  one: { b64: "JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0PgovTW9kRGF0ZSAoRDoxOTcwMDEwMTAwMDAwMFopCi9DcmVhdG9yIDxGRUZGMDA3ND4KL0NyZWF0aW9uRGF0ZSAoRDoxOTcwMDEwMTAwMDAwMFopCj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMCAwIDQwMCAzMDAgXQo+PgplbmRvYmoKCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDc2IDAwMDAwIG4gCjAwMDAwMDAxMjYgMDAwMDAgbiAKMDAwMDAwMDI1MiAwMDAwMCBuIAoKdHJhaWxlcgo8PAovU2l6ZSA1Ci9Sb290IDIgMCBSCi9JbmZvIDMgMCBSCj4+CgpzdGFydHhyZWYKMzQzCiUlRU9G", sha256: "1f0383c4c222a725db0c32627a7184d355e4c651658815a231828ac5f2a21e6e" },
  /** Opens without a password in a viewer (owner password only), and pdf-lib refuses it as encrypted. */
  owner: "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgMyAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMCAwIDQwMCAzMDAgXQo+PgplbmRvYmoKNCAwIG9iago8PAovUHJvZHVjZXIgPGE1MjM2MzYxPgovTW9kRGF0ZSA8MWZlNjUyMmMyMzNhM2NmNzM4YWU0MGNjZjA2MmY5YmQ0ZD4KL0NyZWF0b3IgPGE1MjM2MzYxPgovQ3JlYXRpb25EYXRlIDwxZmU2NTIyYzIzM2EzY2Y3MzhhZTQwY2NmMDYyZjliZDRkPgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8OTEzYjA3M2Y1YjY1OTU0YzhiNmRhMjIxNjk5NzFhMTc3YjdlNmQ5NGExMDZmZjc1YzBjMTYyOTZiYzE1NDEyZT4KL1UgPDgwMzJmYWY5MGJjNzA0M2FiNDhkNDI4YTlkZThjOGMyMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAowMDAwMDAwMTIzIDAwMDAwIG4gCjAwMDAwMDAyMTMgMDAwMDAgbiAKMDAwMDAwMDM3MiAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMSAwIFIKL0luZm8gNCAwIFIKL0lEIFsgPDYxMzczMzM1MzUzNjMwNjQ2NjYyMzIzMDM0Mzk2NjYyMzgzOTMxMzA2NTM3MzI2MjMwMzY2MTY2MzUzMDY1NjY+IDw2MTM3MzMzNTM1MzYzMDY0NjY2MjMyMzAzNDM5NjY2MjM4MzkzMTMwNjUzNzMyNjIzMDM2NjE2NjM1MzA2NTY2PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo1ODcKJSVFT0YK",
  /** A real 1x1 PNG. */
  png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
};

/**
 * A test run starts with an empty database, so the seeded `vendor` rows aren't there: the PDF check needs pdf-lib, and this fixture
 * adds it. It's a function so the 500 KB of source is in the bundle once, not once per test.
 */
// Base64, because the engine won't take the minified source as a plain text literal.
const PDF_LIB_B64 = readFileSync(createRequire(import.meta.url).resolve("pdf-lib/dist/pdf-lib.min.js")).toString("base64");
export const vendorFixture = defineFunction({
  name: "test/vendor_pdf_lib",
  description: "Test fixture: adds the pdf-lib vendor row a test run's empty database lacks.",
  stack: [s.db.add({ table: vendor, as: "lib", row: { name: c.text("pdf-lib"), src: withFilters(c.text(PDF_LIB_B64), fl.base64_decode()) } })],
  response: { ok: c.bool(true) },
});
const withPdfLib = s.function.run({ fn: vendorFixture, as: "vendor_ready" });

/** An uploaded file, as the server receives it, from base64. */
const upload = (as: string, name: string, b64: string) => s.storage.create_file_resource({ as, filename: c.text(name), filedata: withFilters(c.text(b64), fl.base64_decode()) });
const store = (who: string, as: string, file: string, clientId: string) =>
  s.function.call({ fn: storeDocument, as, input: { actor_id: ref(`${who}.id`), file: ref(file), client_id: c.text(clientId) } });
const create = (who: string, as: string, file: string, clientId: string, extra: Record<string, Value> = {}) =>
  s.function.call({ fn: createEnvelope, as, input: { actor_id: ref(`${who}.id`), file: ref(file), client_id: c.text(clientId), ...extra } });
const equal = (path: string, value: Value) => s.expect.to_equal({ expr: ref(path), value });
const countRows = (table: typeof document_file | typeof document_blob | typeof envelope, as: string) => s.db.query({ table, returnType: "count", as });
const reads = (who: string, env: string, as: string, expected: boolean) => [
  s.function.call({ fn: canRead, as, input: { actor_id: ref(`${who}.id`), envelope_id: ref(`${env}.id`) } }),
  equal(as, c.bool(expected)),
];

export const documentTests = [
  workflowTest({
    name: "documents: a PDF is kept with the fingerprint of its stored bytes and each page read",
    description: "On the Engine the bytes live in a table. The SHA-256 is of the stored bytes, and each page's size, rotation and crop box come from pdf-lib.",
    stack: [
      withPdfLib,
      person("sender"),
      upload("pdf", "Lease.pdf", PDF.three.b64),
      store("sender", "up", "pdf", "lease-1"),
      equal("up.ok", c.bool(true)),
      equal("up.file.mode", c.text("table")),
      equal("up.file.name", c.text("Lease.pdf")),
      equal("up.file.sha256", c.text(PDF.three.sha256)),
      equal("up.page_count", c.int(3)),
      equal("up.pages.0.w", c.int(612)),
      equal("up.pages.1.rotation", c.int(90)),
      equal("up.pages.2.crop.x", c.int(10)),
      equal("up.pages.2.crop.w", c.int(300)),
      s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref("up.file.id"), as: "blob" }),
      s.expect.to_equal({ expr: withFilters(ref("blob.b64"), fl.base64_decode(), fl.sha256()), value: ref("up.file.sha256") }),
      equal("blob.b64", c.text(PDF.three.b64)),
    ],
  }),
  plainTest({
    name: "documents: a PNG named .pdf is refused by its bytes",
    description: "The server reads the first bytes, not the name or the stated type, and keeps nothing.",
    stack: [
      person("sender"),
      upload("fake", "Contract.pdf", PDF.png),
      store("sender", "up", "fake", "fake-1"),
      equal("up.ok", c.bool(false)),
      equal("up.code", c.text("not_pdf")),
      equal("up.message", c.text("This file isn't a PDF. Only PDF files can be sent for signature.")),
      countRows(document_file, "kept"),
      equal("kept", c.int(0)),
    ],
  }),
  plainTest({
    name: "documents: a 6 MB PDF is refused in table mode, naming the 5 MB limit",
    description: "The limit follows where the bytes would live. Nothing is kept.",
    stack: [
      person("sender"),
      // 24 characters doubled 18 times: 6 MiB of filler after a PDF header.
      s.set_var("pad", c.text("0123456789abcdef01234567")),
      s.foreach({ list: c.array(Array.from({ length: 18 }, (_, i) => i)), as: "round", body: [s.update_var("pad", withFilters(ref("pad"), fl.concat(ref("pad"))))] }),
      s.storage.create_file_resource({ as: "big", filename: c.text("Big.pdf"), filedata: withFilters(c.text("%PDF-1.7\n"), fl.concat(ref("pad"))) }),
      store("sender", "up", "big", "big-1"),
      equal("up.ok", c.bool(false)),
      equal("up.code", c.text("too_big")),
      equal("up.message", c.text("This file is over the 5 MB limit for this deployment.")),
      countRows(document_file, "kept"),
      equal("kept", c.int(0)),
    ],
  }),
  plainTest({
    name: "documents: an owner-password PDF is refused with a plain reason",
    description: "pdf-lib, the library the seal uses, won't write to an encrypted PDF, so it's refused at upload and removed again.",
    stack: [
      withPdfLib,
      person("sender"),
      upload("locked", "Locked.pdf", PDF.owner),
      store("sender", "up", "locked", "locked-1"),
      equal("up.ok", c.bool(false)),
      equal("up.code", c.text("encrypted")),
      equal("up.message", c.text("This PDF is password-protected. Remove the password and upload it again.")),
      countRows(document_file, "kept"),
      equal("kept", c.int(0)),
      countRows(document_blob, "bytes"),
      equal("bytes", c.int(0)),
    ],
  }),
  plainTest({
    name: "documents: a damaged PDF is refused",
    description: "A file that starts like a PDF but isn't one passes the first check and fails the open.",
    stack: [
      withPdfLib,
      person("sender"),
      s.storage.create_file_resource({ as: "broken", filename: c.text("Broken.pdf"), filedata: c.text("%PDF-1.7\nthis is not really a PDF\n%%EOF") }),
      store("sender", "up", "broken", "broken-1"),
      equal("up.ok", c.bool(false)),
      equal("up.code", c.text("damaged")),
      countRows(document_file, "kept"),
      equal("kept", c.int(0)),
    ],
  }),
  plainTest({
    name: "documents: a retried upload with the same client id answers the same file",
    description: "The browser's id makes a retry safe: one row, the same id, marked as a repeat.",
    stack: [
      withPdfLib,
      person("sender"),
      upload("pdf", "One.pdf", PDF.one.b64),
      store("sender", "first", "pdf", "retry-1"),
      store("sender", "again", "pdf", "retry-1"),
      equal("first.repeat", c.bool(false)),
      equal("again.ok", c.bool(true)),
      equal("again.repeat", c.bool(true)),
      equal("again.file.id", ref("first.file.id")),
      equal("again.page_count", c.int(1)),
      countRows(document_file, "kept"),
      equal("kept", c.int(1)),
    ],
  }),
  workflowTest({
    name: "documents: an upload makes a draft with a random public id, its pages and a created event",
    description: "The client's source fingerprints are kept as reported, and a retry answers the same draft.",
    stack: [
      withPdfLib,
      person("sender"),
      upload("pdf", "Offer letter.pdf", PDF.three.b64),
      s.set_var("sources", c.array([
        { name: "Offer.pdf", sha256: "AB".repeat(32), pages: 2 },
        { name: "Terms.pdf", sha256: "cd".repeat(32), pages: 1, extra: "dropped" },
      ])),
      create("sender", "made", "pdf", "env-1", { title: c.text(""), visibility: c.text("team"), sources: ref("sources") }),
      equal("made.ok", c.bool(true)),
      equal("made.envelope.title", c.text("Offer letter")),
      equal("made.envelope.status", c.text("draft")),
      equal("made.envelope.visibility", c.text("team")),
      equal("made.envelope.page_count", c.int(3)),
      equal("made.envelope.original_sha256", c.text(PDF.three.sha256)),
      equal("made.envelope.pages.1.rotation", c.int(90)),
      s.expect.to_match({ expr: ref("made.envelope.public_id"), value: c.text("/^CS-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/") }),
      equal("made.envelope.sources.0.sha256", c.text("ab".repeat(32))),
      s.expect.to_be_null({ expr: ref("made.envelope.sources.1.extra", { safe: true }) }),
      s.db.query({ table: audit_event, where: cmp(col("envelope_id"), "=", ref("made.envelope.id")), returnType: "single", as: "event" }),
      equal("event.kind", c.text("envelope.created")),
      equal("event.actor_type", c.text("user")),
      s.set_var("event_data", withFilters(ref("event.data"), fl.json_decode())),
      equal("event_data.sha256", c.text(PDF.three.sha256)),
      equal("event_data.sources_reported_by_client.1.name", c.text("Terms.pdf")),
      s.function.call({ fn: verifyFn, as: "chain", input: { envelope_id: ref("made.envelope.id") } }),
      equal("chain.ok", c.bool(true)),
      create("sender", "again", "pdf", "env-1", { title: c.text("Other"), sources: ref("sources") }),
      equal("again.repeat", c.bool(true)),
      equal("again.envelope.id", ref("made.envelope.id")),
      countRows(envelope, "drafts"),
      equal("drafts", c.int(1)),
    ],
  }),
  workflowTest({
    name: "documents: a viewer can't make a draft",
    description: "Sending needs envelope.send, and nothing is stored first.",
    stack: [
      person("watcher", "viewer"),
      s.expect.to_throw({
        body: [
          s.db.query({ table: user, where: cmp(col("email"), "=", c.text("watcher@countersign-test.example")), returnType: "single", as: "watcher" }),
          upload("pdf", "One.pdf", PDF.one.b64),
          create("watcher", "made", "pdf", "viewer-1"),
        ],
        exception: c.text("can't send documents"),
      }),
      countRows(document_file, "kept"),
      equal("kept", c.int(0)),
    ],
  }),
  plainTest({
    name: "documents: who can see an envelope",
    description: "The sender always; with team visibility, anyone who reads the team's; an admin reads all; nobody else.",
    stack: [
      person("sender"), person("mate"), person("watcher", "viewer"), person("boss", "admin"),
      draft("mine", "sender", "Private lease"),
      draft("shared", "sender", "Shared lease", { visibility: c.text("team") }),
      ...reads("sender", "mine", "r1", true),
      ...reads("mate", "mine", "r2", false),
      ...reads("watcher", "mine", "r3", false),
      ...reads("boss", "mine", "r4", true),
      ...reads("mate", "shared", "r5", true),
      ...reads("watcher", "shared", "r6", true),
    ],
  }),
  workflowTest({
    name: "documents: the original comes back byte for byte, only to someone who can see it",
    description: "In table mode the link says to use the bytes route; another member gets a refusal and no bytes.",
    stack: [
      withPdfLib,
      person("sender"), person("mate"),
      upload("pdf", "Lease.pdf", PDF.three.b64),
      create("sender", "made", "pdf", "orig-1"),
      s.function.call({ fn: originalLink, as: "link", input: { actor_id: ref("sender.id"), envelope_id: ref("made.envelope.id") } }),
      equal("link.how", c.text("table")),
      equal("link.name", c.text("Lease.pdf")),
      s.function.call({ fn: originalBytes, as: "bytes", input: { actor_id: ref("sender.id"), envelope_id: ref("made.envelope.id") } }),
      equal("bytes.b64", c.text(PDF.three.b64)),
      s.function.call({ fn: originalLink, as: "mate_link", input: { actor_id: ref("mate.id"), envelope_id: ref("made.envelope.id") } }),
      equal("mate_link.how", c.text("refused")),
      s.expect.to_throw({
        body: [
          s.db.query({ table: user, where: cmp(col("email"), "=", c.text("mate@countersign-test.example")), returnType: "single", as: "mate" }),
          s.db.query({ table: envelope, where: cmp(col("title"), "=", c.text("Lease")), returnType: "single", as: "env" }),
          s.function.call({ fn: originalBytes, as: "stolen", input: { actor_id: ref("mate.id"), envelope_id: ref("env.id") } }),
        ],
        exception: c.text("doesn't exist"),
      }),
    ],
  }),
];
