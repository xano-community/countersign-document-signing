// Webhooks: signed events sent to a developer's own server when an envelope moves. Every event on an audit trail passes through
// `webhook/enqueue`, which writes one delivery per endpoint that wants it; the sweep sends them, retrying with backoff.
// Each delivery is signed `X-Countersign-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the endpoint's
// secret>`, and the body is sent exactly as it was signed.
import { and, c, caught, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { WEBHOOK_EVENTS, webhook_delivery, webhook_endpoint } from "../../table/developer/webhook.js";
import { loadActor } from "../envelope/draft.js";

/** Tries per delivery, and the wait after each failed one: a minute, 5 minutes, 30 minutes, 2 hours, then give up. */
export const MOST_TRIES = 5;
const BACKOFF_SECS = [60, 300, 1800, 7200, 21600];
const BATCH = 20;
const URL_RULE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

/** One event, to every endpoint that asked for it. Called by audit/append for every event; most aren't webhook events. */
export const enqueueWebhookFn = defineFunction({
  name: "webhook/enqueue",
  description: "Queue a webhook delivery of one envelope event for each endpoint that wants it.",
  input: { envelope_id: input.int({ required: true }), kind: input.text({ required: true }), seq: input.int(), at: input.int(), data: input.json() },
  stack: [
    s.conditional({ when: expr(withFilters(c.array([...WEBHOOK_EVENTS]), fl.in(inp("kind"))), "=", c.bool(false)), then: [s.return(obj({ queued: c.int(0) }))] }),
    s.db.query({ table: webhook_endpoint, where: cmp(col("enabled"), "=", c.bool(true)), output: ["id", "events"], as: "endpoints" }),
    s.conditional({ when: expr(withFilters(ref("endpoints"), fl.count()), "=", c.int(0)), then: [s.return(obj({ queued: c.int(0) }))] }),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "public_id", "title", "status", "sender_id", "sent_at", "completed_at", "is_demo"], as: "wh_env" }),
    s.conditional({ when: expr(ref("wh_env.is_demo", { safe: true }), "=", c.bool(true)), then: [s.return(obj({ queued: c.int(0) }))] }),
    s.set_var("wh_rid", withFilters(inp("data"), fl.get("recipient_id"), fl.first_notempty(c.int(0)), fl.to_int())),
    s.set_var("wh_person", c.null()),
    s.conditional({ when: expr(ref("wh_rid"), ">", c.int(0)), then: [
      s.db.get({ table: recipient, fieldValue: ref("wh_rid"), output: ["id", "name", "email", "role", "role_name", "status"], as: "wh_rcp" }),
      s.update_var("wh_person", ref("wh_rcp")),
    ] }),
    s.set_var("event_id", withFilters(c.text("evt_"), fl.concat(inp("envelope_id")), fl.concat(c.text("_")), fl.concat(withFilters(inp("seq"), fl.first_notempty(c.int(0)))))),
    s.set_var("now_ms", c.now()),
    s.set_var("payload", obj({
      id: ref("event_id"), event: inp("kind"), created_at: withFilters(inp("at"), fl.first_notempty(ref("now_ms"))),
      data: obj({ envelope: withFilters(ref("wh_env"), fl.unset("is_demo"), fl.unset("sender_id")), recipient: ref("wh_person"), reason: withFilters(inp("data"), fl.get("reason"), fl.first_notnull(c.text(""))) }),
    })),
    s.set_var("queued", c.int(0)),
    s.foreach({ list: ref("endpoints"), as: "ep", body: [
      s.set_var("wants", withFilters(ref("ep.events"), fl.first_notnull(c.array([])))),
      s.db.query({ table: webhook_delivery, where: [cmp(col("endpoint_id"), "=", ref("ep.id")), cmp(col("event_id"), "=", ref("event_id"))], returnType: "count", as: "already" }),
      s.conditional({ when: and(expr(withFilters(ref("wants"), fl.in(inp("kind"))), "=", c.bool(true)), expr(ref("already"), "=", c.int(0))), then: [
        s.try_catch({
          try: [
            s.db.add({ table: webhook_delivery, row: {
              endpoint_id: ref("ep.id"), event: inp("kind"), event_id: ref("event_id"), payload: ref("payload"), status: c.text("pending"),
              attempts: c.int(0), next_attempt_at: ref("now_ms"), response_code: c.int(0), response_excerpt: c.text(""),
            }, as: "delivery" }),
            s.update_var("queued", withFilters(ref("queued"), fl.add(c.int(1)))),
          ],
          // Already queued for this endpoint: an event is delivered once.
          catch: [],
        }),
      ] }),
    ] }),
  ],
  response: obj({ queued: ref("queued") }),
  responseShape: {} as { queued: number },
});

