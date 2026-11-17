import { f, table } from "@xano/sdk";

/** What's left of an envelope deleted under retention: enough for the verify page to say so, and nothing about who signed. */
export const purged_envelope = table({
  name: "purged_envelope",
  description: "Tombstones of envelopes deleted under the retention period.",
  schema: {
    public_id: f.text({ required: true }),
    final_sha256: f.text(),
    completed_at: f.timestamp({ nullable: true }),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "public_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "final_sha256", op: "asc" }] },
  ],
});
