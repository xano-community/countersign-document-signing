// Public links: a template anyone can sign from a link on a website, a QR code or an email footer. The visitor gives their name
// and email, proves the email with a one-time code, and then signs a fresh copy as the template's first role. Nothing is made
// until the email is proven, and the visitor never holds anything but their own signing link.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { recipient } from "../../table/envelope/recipient.js";
import { public_link } from "../../table/envelope/public_link.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { otp_code } from "../../table/signing/otp_code.js";
import { user } from "../../table/user.js";
import { canRead } from "../envelope/access.js";
import { loadActor } from "../envelope/draft.js";
import { sendFn } from "../envelope/send.js";
import { emailStatusFn } from "../email/status.js";
import { enqueueFn } from "../email/outbox.js";
import { mintLinkFn, otpHashOf } from "../signing/links.js";
import { hit } from "../rate/limit.js";
import { instantiateFn, publicProblemsFn } from "./templates.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Codes one address can ask for in an hour, from anywhere. */
const CODES_PER_EMAIL = 3;
/** Requests one address (IP) can make in 10 minutes, across every public link. */
const PER_IP = 20;
const CODE_TRIES = 6;

/** Turn a template's public link on or off. Turning it on needs email working, and a template a stranger can complete. */
export const setPublicLinkFn = defineFunction({
  name: "template/public_link",
  description: "Turn a template's public link on or off. The link's address stays the same.",
  input: { actor_id: input.int({ required: true }), template_id: input.int({ required: true }), enabled: input.bool({ required: true }) },
  stack: [
    ...loadActor(),
    rbac.allows(ref("actor.role"), "template.manage", "Your role can't change templates."),
    s.db.get({ table: envelope, fieldValue: inp("template_id"), output: ["id", "is_template"], as: "tpl" }),
    guard.found("tpl", { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
    guard.require(expr(ref("tpl.is_template"), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
    s.function.run({ fn: canRead, as: "may_read", input: { actor_id: inp("actor_id"), envelope_id: inp("template_id") } }),
    guard.require(expr(ref("may_read"), "=", c.bool(true)), { errorType: "notfound", message: "That template doesn't exist, or you can't see it." }),
    s.conditional({ when: expr(inp("enabled"), "=", c.bool(true)), then: [
      s.function.run({ fn: emailStatusFn, as: "mail", input: { test_key: c.text(""), test_from: c.text(""), test_webhook: c.text("") } }),
      guard.require(expr(ref("mail.can_send"), "=", c.bool(true)), { errorType: "badrequest", message: "Public links email each visitor a code, so connect email in Settings first." }),
      s.function.run({ fn: publicProblemsFn, as: "problems", input: { template_id: inp("template_id") } }),
      guard.require(expr(withFilters(ref("problems"), fl.count()), "=", c.int(0)), { errorType: "badrequest", message: "This template isn't ready for a public link yet." }),
    ] }),
    s.db.get({ table: public_link, fieldName: "template_id", fieldValue: inp("template_id"), as: "link" }),
    s.conditional({ when: expr(ref("link"), "=", c.null()), then: [
      s.security.random_bytes({ length: c.int(12), as: "raw_slug" }),
      s.set_var("slug", withFilters(ref("raw_slug"), fl.bin2hex())),
      s.db.add({ table: public_link, row: { template_id: inp("template_id"), slug: ref("slug"), enabled: inp("enabled"), created_by: ref("actor.id"), uses: c.int(0) }, as: "made" }),
    ], else: [
      s.db.patch({ table: public_link, fieldValue: ref("link.id"), data: obj({ enabled: inp("enabled") }), as: "made" }),
    ] }),
    changed({ entity: "envelope", id: inp("template_id"), actor: inp("actor_id") }),
  ],
  response: obj({ slug: ref("made.slug"), enabled: ref("made.enabled"), uses: ref("made.uses") }),
});

/** Binds `link` and `tpl` for a slug, and `pstate`: "ok", "off" or "not_found". */
const resolvePublic = [
  s.set_var("pstate", c.text("ok")),
  s.db.get({ table: public_link, fieldName: "slug", fieldValue: inp("slug"), as: "link" }),
  s.set_var("tpl", c.null()),
  s.conditional({ when: expr(ref("link"), "=", c.null()), then: [s.update_var("pstate", c.text("not_found"))], else: [
    s.db.get({ table: envelope, fieldValue: ref("link.template_id"), output: ["id", "title", "message", "page_count", "sender_id", "is_template"], as: "found_tpl" }),
    s.update_var("tpl", ref("found_tpl")),
    s.conditional({ when: expr(ref("tpl"), "=", c.null()), then: [s.update_var("pstate", c.text("not_found"))] }),
    s.conditional({ when: expr(ref("link.enabled"), "!=", c.bool(true)), then: [s.update_var("pstate", c.text("off"))] }),
  ] }),
];

/** What the public page shows before anyone gives their email: whose link it is and what's being signed. */
export const publicBriefFn = defineFunction({
  name: "public/brief",
  description: "What a public link's page shows: the organisation, the document's title and pages, and the visitor's role.",
  input: { slug: input.text({ required: true }) },
  stack: [
    ...resolvePublic,
    s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["org_name", "logo_data_url"], returnType: "single", as: "org" }),
    s.conditional({ when: expr(ref("pstate"), "!=", c.text("ok")), then: [
      s.return(obj({ state: ref("pstate"), org_name: ref("org.org_name", { safe: true }), logo: ref("org.logo_data_url", { safe: true }) })),
    ] }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("tpl.id")), sort: [{ sortBy: "step", dir: "asc" }, { sortBy: "color", dir: "asc" }], output: ["role_name"], returnType: "single", as: "first" }),
  ],
  response: obj({
    state: c.text("ok"), title: ref("tpl.title"), message: ref("tpl.message"), page_count: ref("tpl.page_count"),
    role_name: ref("first.role_name", { safe: true }), org_name: ref("org.org_name", { safe: true }), logo: ref("org.logo_data_url", { safe: true }),
  }),
  responseShape: {} as Record<string, unknown>,
});

