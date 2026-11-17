import { f, table } from "@xano/sdk";

export const OUTBOX_STATUSES = ["queued", "link_only", "sending", "sent", "delivered", "bounced", "complained", "failed", "unknown", "skipped"] as const;

/**
 * Every email the app sends, one row each. A row holds what the email is for (kind and parameters), never a rendered body,
 * a link or a code: the drain makes those at send time. `dedupe_key` is unique, so the same email can't be queued twice.
 */
export const email_outbox = table({
  name: "email_outbox",
  description: "Queued and sent emails, deduplicated, with their delivery state.",
  schema: {
    dedupe_key: f.text({ required: true }),
    kind: f.text({ required: true }),
    envelope_id: f.int(),
    recipient_id: f.int(),
    user_id: f.int(),
    to: f.text({ required: true }),
    params: f.json(),
    status: f.enum(OUTBOX_STATUSES, { default: "queued" }),
    attempts: f.int(),
    next_attempt_at: f.timestamp({ nullable: true }),
    claimed_at: f.timestamp({ nullable: true }),
    sent_at: f.timestamp({ nullable: true }),
    resend_id: f.text(),
    last_error: f.text(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "dedupe_key", op: "asc" }] },
    { type: "btree", fields: [{ name: "status", op: "asc" }] },
    { type: "btree", fields: [{ name: "recipient_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "resend_id", op: "asc" }] },
  ],
});
