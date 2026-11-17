import { f, table } from "@xano/sdk";
import { envelope } from "../envelope/envelope.js";

/**
 * Everything that happened to an envelope, in order. Rows are only ever added, by audit/append, and each carries the hash
 * of the one before it: editing any row breaks every hash after it, which audit/verify reports.
 */
export const audit_event = table({
  name: "audit_event",
  description: "An envelope's append-only, hash-chained audit trail.",
  schema: {
    envelope_id: f.tableRef(envelope, { required: true }),
    seq: f.int({ required: true }),
    kind: f.text({ required: true }),
    /** "user", "recipient" or "system". */
    actor_type: f.text(),
    actor_id: f.int(),
    actor_name: f.text(),
    actor_email: f.text(),
    ip: f.text(),
    user_agent: f.text(),
    /** The event's details as JSON text, kept as written: the hash covers these exact characters (a json column reorders keys). */
    data: f.text(),
    at: f.int({ required: true }),
    hash_version: f.int({ required: true }),
    prev_hash: f.text(),
    hash: f.text({ required: true }),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "envelope_id", op: "asc" }, { name: "seq", op: "asc" }] },
  ],
});
