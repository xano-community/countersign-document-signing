import { f, table } from "@xano/sdk";
import { SEED_ENVELOPES } from "../../world.js";
import { user } from "../user.js";

/** Where an envelope is in its life. `sealing` shows as "Finishing": the last person has signed and the final PDF is being made. */
export const ENVELOPE_STATUSES = ["draft", "in_progress", "sealing", "completed", "declined", "voided", "expired"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

/**
 * A document sent for signature, with everyone on it. A template is an envelope with `is_template` set, whose recipients
 * are roles ("Client") rather than people. `public_id` is the random id printed on the signed PDF and typed into the verify
 * page: it is never the row id, so ids can't be walked.
 */
export const envelope = table({
  name: "envelope",
  description: "A document sent for signature, or a template to send one from.",
  schema: {
    public_id: f.text({ required: true }),
    title: f.text({ required: true }),
    status: f.enum(ENVELOPE_STATUSES, { default: "draft" }),
    sender_id: f.tableRef(user, { required: true }),
    /** `private`: the sender and admins. `team`: everyone who reads the team's envelopes. */
    visibility: f.enum(["private", "team"], { default: "private" }),
    signing_order: f.enum(["parallel", "ordered"], { default: "parallel" }),
    subject: f.text(),
    message: f.text(),
    expires_at: f.timestamp({ nullable: true }),
    expiry_days: f.int({ default: 30 }),
    /** Days between reminders; 0 means none. */
    reminder_days: f.int({ default: 3 }),
    /** The document every field sits on: the stored original, its size, fingerprint and pages ({ w, h, rotation } in points). */
    original_file_id: f.int(),
    original_sha256: f.text(),
    page_count: f.int(),
    pages: f.json(),
    /** What the sender's browser said about each source file it combined (name, sha256, pages), recorded as reported. */
    sources: f.json(),
    final_file_id: f.int(),
    final_sha256: f.text(),
    /** The audit chain's last hash when the envelope completed: printed on the certificate and in every completion email. */
    chain_head: f.text(),
    seal_attempts: f.int(),
    seal_failed: f.bool(),
    seal_error: f.text(),
    seal_next_at: f.timestamp({ nullable: true }),
    /** The one-time secret the seal's lambda uses to read and write the document's bytes, stored hashed. */
    seal_key_hash: f.text({ nullable: true }),
    sent_at: f.timestamp({ nullable: true }),
    completed_at: f.timestamp({ nullable: true }),
    ended_at: f.timestamp({ nullable: true }),
    end_reason: f.text(),
    last_reminder_at: f.timestamp({ nullable: true }),
    is_template: f.bool(),
    template_id: f.int(),
    bulk_send_id: f.int(),
    /** What made this envelope, when something did it on someone's behalf ("bulk:12", "public:40"): a retry finds it instead of making another. */
    origin_key: f.text(),
    is_demo: f.bool(),
    updated_at: f.timestamp({ nullable: true }),
  },
  seed: SEED_ENVELOPES,
  index: [
    { type: "btree|unique", fields: [{ name: "public_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "sender_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "status", op: "asc" }] },
    { type: "btree", fields: [{ name: "final_sha256", op: "asc" }] },
    { type: "btree", fields: [{ name: "origin_key", op: "asc" }] },
  ],
});