/** Email a visitor a code. Limited per address (from anywhere) and per IP, so a link can't be used to flood someone's inbox. */
export const publicStartFn = defineFunction({
  name: "public/start",
  description: "Email a public link's visitor a one-time code to prove their address.",
  input: { slug: input.text({ required: true }), name: input.text({ methods: ["trim"] }), email: input.text({ methods: ["trim", "lower"] }), ip: input.text() },
  stack: [
    ...resolvePublic,
    s.conditional({ when: expr(ref("pstate"), "!=", c.text("ok")), then: [s.return(obj({ state: ref("pstate") }))] }),
    guard.found("link", { errorType: "notfound", message: "This link doesn't exist." }),
    s.set_var("v_name", withFilters(inp("name"), fl.first_notnull(c.text("")))),
    s.set_var("v_email", withFilters(inp("email"), fl.first_notnull(c.text("")))),
    guard.require(expr(withFilters(ref("v_name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Enter your name." }),
    guard.require(expr(withFilters(ref("v_name"), fl.strlen()), "<=", c.int(120)), { errorType: "badrequest", message: "Keep your name under 120 characters." }),
    guard.require(expr(withFilters(c.regex(EMAIL), fl.regex_test(ref("v_email"))), "=", c.bool(true)), { errorType: "badrequest", message: "Check your email address." }),
    hit(withFilters(c.text("public-ip:"), fl.concat(withFilters(inp("ip"), fl.first_notnull(c.text(""))))), PER_IP, 600, "by_ip"),
    s.conditional({ when: expr(ref("by_ip.allowed"), "=", c.bool(false)), then: [s.return(obj({ state: c.text("rate_limited"), retry_after: ref("by_ip.retry_after") }))] }),
    hit(withFilters(c.text("public-code:"), fl.concat(ref("v_email"))), CODES_PER_EMAIL, 3600, "by_email"),
    s.conditional({ when: expr(ref("by_email.allowed"), "=", c.bool(false)), then: [s.return(obj({ state: c.text("rate_limited"), retry_after: ref("by_email.retry_after") }))] }),
    s.set_var("subject", withFilters(c.text("public:"), fl.concat(ref("link.id")), fl.concat(c.text(":")), fl.concat(ref("v_email")))),
    s.db.add({ table: otp_code, row: { subject: ref("subject"), email: ref("v_email"), code_hash: c.null(), attempts: c.int(0), used: c.bool(false) }, as: "otp_row" }),
    s.function.run({ fn: enqueueFn, as: "queued", input: { kind: c.text("otp"), otp_id: ref("otp_row.id"), params: obj({ public: c.bool(true) }) } }),
    // Email turned off (or demo mode, for a stranger's address): no code can reach them, so say so instead of waiting.
    s.conditional({ when: expr(ref("queued.status"), "=", c.text("link_only")), then: [s.return(obj({ state: c.text("email_off") }))] }),
  ],
  response: obj({ state: c.text("code_sent"), sent_to: ref("v_email") }),
  responseShape: {} as Record<string, unknown>,
});

/**
 * Check the visitor's code, then make their copy and send it. The visitor signs as the first role, with the identity check
 * already passed (they just proved the address). Answers their signing link. A retry with the same used code answers the
 * same copy, never a second one.
 */
export const publicVerifyFn = defineFunction({
  name: "public/verify",
  description: "Check a public link visitor's code, make their copy of the document, and answer their signing link.",
  input: { slug: input.text({ required: true }), name: input.text({ methods: ["trim"] }), email: input.text({ methods: ["trim", "lower"] }), code: input.text({ methods: ["trim"] }), ip: input.text(), user_agent: input.text() },
  stack: [
    ...resolvePublic,
    s.conditional({ when: expr(ref("pstate"), "!=", c.text("ok")), then: [s.return(obj({ state: ref("pstate") }))] }),
    guard.found("link", { errorType: "notfound", message: "This link doesn't exist." }),
    s.set_var("v_email", withFilters(inp("email"), fl.first_notnull(c.text("")))),
    s.set_var("v_name", withFilters(inp("name"), fl.first_notnull(c.text("")), fl.substr(c.int(0), c.int(120)))),
    hit(withFilters(c.text("public-try:"), fl.concat(ref("link.id")), fl.concat(c.text(":")), fl.concat(ref("v_email"))), CODE_TRIES, 900, "tries"),
    s.conditional({ when: expr(ref("tries.allowed"), "=", c.bool(false)), then: [s.return(obj({ state: c.text("rate_limited"), retry_after: ref("tries.retry_after") }))] }),
    s.set_var("subject", withFilters(c.text("public:"), fl.concat(ref("link.id")), fl.concat(c.text(":")), fl.concat(ref("v_email")))),
    s.db.query({ table: otp_code, where: cmp(col("subject"), "=", ref("subject")), sort: [{ sortBy: "id", dir: "desc" }], returnType: "single", as: "otp" }),
    s.set_var("now_ms", c.now()),
    s.set_var("passed", c.bool(false)),
    s.set_var("otp_id", c.int(0)),
    s.set_var("want", otpHashOf(ref("subject"), withFilters(inp("code"), fl.first_notnull(c.text(""))))),
    s.conditional({ when: expr(ref("otp"), "!=", c.null()), then: [
      s.update_var("otp_id", withFilters(ref("otp"), fl.get("id"))),
      s.set_var("otp_hash", withFilters(ref("otp"), fl.get("code_hash"), fl.first_notnull(c.text("")))),
      s.set_var("otp_exp", withFilters(ref("otp"), fl.get("expires_at"), fl.first_notnull(c.int(0)))),
      s.set_var("otp_tries", withFilters(ref("otp"), fl.get("attempts"), fl.first_notnull(c.int(0)))),
      s.conditional({ when: expr(c.expression("$var.otp_hash != \"\" && $var.otp_hash == $var.want && $var.otp_exp > $var.now_ms && $var.otp_tries < 5"), "=", c.bool(true)), then: [
        s.update_var("passed", c.bool(true)),
      ], else: [
        s.db.increment({ table: otp_code, where: cmp(col("id"), "=", ref("otp_id")), fieldName: "attempts", value: 1, as: "counted" }),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("passed"), "=", c.bool(false)), then: [
      s.return(obj({ state: c.text("wrong_code"), tries_left: withFilters(c.int(CODE_TRIES), fl.sub(ref("tries.count")), fl.to_int()) })),
    ] }),
    s.db.patch({ table: otp_code, fieldValue: ref("otp_id"), data: obj({ used: c.bool(true) }), as: "spent" }),

    // The copy is sent as the template's owner, who must still be on the team.
    s.db.get({ table: user, fieldValue: ref("tpl.sender_id"), output: ["id", "status"], as: "owner" }),
    s.conditional({ when: expr(ref("owner.status", { safe: true }), "!=", c.text("active")), then: [s.return(obj({ state: c.text("unavailable") }))] }),
    s.db.query({ table: recipient, where: cmp(col("envelope_id"), "=", ref("tpl.id")), sort: [{ sortBy: "step", dir: "asc" }, { sortBy: "color", dir: "asc" }], output: ["id"], returnType: "single", as: "first" }),
    s.set_var("first_id", withFilters(ref("first"), fl.get("id"))),
    s.set_var("origin", withFilters(c.text("public:"), fl.concat(ref("otp_id")))),
    s.set_var("visitor_person", obj({ role_id: ref("first_id"), name: ref("v_name"), email: ref("v_email"), identity_check: c.text("none") })),
    s.set_var("people", withFilters(c.array([]), fl.array_push(ref("visitor_person")))),
    s.function.run({ fn: instantiateFn, as: "made", input: { template_id: ref("tpl.id"), sender_id: ref("owner.id"), origin_key: ref("origin"), people: ref("people") } }),
    s.db.get({ table: envelope, fieldValue: ref("made.envelope_id"), output: ["id", "status"], as: "copy" }),
    guard.found("copy", { errorType: "notfound", message: "Your copy couldn't be made. Try again." }),
    s.conditional({ when: expr(ref("copy.status"), "=", c.text("draft")), then: [
      s.function.run({ fn: sendFn, as: "sent", input: { actor_id: ref("owner.id"), envelope_id: ref("copy.id"), ip: inp("ip"), user_agent: inp("user_agent") } }),
      s.db.increment({ table: public_link, where: cmp(col("id"), "=", ref("link.id")), fieldName: "uses", value: 1, as: "used" }),
    ] }),
    s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("copy.id")), cmp(col("email"), "=", ref("v_email"))], sort: [{ sortBy: "step", dir: "asc" }], output: ["id"], returnType: "single", as: "visitor" }),
    s.set_var("visitor_id", withFilters(ref("visitor"), fl.get("id"))),
    s.function.run({ fn: mintLinkFn, as: "minted", input: { recipient_id: ref("visitor_id"), via: c.text("public") } }),
  ],
  response: obj({ state: c.text("ok"), url: ref("minted.url") }),
  responseShape: {} as Record<string, unknown>,
});

export const publicFunctions = [setPublicLinkFn, publicBriefFn, publicStartFn, publicVerifyFn];
