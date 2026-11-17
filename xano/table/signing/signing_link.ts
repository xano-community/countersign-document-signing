import { f, table } from "@xano/sdk";
import { recipient } from "../envelope/recipient.js";

/** One signing link sent or copied for a recipient. Only the token's SHA-256 is kept; the raw link exists only in the email or on screen. */
export const signing_link = table({
  name: "signing_link",
  description: "A signing link's fingerprint, and whether it has been revoked.",
  schema: {
    recipient_id: f.tableRef(recipient, { required: true }),
    token_hash: f.text({ required: true }),
    round: f.int(),
    /** "email", "reminder" or "copied". */
    via: f.text(),
    revoked: f.bool(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "token_hash", op: "asc" }] },
    { type: "btree", fields: [{ name: "recipient_id", op: "asc" }] },
  ],
});
