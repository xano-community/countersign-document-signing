import { f, table } from "@xano/sdk";
import { user } from "../user.js";

/**
 * A developer API key: a long-lived auth token on this table (extras `{ kind: "api" }`), shown once when it's made. A call acts
 * as `user_id` with their role as it is now, and stops when the key is revoked or they leave. Only the token's hash is kept.
 */
export const api_key = table({
  name: "api_key",
  description: "API keys for the developer API.",
  auth: true,
  schema: {
    name: f.text({ required: true }),
    /** The key's last characters, to tell keys apart in the list. */
    prefix: f.text({ required: true }),
    key_hash: f.text({ required: true }),
    user_id: f.tableRef(user, { required: true }),
    last_used_at: f.timestamp({ nullable: true }),
    revoked_at: f.timestamp({ nullable: true }),
  },
  index: [{ type: "btree|unique", fields: [{ name: "key_hash", op: "asc" }] }],
});

/** One call made with a key: appended on every call, so the key list can say when each was last used without a read writing. */
export const api_key_use = table({
  name: "api_key_use",
  description: "When each API key was used.",
  schema: {
    key_id: f.tableRef(api_key, { required: true }),
    route: f.text(),
  },
  index: [{ type: "btree", fields: [{ name: "key_id", op: "asc" }, { name: "created_at", op: "desc" }] }],
});
