// Preparing and sending drafts over HTTP. Each route is one line around its function in function/envelope/, so the developer
// API and connected AI tools run the same rules.
import { apiGroup, auth, c, fl, inp, input, obj, query, ref, s, sys, withFilters } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { saveFields, saveRecipients, updateDraft } from "../function/envelope/draft.js";
import { prepareView } from "../function/envelope/view.js";
import { copyDownloadFn, copyLinkFn, sendFn, signAsMeFn } from "../function/envelope/send.js";
import { rememberUrls } from "../function/settings/app_url.js";
import { correctFn, extendFn, remindFn, voidFn } from "../function/envelope/manage.js";
import { envelopeDetail, envelopeStats, listEnvelopes } from "../function/envelope/list.js";
import { hostFn } from "../function/envelope/host.js";
import { buildWorldFn } from "../function/demo/world.js";
import { sealDue } from "../function/seal/build.js";

export const envelopesGroup = apiGroup({ name: "envelopes", canonical: "envelopes", middleware: { pre: [gateActive] }, description: "Preparing and sending documents." });

const id = () => input.int({ required: true });
const ua = () => s.set_var("user_agent", withFilters(sys.httpHeaders(), fl.get("User-Agent", "")));

export const prepareRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/prepare", verb: "GET",
  description: "A draft as the prepare screen shows it: its people, fields, and what blocks sending.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: prepareView, as: "view", input: { actor_id: auth("id"), envelope_id: inp("id") } })],
  response: ref("view"),
});

export const updateDraftRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}", verb: "PATCH",
  description: "Change a draft's title, message, deadline, reminders, visibility or signing order.",
  input: {
    id: id(), title: input.text({ methods: ["trim"] }), subject: input.text({ methods: ["trim"] }), message: input.text(),
    expiry_days: input.int(), reminder_days: input.int(), visibility: input.text(), signing_order: input.text(),
  },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: updateDraft, as: "saved", input: {
      actor_id: auth("id"), envelope_id: inp("id"), title: inp("title"), subject: inp("subject"), message: inp("message"),
      expiry_days: inp("expiry_days"), reminder_days: inp("reminder_days"), visibility: inp("visibility"), signing_order: inp("signing_order"),
    } }),
  ],
  response: ref("saved"),
});

export const saveRecipientsRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/recipients", verb: "PUT",
  description: "Replace a draft's recipients with this list.",
  input: { id: id(), recipients: input.json({ required: true }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: saveRecipients, as: "saved", input: { actor_id: auth("id"), envelope_id: inp("id"), recipients: inp("recipients") } })],
  response: ref("saved"),
});

export const saveFieldsRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/fields", verb: "PUT",
  description: "Replace a draft's fields with this list.",
  input: { id: id(), fields: input.json({ required: true }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: saveFields, as: "saved", input: { actor_id: auth("id"), envelope_id: inp("id"), fields: inp("fields") } })],
  response: ref("saved"),
});

export const sendRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/send", verb: "POST",
  description: "Send a draft. Answers each person's link to share when email isn't set up.",
  input: { id: id(), app_url: input.text() },
  stack: [
    ...rbac.signedIn(),
    ...rememberUrls(inp("app_url")),
    ua(),
    s.function.run({ fn: sendFn, as: "sent", input: { actor_id: auth("id"), envelope_id: inp("id"), ip: sys.remoteIp(), user_agent: ref("user_agent") } }),
  ],
  response: ref("sent"),
});

export const copyLinkRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/recipients/{recipient_id}/link", verb: "POST",
  description: "A new signing link for one recipient, to share by hand. Shown once.",
  input: { id: id(), recipient_id: input.int({ required: true }), app_url: input.text() },
  stack: [...rbac.signedIn(), ...rememberUrls(inp("app_url")), s.function.run({ fn: copyLinkFn, as: "link", input: { actor_id: auth("id"), envelope_id: inp("id"), recipient_id: inp("recipient_id") } })],
  response: ref("link"), history: false,
});

const manage = (fn: Parameters<typeof s.function.run>[0]["fn"], extra: Record<string, ReturnType<typeof inp>> = {}) => [
  ...rbac.signedIn(), ua(),
  s.function.run({ fn, as: "done", input: { actor_id: auth("id"), envelope_id: inp("id"), ip: sys.remoteIp(), user_agent: ref("user_agent"), ...extra } }),
];

export const voidRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/void", verb: "POST",
  description: "Cancel a document that's out for signature.",
  input: { id: id(), reason: input.text({ methods: ["trim"] }) },
  stack: manage(voidFn, { reason: inp("reason") }), response: ref("done"),
});

