import { f, table } from "@xano/sdk";

/** A six-digit code sent by email to prove someone holds an address. Only its hash is kept; it lasts 10 minutes and five tries. */
export const otp_code = table({
  name: "otp_code",
  description: "An emailed one-time code, hashed.",
  schema: {
    /** "recipient:12" or "public:<link id>:<email>". */
    subject: f.text({ required: true }),
    email: f.text(),
    code_hash: f.text({ nullable: true }),
    expires_at: f.timestamp({ nullable: true }),
    attempts: f.int(),
    used: f.bool(),
  },
  index: [{ type: "btree", fields: [{ name: "subject", op: "asc" }] }],
});
