import { f, table } from "@xano/sdk";

/**
 * The organisation's signing settings: one row. Branding shows on signing pages, emails and the certificate. A missing row
 * reads as demo mode off and sign-up closed.
 */
export const org_setting = table({
  name: "org_setting",
  description: "Branding, email defaults, signing defaults, retention and demo mode.",
  schema: {
    org_name: f.text({ required: true }),
    /** A small PNG or SVG logo as a data URL, shown on signing pages and emails. */
    logo_data_url: f.text(),
    accent: f.text(),
    email_sender_name: f.text(),
    reply_to: f.text(),
    default_expiry_days: f.int({ default: 30 }),
    default_reminder_days: f.int({ default: 3 }),
    /** Delete ended envelopes this many days after they end. 0 keeps them forever. */
    retention_days: f.int(),
    demo_mode: f.bool(),
    /** The app's own public URL, captured from requests, for links in emails and the seal's loopback. */
    app_url: f.text(),
    api_base_url: f.text(),
    /** When the demo world's history was written (its trails, invites and seals). Empty until the first sweep does it. */
    world_built_at: f.timestamp({ nullable: true }),
  },
  seed: [{ org_name: "Fernhill Property Group", email_sender_name: "Fernhill Property Group", default_expiry_days: 30, default_reminder_days: 3, retention_days: 0, demo_mode: true, accent: "ink" }],
});
