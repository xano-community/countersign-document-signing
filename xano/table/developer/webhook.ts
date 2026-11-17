import { f, table } from "@xano/sdk";

export const WEBHOOK_EVENTS = ["envelope.sent", "envelope.completed", "envelope.declined", "envelope.voided", "envelope.expired", "recipient.opened", "recipient.signed", "recipient.declined"] as const;

/** Where to send signed events. The secret signs each delivery and is shown once, when the endpoint is made. */
export const webhook_endpoint = table({
  name: "webhook_endpoint",
  description: "Webhook endpoints for envelope and recipient events.",
  schema: {
    url: f.text({ required: true }),
    secret: f.text({ required: true }),
    events: f.json(),
    enabled: f.bool({ default: true }),
    created_by: f.int(),
    description: f.text(),
  },
});

export const webhook_delivery = table({
  name: "webhook_delivery",
  description: "Each webhook delivery: the payload, and every attempt's result.",
  schema: {
    endpoint_id: f.tableRef(webhook_endpoint, { required: true }),
    event: f.text({ required: true }),
    event_id: f.text({ required: true }),
    payload: f.json(),
    status: f.enum(["pending", "delivered", "failed"], { default: "pending" }),
    attempts: f.int(),
    next_attempt_at: f.timestamp({ nullable: true }),
    response_code: f.int(),
    response_excerpt: f.text(),
    delivered_at: f.timestamp({ nullable: true }),
  },
  index: [
    { type: "btree", fields: [{ name: "status", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "endpoint_id", op: "asc" }, { name: "event_id", op: "asc" }] },
  ],
});