/** Send one delivery now. Signs the exact body it sends. Answers the new status. */
export const deliverOneFn = defineFunction({
  name: "webhook/deliver",
  description: "Send one webhook delivery, signed, and record the result; schedule a retry if it failed.",
  input: { delivery_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: webhook_delivery, fieldValue: inp("delivery_id"), as: "d" }),
    guard.found("d", { errorType: "notfound", message: "That delivery doesn't exist." }),
    s.db.get({ table: webhook_endpoint, fieldValue: ref("d.endpoint_id"), as: "ep" }),
    s.set_var("now_ms", c.now()),
    s.conditional({ when: expr(ref("ep.enabled", { safe: true }), "!=", c.bool(true)), then: [
      s.db.patch({ table: webhook_delivery, fieldValue: ref("d.id"), data: obj({ status: c.text("failed"), response_excerpt: c.text("The endpoint is turned off or deleted.") }), as: "off" }),
      s.return(obj({ status: c.text("failed") })),
    ] }),
    s.set_var("body", withFilters(ref("d.payload"), fl.json_encode())),
    s.set_var("ts", withFilters(ref("now_ms"), fl.ms_to_secs(), fl.floor(), fl.to_int(), fl.to_text())),
    s.set_var("signed", withFilters(ref("ts"), fl.concat(c.text(".")), fl.concat(ref("body")))),
    s.set_var("sig", withFilters(ref("signed"), fl.hmac_sha256(ref("ep.secret")))),
    s.set_var("header", withFilters(c.text("t="), fl.concat(ref("ts")), fl.concat(c.text(",v1=")), fl.concat(ref("sig")))),
    s.set_var("code", c.int(0)),
    s.set_var("excerpt", c.text("")),
    s.try_catch({
      try: [
        s.api.request({ url: ref("ep.url"), method: "POST", params: ref("body"), headers: {
          "Content-Type": c.text("application/json"), "X-Countersign-Signature": ref("header"), "X-Countersign-Event": ref("d.event"), "User-Agent": c.text("Countersign-Webhooks/1"),
        }, timeout: c.int(10), as: "sent" }),
        s.update_var("code", withFilters(ref("sent.response.status"), fl.first_notempty(c.int(0)), fl.to_int())),
        s.update_var("excerpt", withFilters(ref("sent.response.result"), fl.json_encode(), fl.substr(c.int(0), c.int(300)))),
      ],
      catch: [s.update_var("excerpt", withFilters(caught("message"), fl.first_notempty(c.text("The endpoint didn't answer.")), fl.substr(c.int(0), c.int(300))))],
    }),
    s.set_var("tries", withFilters(ref("d.attempts"), fl.first_notempty(c.int(0)), fl.add(c.int(1)))),
    s.set_var("ok", c.expression("$var.code >= 200 && $var.code < 300")),
    s.set_var("final_status", c.text("delivered")),
    s.conditional({ when: expr(ref("ok"), "=", c.bool(true)), then: [
      s.db.patch({ table: webhook_delivery, fieldValue: ref("d.id"), data: obj({ status: c.text("delivered"), attempts: ref("tries"), response_code: ref("code"), response_excerpt: ref("excerpt"), delivered_at: ref("now_ms"), next_attempt_at: c.null() }), as: "done" }),
    ], else: [
      s.set_var("next_status", c.text("pending")),
      s.set_var("wait_s", withFilters(c.array(BACKOFF_SECS), fl.get(withFilters(ref("tries"), fl.sub(c.int(1)), fl.to_int())), fl.first_notempty(c.int(BACKOFF_SECS[BACKOFF_SECS.length - 1])))),
      s.set_var("next_at", withFilters(ref("wait_s"), fl.mul(c.int(1000)), fl.add(ref("now_ms")))),
      s.conditional({ when: expr(ref("tries"), ">=", c.int(MOST_TRIES)), then: [s.update_var("next_status", c.text("failed")), s.update_var("next_at", c.null())] }),
      s.update_var("final_status", ref("next_status")),
      s.db.patch({ table: webhook_delivery, fieldValue: ref("d.id"), data: obj({ status: ref("next_status"), attempts: ref("tries"), response_code: ref("code"), response_excerpt: ref("excerpt"), next_attempt_at: ref("next_at") }), as: "retry" }),
    ] }),
    changed({ entity: "webhook", id: ref("d.endpoint_id"), actor: c.int(0) }),
  ],
  response: obj({ status: ref("final_status"), code: ref("code") }),
  responseShape: {} as { status: string; code?: number },
});

