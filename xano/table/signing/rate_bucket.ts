import { f, table } from "@xano/sdk";

/** A counter for one key in one time window, for the routes anyone can call. */
export const rate_bucket = table({
  name: "rate_bucket",
  description: "Request counts per key and window, for rate limits on public routes.",
  schema: {
    key: f.text({ required: true }),
    window_start: f.int({ required: true }),
    count: f.int(),
  },
  index: [{ type: "btree|unique", fields: [{ name: "key", op: "asc" }, { name: "window_start", op: "asc" }] }],
});
