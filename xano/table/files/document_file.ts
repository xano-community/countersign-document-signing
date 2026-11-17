import { f, table } from "@xano/sdk";
import { SEED_BLOBS } from "../../world.js";
import { SEED_FILES } from "../../world.js";

/**
 * A stored PDF: an envelope's original or its signed copy. `signed` mode lives in private storage and is read through a short
 * signed link; `table` mode keeps the bytes in document_blob, for a deployment that can't sign links (the local Engine).
 */
export const document_file = table({
  name: "document_file",
  description: "A stored PDF and where its bytes live.",
  schema: {
    name: f.text({ required: true }),
    size: f.int(),
    sha256: f.text({ required: true }),
    mode: f.enum(["signed", "table"], { required: true }),
    attachment: f.attachment({ nullable: true }),
    uploaded_by: f.int(),
    /** Chosen by the uploader's browser, so a retried upload finds the row it already made. */
    client_id: f.text({ nullable: true }),
    is_demo: f.bool(),
  },
  seed: SEED_FILES,
  index: [{ type: "btree|unique", fields: [{ name: "client_id", op: "asc" }] }],
});

/** A table-kept document's bytes, as base64, apart from document_file so a list never reads them. */
export const document_blob = table({
  name: "document_blob",
  description: "The bytes of a table-kept document.",
  schema: {
    file_id: f.tableRef(document_file, { required: true }),
    b64: f.text({ required: true }),
  },
  seed: SEED_BLOBS,
  index: [{ type: "btree|unique", fields: [{ name: "file_id", op: "asc" }] }],
});