/** The sweep's step: send every delivery that's due, a batch at a time. */
export const deliverDueFn = defineFunction({
  name: "webhook/deliver_due",
  description: "Send the webhook deliveries that are due.",
  stack: [
    s.set_var("now_ms", c.now()),
    s.db.query({ table: webhook_delivery, where: [cmp(col("status"), "=", c.text("pending")), cmp(col("next_attempt_at"), "<=", ref("now_ms"))], sort: [{ sortBy: "id", dir: "asc" }], paging: { per_page: c.int(BATCH), metadata: false }, output: ["id"], as: "due" }),
    s.foreach({ list: ref("due"), as: "one", body: [
      s.try_catch({ try: [s.function.run({ fn: deliverOneFn, as: "sent_one", input: { delivery_id: ref("one.id") } })], catch: [] }),
    ] }),
  ],
  response: obj({ sent: withFilters(ref("due"), fl.count()) }),
});

// ── Managing endpoints (people with developer.manage) ─────────────────────────────────────────────────────────────────────

const manage = [...loadActor(), rbac.allows(ref("actor.role"), "developer.manage", "Your role can't manage webhooks.")];

/** Add an endpoint. Answers its signing secret, once. */
export const addEndpointFn = defineFunction({
  name: "webhook/add",
  description: "Add a webhook endpoint for some events. Its signing secret is shown once.",
  input: { actor_id: input.int({ required: true }), url: input.text({ methods: ["trim"] }), events: input.json(), description: input.text({ methods: ["trim"] }) },
  stack: [
    ...manage,
    guard.require(expr(withFilters(c.regex(URL_RULE), fl.regex_test(withFilters(inp("url"), fl.first_notnull(c.text(""))))), "=", c.bool(true)), { errorType: "badrequest", message: "Enter the full address, starting https://." }),
    guard.require(expr(withFilters(inp("url"), fl.strlen()), "<=", c.int(500)), { errorType: "badrequest", message: "That address is too long." }),
    s.set_var("chosen", c.array([])),
    s.foreach({ list: withFilters(inp("events"), fl.first_notnull(c.array([]))), as: "ev", body: [
      s.conditional({ when: expr(withFilters(c.array([...WEBHOOK_EVENTS]), fl.in(ref("ev"))), "=", c.bool(true)), then: [s.update_var("chosen", withFilters(ref("chosen"), fl.array_push(ref("ev"))))] }),
    ] }),
    guard.require(expr(withFilters(ref("chosen"), fl.count()), ">", c.int(0)), { errorType: "badrequest", message: "Choose at least one event to send." }),
    s.db.query({ table: webhook_endpoint, returnType: "count", as: "how_many" }),
    guard.require(expr(ref("how_many"), "<", c.int(20)), { errorType: "badrequest", message: "You can have up to 20 webhook endpoints." }),
    s.security.random_bytes({ length: c.int(24), as: "raw_secret" }),
    s.set_var("secret", withFilters(c.text("whsec_"), fl.concat(withFilters(ref("raw_secret"), fl.bin2hex())))),
    s.db.add({ table: webhook_endpoint, row: { url: inp("url"), secret: ref("secret"), events: withFilters(ref("chosen"), fl.unique()), enabled: c.bool(true), created_by: ref("actor.id"), description: withFilters(inp("description"), fl.first_notnull(c.text(""))) }, as: "made" }),
    changed({ entity: "webhook", id: ref("made.id"), op: "created", actor: inp("actor_id") }),
  ],
  response: obj({ id: ref("made.id"), secret: ref("secret") }),
});

