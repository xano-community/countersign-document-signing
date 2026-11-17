import { f, table } from "@xano/sdk";
import { SEED_SIGNATURES } from "../../world.js";
import { recipient } from "../envelope/recipient.js";

/** The signature and initials a recipient adopted, as PNG bytes (base64, at most 200 KB). Reused for all their fields. */
export const signature = table({
  name: "signature",
  description: "A recipient's adopted signature or initials.",
  schema: {
    recipient_id: f.tableRef(recipient, { required: true }),
    kind: f.enum(["signature", "initials"], { required: true }),
    method: f.enum(["typed", "drawn", "uploaded"], { required: true }),
    png_b64: f.text({ required: true }),
  },
  seed: SEED_SIGNATURES,
  index: [{ type: "btree", fields: [{ name: "recipient_id", op: "asc" }] }],
});
