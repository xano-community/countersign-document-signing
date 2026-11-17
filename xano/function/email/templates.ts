// What each email says. Copy is plain text: the layout escapes it and writes the markup. Each kind reads the records it needs
// at send time, so an email says what's true when it goes out, not when it was queued.
import { c, defineFunction, expr, fl, inp, input, ref, s, withFilters, type Value } from "@xano/sdk";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { user } from "../../table/user.js";
import { layoutFn } from "./layout.js";
import { OTP_MINUTES } from "../signing/links.js";

/** Mail to a person on an envelope. Keyed `r:{recipient}:{kind}:{round}` (a reminder adds its number). */
export const RECIPIENT_KINDS = ["invite", "reminder", "completed", "declined", "voided", "expired"] as const;
/** Mail to a team member. Keyed `u:{user}:{kind}:{source id}`. */
export const MEMBER_KINDS = ["notice_declined", "notice_completed", "notice_bounced", "notice_seal_failed", "test"] as const;
/** Every kind of email. A one-time code is keyed `otp:{otp_code id}`. */
export const EMAIL_KINDS = [...RECIPIENT_KINDS, "otp", ...MEMBER_KINDS] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];
/** Kinds whose email carries a link, so the app's address must be known before they send. */
export const LINKED_KINDS = ["invite", "reminder", "completed", "notice_declined", "notice_completed", "notice_bounced", "notice_seal_failed"] as const;

/** Text joined at run time. Each part is a literal or a bound value (no filter chains: bind those first). */
const cat = (...parts: (string | Value)[]) =>
  parts.reduce<Value>((acc, p) => withFilters(acc, fl.concat(typeof p === "string" ? c.text(p) : p)), c.text(""));
const put = (fields: Partial<Record<"subject" | "preheader" | "heading" | "intro" | "quote" | "quote_label" | "detail_label" | "detail_value" | "button" | "after" | "footer", Value | string>>) =>
  Object.entries(fields).map(([k, v]) => s.update_var(k, typeof v === "string" ? c.text(v) : v));
const kind = (name: string, body: ReturnType<typeof put>) => ({ when: c.text(name), body, break: true as const });

const title = ref("t_title");
const quoted = ref("t_quoted");
const sender = ref("t_sender");
const org = ref("t_org");
const doc = (lead: string, tail = "") => cat(lead, quoted, tail);

