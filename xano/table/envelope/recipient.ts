import { f, table } from "@xano/sdk";
import { SEED_RECIPIENTS } from "../../world.js";
import { envelope } from "./envelope.js";
import { user } from "../user.js";

export const RECIPIENT_ROLES = ["signer", "approver", "viewer", "cc"] as const;
export const RECIPIENT_STATUSES = ["waiting", "sent", "opened", "completed", "declined"] as const;
export const IDENTITY_CHECKS = ["none", "access_code", "email_code"] as const;

/**
 * One person on an envelope, and the auth table behind a signer's session (tokens carry { kind: "signer", round }).
 * `round` goes up whenever the sender resends or corrects this recipient, so an older session stops working.
 * A template's recipients are roles: `role_name` set, name and email blank.
 */
export const recipient = table({
  name: "recipient",
  description: "A person on an envelope: who they are, what they do, and where they've got to.",
  auth: true,
  schema: {
    envelope_id: f.tableRef(envelope, { required: true }),
    role: f.enum(RECIPIENT_ROLES, { default: "signer" }),
    role_name: f.text(),
    name: f.text(),
    email: f.email({ methods: ["trim", "lower"] }),
    /** Ordered signing: everyone with the same step acts together. */
    step: f.int({ default: 1 }),
    color: f.int(),
    status: f.enum(RECIPIENT_STATUSES, { default: "waiting" }),
    round: f.int({ default: 1 }),
    identity_check: f.enum(IDENTITY_CHECKS, { default: "none" }),
    access_code_hash: f.text({ nullable: true }),
    /** A member of this team, when the recipient is one: their "Action required" opens signing in the app. */
    user_id: f.int(),
    consented_at: f.timestamp({ nullable: true }),
    disclosure_version: f.int(),
    identity_checked_at: f.timestamp({ nullable: true }),
    /** The round the identity check was passed in: a correction or resend asks again. */
    identity_round: f.int(),
    opened_at: f.timestamp({ nullable: true }),
    completed_at: f.timestamp({ nullable: true }),
    declined_at: f.timestamp({ nullable: true }),
    decline_reason: f.text(),
    ip: f.text(),
    user_agent: f.text(),
    hosted_by: f.tableRef(user, { nullable: true }),
    bounced: f.bool(),
    last_reminded_at: f.timestamp({ nullable: true }),
    reminders_sent: f.int(),
    /** The final PDF's download token for this party, stored hashed (made at completion). */
    download_hash: f.text({ nullable: true }),
    is_demo: f.bool(),
  },
  seed: SEED_RECIPIENTS,
  index: [
    { type: "btree", fields: [{ name: "envelope_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "email", op: "asc" }] },
    { type: "btree", fields: [{ name: "user_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "download_hash", op: "asc" }] },
  ],
});
