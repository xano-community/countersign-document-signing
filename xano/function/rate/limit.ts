// Rate limits for the routes anyone can call. A key ("ip:1.2.3.4:open", "code:12") counts requests in a fixed window;
// over the limit, the caller gets a state with how long to wait, never an error page.
import { c, cmp, col, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { rate_bucket } from "../../table/signing/rate_bucket.js";

export const hitFn = defineFunction({
  name: "rate/hit",
  description: "Count one request against a key's window; say whether it's allowed and how long to wait if not.",
  input: { key: input.text({ required: true }), limit: input.int({ required: true }), window_secs: input.int({ required: true }) },
  stack: [
    s.set_var("now_s", withFilters(c.now(), fl.ms_to_secs(), fl.floor())),
    s.set_var("window", withFilters(ref("now_s"), fl.div(inp("window_secs")), fl.floor(), fl.mul(inp("window_secs")), fl.to_int())),
    s.try_catch({
      try: [s.db.add({ table: rate_bucket, row: { key: inp("key"), window_start: ref("window"), count: c.int(0) }, as: "made" })],
      catch: [],
    }),
    s.db.increment({ table: rate_bucket, where: [cmp(col("key"), "=", inp("key")), cmp(col("window_start"), "=", ref("window"))], fieldName: "count", value: 1, output: ["count"], as: "bumped" }),
    s.set_var("count", withFilters(ref("bumped"), fl.first(), fl.get("count"), fl.first_notnull(c.int(1)))),
    s.set_var("wait", withFilters(ref("window"), fl.add(inp("window_secs")), fl.sub(ref("now_s")), fl.to_int())),
  ],
  response: obj({ allowed: withFilters(ref("count"), fl.lte(inp("limit"))), count: ref("count"), retry_after: ref("wait") }),
});

/** In a stack: count a hit and bind `<as>` = { allowed, count, retry_after }. */
export const hit = (key: Value, limit: number, windowSecs: number, as = "rate") =>
  s.function.run({ fn: hitFn, as, input: { key, limit: c.int(limit), window_secs: c.int(windowSecs) } });