export const renderFn = defineFunction({
  name: "email/render",
  description: "Build one email's subject and HTML from its kind and the records it's about.",
  input: {
    kind: input.text({ required: true }), recipient_id: input.int(), envelope_id: input.int(), user_id: input.int(),
    to: input.text(), params: input.json(),
    /** Built by the sender at send time: a signing, download or app link, and a one-time code. */
    url: input.text(), code: input.text(),
  },
  stack: [
    s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["org_name", "logo_data_url", "accent"], returnType: "single", as: "t_org_row" }),
    s.set_var("t_org", withFilters(ref("t_org_row.org_name", { safe: true }), fl.first_notempty(c.text("Countersign")))),
    s.set_var("t_env_id", withFilters(inp("envelope_id"), fl.first_notempty(c.int(0)))),
    s.db.get({ table: envelope, fieldValue: ref("t_env_id"), output: ["id", "title", "sender_id", "message", "expires_at", "end_reason", "chain_head", "seal_error"], as: "t_env" }),
    s.set_var("t_title", withFilters(ref("t_env.title", { safe: true }), fl.first_notempty(c.text("your document")))),
    s.set_var("t_quoted", cat("“", title, "”")),
    s.set_var("t_sender_id", withFilters(ref("t_env.sender_id", { safe: true }), fl.first_notempty(c.int(0)))),
    s.db.get({ table: user, fieldValue: ref("t_sender_id"), output: ["name", "email"], as: "t_sender_row" }),
    s.set_var("t_sender", withFilters(ref("t_sender_row.name", { safe: true }), fl.first_notempty(org))),
    s.set_var("t_rcp_id", withFilters(inp("recipient_id"), fl.first_notempty(c.int(0)))),
    s.db.get({ table: recipient, fieldValue: ref("t_rcp_id"), output: ["name", "email", "role"], as: "t_rcp" }),
    s.set_var("t_to", withFilters(inp("to"), fl.first_notempty(ref("t_rcp.email", { safe: true })), fl.first_notnull(c.text("")))),
    s.set_var("t_role", withFilters(ref("t_rcp.role", { safe: true }), fl.first_notempty(c.text("signer")))),
    s.set_var("t_reason", withFilters(ref("t_env.end_reason", { safe: true }), fl.first_notnull(c.text("")))),
    s.set_var("t_expires", c.text("")),
    s.conditional({ when: expr(ref("t_env.expires_at", { safe: true }), ">", c.int(0)), then: [
      s.update_var("t_expires", withFilters(ref("t_env.expires_at"), fl.epochms_date(c.text("j F Y"), c.text("UTC")))),
    ] }),
    s.set_var("t_params", withFilters(inp("params"), fl.first_notnull(c.obj({})))),
    s.set_var("t_by", withFilters(ref("t_params"), fl.get(c.text("by_name"), c.text("")), fl.first_notempty(c.text("Someone")))),
    s.set_var("t_address", withFilters(ref("t_params"), fl.get(c.text("address"), c.text("")))),
    // What the person is asked to do, by role.
    s.set_var("t_act", c.text("sign")),
    s.conditional({ when: expr(ref("t_role"), "=", c.text("approver")), then: [s.update_var("t_act", c.text("approve"))] }),
    s.conditional({ when: expr(ref("t_role"), "=", c.text("viewer")), then: [s.update_var("t_act", c.text("review"))] }),
    s.set_var("t_rcp_name", withFilters(ref("t_rcp.name", { safe: true }), fl.first_notnull(c.text("")), fl.trim())),
    s.set_var("t_hi", c.text("")),
    s.conditional({ when: expr(ref("t_rcp_name"), "!=", c.text("")), then: [s.update_var("t_hi", cat("Hi ", ref("t_rcp_name"), ", "))] }),
    s.set_var("t_until", c.text("")),
    s.conditional({ when: expr(ref("t_expires"), "!=", c.text("")), then: [s.update_var("t_until", cat("The link works until ", ref("t_expires"), "."))] }),

    s.set_var("subject", c.text("")), s.set_var("preheader", c.text("")), s.set_var("heading", c.text("")), s.set_var("intro", c.text("")),
    s.set_var("quote", c.text("")), s.set_var("quote_label", c.text("")), s.set_var("detail_label", c.text("")), s.set_var("detail_value", c.text("")),
    s.set_var("button", c.text("")), s.set_var("after", c.text("")), s.set_var("footer", c.text("")),
    s.set_var("why_party", cat("You're getting this because ", sender, " added ", ref("t_to"), " to ", quoted, ". If you weren't expecting it, you can ignore this email.")),
    s.set_var("why_member", cat("You're getting this because you sent ", quoted, " from ", org, ".")),
    s.switch({ on: inp("kind"), cases: [
      kind("invite", put({
        subject: cat(sender, " sent you ", quoted, " to ", ref("t_act")),
        preheader: cat(sender, " needs you to ", ref("t_act"), " this document."),
        heading: title,
        intro: cat(ref("t_hi"), sender, " at ", org, " needs you to ", ref("t_act"), " this document. It takes a few minutes, and you don't need an account."),
        quote: withFilters(ref("t_env.message", { safe: true }), fl.first_notnull(c.text(""))), quote_label: cat("Message from ", sender),
        button: "Review document", after: ref("t_until"), footer: ref("why_party"),
      })),
      kind("reminder", put({
        subject: cat("Reminder: ", quoted, " is waiting for you"),
        preheader: cat(sender, " is still waiting for you to ", ref("t_act"), " this document."),
        heading: title,
        intro: cat(ref("t_hi"), sender, " is still waiting for you to ", ref("t_act"), " this document."),
        button: "Review document", after: ref("t_until"), footer: ref("why_party"),
      })),
      kind("otp", put({
        subject: cat("Your code to sign with ", org),
        preheader: cat("Enter this code to confirm it's you. It works for ", String(OTP_MINUTES), " minutes."),
        heading: "Your signing code",
        intro: cat("Enter this code to confirm it's you. It works for ", String(OTP_MINUTES), " minutes."),
        footer: cat("Someone asked to sign a document as ", ref("t_to"), ". If that wasn't you, ignore this email: without the code, nobody can sign as you."),
      })),
      kind("completed", put({
        subject: cat("Completed: ", quoted),
        preheader: "Everyone has signed. Your copy is ready.",
        heading: cat(title, " is complete"),
        intro: "Everyone has signed. Your copy of the signed document, with its completion certificate, is ready to download.",
        detail_label: "Audit trail fingerprint", detail_value: withFilters(ref("t_env.chain_head", { safe: true }), fl.first_notnull(c.text(""))),
        button: "Download signed PDF",
        after: "Keep this email: the link lets you download your copy again later.",
        footer: cat("You're getting this because you were a party to ", quoted, " from ", org, "."),
      })),
      kind("declined", put({
        subject: cat(quoted, " was declined"),
        heading: cat(title, " was declined"),
        intro: cat(ref("t_by"), " declined it, so this document won't be completed. You don't need to do anything."),
        detail_label: "Their reason", detail_value: ref("t_reason"),
        footer: cat("You're getting this because you were a party to ", quoted, " from ", org, "."),
      })),
      kind("voided", put({
        subject: cat(quoted, " was cancelled"),
        heading: cat(title, " was cancelled"),
        intro: cat(sender, " cancelled this document, so it no longer needs you. Any link you were sent for it has stopped working."),
        detail_label: "Reason", detail_value: ref("t_reason"),
        footer: cat("You're getting this because you were a party to ", quoted, " from ", org, "."),
      })),
      kind("expired", put({
        subject: cat(quoted, " has expired"),
        heading: cat(title, " has expired"),
        intro: cat("This document wasn't completed in time, so it can no longer be signed. If you still need to sign it, ask ", sender, " to send it again."),
        footer: cat("You're getting this because you were a party to ", quoted, " from ", org, "."),
      })),
      kind("notice_declined", put({
        subject: cat(ref("t_by"), " declined ", quoted),
        heading: cat(ref("t_by"), " declined ", quoted),
        intro: "The document has stopped, and everyone else on it has been told. You can send a corrected copy from the document page.",
        detail_label: "Their reason", detail_value: ref("t_reason"),
        button: "Open document", footer: ref("why_member"),
      })),
      kind("notice_completed", put({
        subject: cat("Completed: ", quoted),
        heading: cat(title, " is complete"),
        intro: "Everyone has signed. The signed PDF, its certificate and the audit trail are ready on the document page.",
        button: "Open document", footer: ref("why_member"),
      })),
      kind("notice_bounced", put({
        subject: cat("An email about ", quoted, " bounced"),
        heading: "An email couldn't be delivered",
        intro: cat("The email to ", ref("t_address"), " about ", quoted, " was returned as undeliverable. Check the address and correct it from the document page, and they'll get a fresh invitation."),
        button: "Fix the address", footer: ref("why_member"),
      })),
      kind("notice_seal_failed", put({
        subject: cat(quoted, " couldn't be finished"),
        heading: cat(title, " couldn't be finished"),
        intro: "Everyone has signed, but the signed PDF couldn't be produced after several tries. Nothing is lost: open the document and choose Retry.",
        detail_label: "What went wrong", detail_value: withFilters(ref("t_env.seal_error", { safe: true }), fl.first_notnull(c.text(""))),
        button: "Open document", footer: ref("why_member"),
      })),
      kind("test", put({
        subject: cat("Test email from ", org),
        heading: "Email is working",
        intro: "This is a test email from Countersign. If you can read it, signing invitations, reminders and codes will reach people too.",
        button: "Open Countersign",
        footer: cat("You're getting this because you sent a test email from ", org, "'s email settings."),
      })),
    ] }),
    s.function.run({ fn: layoutFn, as: "html", input: {
      org_name: org, logo: withFilters(ref("t_org_row.logo_data_url", { safe: true }), fl.first_notnull(c.text(""))),
      accent: withFilters(ref("t_org_row.accent", { safe: true }), fl.first_notnull(c.text(""))),
      preheader: ref("preheader"), heading: ref("heading"), intro: ref("intro"), quote: ref("quote"), quote_label: ref("quote_label"),
      code: withFilters(inp("code"), fl.first_notnull(c.text(""))), detail_label: ref("detail_label"), detail_value: ref("detail_value"),
      button_label: ref("button"), url: withFilters(inp("url"), fl.first_notnull(c.text(""))), after: ref("after"), footer: ref("footer"),
    } }),
  ],
  response: { subject: ref("subject"), html: ref("html") },
});