/** Every endpoint, without secrets, with its recent deliveries. */
export const listEndpointsFn = defineFunction({
  name: "webhook/list",
  description: "Webhook endpoints and their last 20 deliveries each.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...manage,
    s.db.query({ table: webhook_endpoint, sort: [{ sortBy: "id", dir: "asc" }], output: ["id", "url", "events", "enabled", "description", "created_at"], as: "eps" }),
    s.set_var("items", c.array([])),
    s.foreach({ list: ref("eps"), as: "ep", body: [
      s.db.query({ table: webhook_delivery, where: cmp(col("endpoint_id"), "=", ref("ep.id")), sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: c.int(20), metadata: false },
        output: ["id", "event", "event_id", "status", "attempts", "response_code", "response_excerpt", "created_at", "delivered_at", "next_attempt_at"], as: "recent" }),
      s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("ep"), fl.set("deliveries", ref("recent")))))),
    ] }),
  ],
  response: obj({ items: ref("items"), events: c.array([...WEBHOOK_EVENTS]) }),
});

/** Turn an endpoint on or off, or delete it with its deliveries. */
export const updateEndpointFn = defineFunction({
  name: "webhook/update",
  description: "Turn a webhook endpoint on or off, or delete it.",
  input: { actor_id: input.int({ required: true }), endpoint_id: input.int({ required: true }), enabled: input.bool(), remove: input.bool() },
  stack: [
    ...manage,
    s.db.get({ table: webhook_endpoint, fieldValue: inp("endpoint_id"), output: ["id"], as: "ep" }),
    guard.found("ep", { errorType: "notfound", message: "That endpoint doesn't exist." }),
    s.conditional({ when: expr(inp("remove"), "=", c.bool(true)), then: [
      s.db.bulk.delete({ table: webhook_delivery, where: cmp(col("endpoint_id"), "=", ref("ep.id")), as: "gone_deliveries" }),
      s.db.del({ table: webhook_endpoint, fieldValue: ref("ep.id") }),
    ], else: [
      s.db.patch({ table: webhook_endpoint, fieldValue: ref("ep.id"), data: obj({ enabled: withFilters(inp("enabled"), fl.first_notnull(c.bool(true))) }), as: "saved" }),
    ] }),
    changed({ entity: "webhook", id: ref("ep.id"), actor: inp("actor_id") }),
  ],
  response: obj({ ok: c.bool(true) }),
});

/** Send a delivery again now, whatever happened before: "Resend" in the delivery log. */
export const redeliverFn = defineFunction({
  name: "webhook/redeliver",
  description: "Send a webhook delivery again now.",
  input: { actor_id: input.int({ required: true }), delivery_id: input.int({ required: true }) },
  stack: [
    ...manage,
    s.db.get({ table: webhook_delivery, fieldValue: inp("delivery_id"), output: ["id"], as: "d" }),
    guard.found("d", { errorType: "notfound", message: "That delivery doesn't exist." }),
    s.set_var("now_ms", c.now()),
    s.db.patch({ table: webhook_delivery, fieldValue: ref("d.id"), data: obj({ status: c.text("pending"), attempts: c.int(0), next_attempt_at: ref("now_ms") }), as: "reset" }),
    s.function.run({ fn: deliverOneFn, as: "result", input: { delivery_id: ref("d.id") } }),
  ],
  response: ref("result"),
});

/** Send a test event to an endpoint now, so a developer can check their receiver. */
export const pingEndpointFn = defineFunction({
  name: "webhook/ping",
  description: "Send a signed test event to a webhook endpoint now.",
  input: { actor_id: input.int({ required: true }), endpoint_id: input.int({ required: true }) },
  stack: [
    ...manage,
    s.db.get({ table: webhook_endpoint, fieldValue: inp("endpoint_id"), output: ["id"], as: "ep" }),
    guard.found("ep", { errorType: "notfound", message: "That endpoint doesn't exist." }),
    s.set_var("now_ms", c.now()),
    s.set_var("ping_id", withFilters(c.text("evt_ping_"), fl.concat(ref("now_ms")))),
    s.db.add({ table: webhook_delivery, row: {
      endpoint_id: ref("ep.id"), event: c.text("ping"), event_id: ref("ping_id"), payload: obj({ id: ref("ping_id"), event: c.text("ping"), created_at: ref("now_ms"), data: obj({ message: c.text("A test event from Countersign.") }) }),
      status: c.text("pending"), attempts: c.int(MOST_TRIES - 1), next_attempt_at: ref("now_ms"), response_code: c.int(0), response_excerpt: c.text(""),
    }, as: "ping" }),
    s.function.run({ fn: deliverOneFn, as: "result", input: { delivery_id: ref("ping.id") } }),
  ],
  response: ref("result"),
});

export const webhookFunctions = [enqueueWebhookFn, deliverOneFn, deliverDueFn, addEndpointFn, listEndpointsFn, updateEndpointFn, redeliverFn, pingEndpointFn];
