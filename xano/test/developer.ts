// The developer surface: an API key acts as its maker only while it's live and they're still here, a webhook event goes once to
// each endpoint that wants it, and a delivery that keeps failing is retried with backoff and then given up on.
import { c, cmp, col, obj, ref, s } from "@xano/sdk";
import { user } from "../table/user.js";
import { api_key, api_key_use } from "../table/developer/api_key.js";
import { webhook_delivery, webhook_endpoint } from "../table/developer/webhook.js";
import { createKeyFn, resolveKeyFn, revokeKeyFn } from "../function/developer/keys.js";
import { deliverOneFn, enqueueWebhookFn, MOST_TRIES } from "../function/developer/webhooks.js";
import { draft, person, workflowTest } from "./fixtures.js";

export const developerTests = [
  workflowTest({
    name: "developer: an API key acts as its maker, and stops when revoked",
    description: "A new key resolves to the admin who made it; once revoked it's refused.",
    stack: [
      person("dev", "admin"),
      s.function.call({ fn: createKeyFn, as: "made", input: { actor_id: ref("dev.id"), name: c.text("CRM sync") } }),
      s.function.call({ fn: resolveKeyFn, as: "who", input: { key_id: ref("made.id") } }),
      s.expect.to_equal({ expr: ref("who"), value: ref("dev.id") }),
      s.db.get({ table: api_key, fieldValue: ref("made.id"), as: "row" }),
      s.expect.to_not_equal({ expr: ref("row.key_hash", { safe: true }), value: ref("made.key") }),
      s.db.query({ table: api_key_use, where: cmp(col("key_id"), "=", ref("made.id")), returnType: "count", as: "uses" }),
      s.expect.to_equal({ expr: ref("uses"), value: c.int(1) }),
      s.function.call({ fn: revokeKeyFn, as: "revoked", input: { actor_id: ref("dev.id"), key_id: ref("made.id") } }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: api_key, where: cmp(col("prefix"), "!=", c.text("")), sort: [{ sortBy: "id", dir: "desc" }], returnType: "single", as: "k" }),
          s.function.call({ fn: resolveKeyFn, as: "after", input: { key_id: ref("k.id") } }),
        ],
        exception: c.text("isn't valid"),
      }),
    ],
  }),
  workflowTest({
    name: "developer: a removed member's API key is refused on its next call",
    description: "The key worked; after the member is removed, the same key is refused.",
    stack: [
      person("leaver", "admin"),
      s.function.call({ fn: createKeyFn, as: "made", input: { actor_id: ref("leaver.id"), name: c.text("Old script") } }),
      s.function.call({ fn: resolveKeyFn, as: "before", input: { key_id: ref("made.id") } }),
      s.db.patch({ table: user, fieldValue: ref("leaver.id"), data: obj({ status: c.text("removed") }), as: "gone" }),
      s.expect.to_throw({
        body: [
          s.db.query({ table: api_key, where: cmp(col("prefix"), "!=", c.text("")), sort: [{ sortBy: "id", dir: "desc" }], returnType: "single", as: "k" }),
          s.function.call({ fn: resolveKeyFn, as: "after", input: { key_id: ref("k.id") } }),
        ],
        exception: c.text("isn't valid"),
      }),
    ],
  }),
  workflowTest({
    name: "developer: a webhook event goes once to each endpoint that wants it",
    description: "Two endpoints, one subscribed: one delivery; the same event again adds nothing; other events add nothing.",
    stack: [
      person("sender"),
      draft("env", "sender", "Hooked"),
      s.db.add({ table: webhook_endpoint, as: "wants", row: { url: c.text("http://127.0.0.1:9/hook"), secret: c.text("whsec_test"), events: c.array(["recipient.signed"]), enabled: c.bool(true) } }),
      s.db.add({ table: webhook_endpoint, as: "other", row: { url: c.text("http://127.0.0.1:9/other"), secret: c.text("whsec_other"), events: c.array(["envelope.voided"]), enabled: c.bool(true) } }),
      s.function.call({ fn: enqueueWebhookFn, as: "first", input: { envelope_id: ref("env.id"), kind: c.text("recipient.signed"), seq: c.int(7) } }),
      s.function.call({ fn: enqueueWebhookFn, as: "again", input: { envelope_id: ref("env.id"), kind: c.text("recipient.signed"), seq: c.int(7) } }),
      s.function.call({ fn: enqueueWebhookFn, as: "unwanted", input: { envelope_id: ref("env.id"), kind: c.text("recipient.consented"), seq: c.int(8) } }),
      s.db.query({ table: webhook_delivery, where: cmp(col("endpoint_id"), "=", ref("wants.id")), returnType: "count", as: "to_wants" }),
      s.expect.to_equal({ expr: ref("to_wants"), value: c.int(1) }),
      s.db.query({ table: webhook_delivery, where: cmp(col("endpoint_id"), "=", ref("other.id")), returnType: "count", as: "to_other" }),
      s.expect.to_equal({ expr: ref("to_other"), value: c.int(0) }),
      s.db.query({ table: webhook_delivery, where: cmp(col("endpoint_id"), "=", ref("wants.id")), returnType: "single", as: "d" }),
      s.expect.to_equal({ expr: ref("d.payload.event"), value: c.text("recipient.signed") }),
      s.expect.to_equal({ expr: ref("d.payload.data.envelope.id"), value: ref("env.id") }),
    ],
  }),
  workflowTest({
    name: "developer: a failing delivery is retried later, and given up on after the last try",
    description: "An endpoint that doesn't answer: the first failure schedules a retry; the last one marks the delivery failed.",
    stack: [
      s.db.add({ table: webhook_endpoint, as: "dead", row: { url: c.text("http://127.0.0.1:9/hook"), secret: c.text("whsec_test"), events: c.array(["envelope.sent"]), enabled: c.bool(true) } }),
      s.db.add({ table: webhook_delivery, as: "d1", row: { endpoint_id: ref("dead.id"), event: c.text("envelope.sent"), event_id: c.text("evt_t_1"), payload: obj({ id: c.text("evt_t_1") }), status: c.text("pending"), attempts: c.int(0), next_attempt_at: c.int(0) } }),
      s.function.call({ fn: deliverOneFn, as: "r1", input: { delivery_id: ref("d1.id") } }),
      s.db.get({ table: webhook_delivery, fieldValue: ref("d1.id"), as: "after1" }),
      s.expect.to_equal({ expr: ref("after1.status"), value: c.text("pending") }),
      s.expect.to_equal({ expr: ref("after1.attempts"), value: c.int(1) }),
      s.expect.to_not_equal({ expr: ref("after1.next_attempt_at"), value: c.null() }),
      s.db.add({ table: webhook_delivery, as: "d5", row: { endpoint_id: ref("dead.id"), event: c.text("envelope.sent"), event_id: c.text("evt_t_5"), payload: obj({ id: c.text("evt_t_5") }), status: c.text("pending"), attempts: c.int(MOST_TRIES - 1), next_attempt_at: c.int(0) } }),
      s.function.call({ fn: deliverOneFn, as: "r5", input: { delivery_id: ref("d5.id") } }),
      s.db.get({ table: webhook_delivery, fieldValue: ref("d5.id"), as: "after5" }),
      s.expect.to_equal({ expr: ref("after5.status"), value: c.text("failed") }),
    ],
  }),
];