export const correctRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/recipients/{recipient_id}/correct", verb: "POST",
  description: "Change a recipient's name or email before they've finished, and re-invite them.",
  input: { id: id(), recipient_id: input.int({ required: true }), name: input.text({ methods: ["trim"] }), email: input.text({ methods: ["trim", "lower"] }), app_url: input.text() },
  stack: [...rememberUrls(inp("app_url")), ...manage(correctFn, { recipient_id: inp("recipient_id"), name: inp("name"), email: inp("email") })], response: ref("done"),
});

export const extendRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/extend", verb: "POST",
  description: "Move a document's deadline later.",
  input: { id: id(), days: input.int({ required: true }) },
  stack: manage(extendFn, { days: inp("days") }), response: ref("done"),
});

export const remindRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/recipients/{recipient_id}/remind", verb: "POST",
  description: "Remind someone now, whose turn it is.",
  input: { id: id(), recipient_id: input.int({ required: true }), app_url: input.text() },
  stack: [...rememberUrls(inp("app_url")), ...manage(remindFn, { recipient_id: inp("recipient_id") })], response: ref("done"),
});

export const listRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes", verb: "GET",
  description: "One segment of the Documents list.",
  input: { segment: input.text(), q: input.text({ methods: ["trim"] }), page: input.int() },
  stack: [...rbac.signedIn(), s.function.run({ fn: listEnvelopes, as: "list", input: { actor_id: auth("id"), segment: inp("segment"), q: inp("q"), page: inp("page") } })],
  response: ref("list"),
});

export const statsRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/stats", verb: "GET",
  description: "The numbers at the top of Documents.",
  stack: [...rbac.signedIn(), s.function.run({ fn: envelopeStats, as: "stats", input: { actor_id: auth("id") } })],
  response: ref("stats"),
});

/**
 * The app says hello once a session: the backend learns where the app and its API are served (emails and the seal need both),
 * and, on a fresh deploy with the demo, writes the demo's history and seals its signed documents without waiting for the sweep.
 */
export const helloRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "app/hello", verb: "POST",
  description: "Called once a session by the app: remembers its address, and finishes the demo's setup on a fresh deploy.",
  input: { app_url: input.text() },
  stack: [
    ...rbac.signedIn(),
    ...rememberUrls(inp("app_url")),
    s.util.post_process([s.function.run({ fn: buildWorldFn, as: "world" }), s.function.run({ fn: sealDue, as: "sealed", input: { limit: c.int(5) } })]),
  ],
  response: obj({ ok: c.bool(true) }), history: false,
});

export const detailRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}", verb: "GET",
  description: "One document in full: people, emails, timeline and its audit check.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: envelopeDetail, as: "detail", input: { actor_id: auth("id"), envelope_id: inp("id") } })],
  response: ref("detail"),
});

export const signAsMeRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/sign", verb: "POST",
  description: "Open signing in the app, when it's your turn on this document.",
  input: { id: id(), app_url: input.text() },
  stack: [...rbac.signedIn(), ...rememberUrls(inp("app_url")), s.function.run({ fn: signAsMeFn, as: "link", input: { actor_id: auth("id"), envelope_id: inp("id") } })],
  response: ref("link"), history: false,
});

export const hostRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/recipients/{recipient_id}/host", verb: "POST",
  description: "Start in-person signing for a recipient: a signing link to open on this device and hand over.",
  input: { id: id(), recipient_id: input.int({ required: true }), app_url: input.text() },
  stack: [...rbac.signedIn(), ...rememberUrls(inp("app_url")), ua(), s.function.run({ fn: hostFn, as: "link", input: {
    actor_id: auth("id"), envelope_id: inp("id"), recipient_id: inp("recipient_id"), ip: sys.remoteIp(), user_agent: ref("user_agent"),
  } })],
  response: ref("link"), history: false,
});

export const copyDownloadRoute = query({
  apiGroup: envelopesGroup, auth: user, name: "envelopes/{id}/recipients/{recipient_id}/download_link", verb: "POST",
  description: "A new link to the signed copy for one party, to share by hand. Shown once; replaces their earlier link.",
  input: { id: id(), recipient_id: input.int({ required: true }), app_url: input.text() },
  stack: [...rbac.signedIn(), ...rememberUrls(inp("app_url")), s.function.run({ fn: copyDownloadFn, as: "link", input: { actor_id: auth("id"), envelope_id: inp("id"), recipient_id: inp("recipient_id") } })],
  response: ref("link"), history: false,
});

export const envelopeQueries = [copyDownloadRoute, helloRoute, hostRoute, signAsMeRoute, listRoute, statsRoute, detailRoute, prepareRoute, updateDraftRoute, saveRecipientsRoute, saveFieldsRoute, sendRoute, copyLinkRoute, voidRoute, correctRoute, extendRoute, remindRoute];
