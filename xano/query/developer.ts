// The developer surface. `developer` is the app's own screen for API keys and webhooks (signed-in, developer.manage). `api` is
// the public REST API: every route takes an API key, acts as the person who made it, and runs the same functions the app does,
// so the same rules and the same audit trail apply.
import { apiGroup, auth, c, fl, inp, input, obj, query, ref, s, sys, withFilters } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { api_key } from "../table/developer/api_key.js";
import { gateActive } from "../function/members/gate.js";
import { createKeyFn, keyActor, listKeysFn, revokeKeyFn } from "../function/developer/keys.js";
import { addEndpointFn, listEndpointsFn, pingEndpointFn, redeliverFn, updateEndpointFn } from "../function/developer/webhooks.js";
import { envelopeDetail, listEnvelopes } from "../function/envelope/list.js";
import { remindFn, voidFn } from "../function/envelope/manage.js";
import { listTemplatesFn, useTemplateFn } from "../function/templates/templates.js";
import { memberFinal } from "../function/seal/files.js";

export const developerGroup = apiGroup({ name: "developer", canonical: "developer", middleware: { pre: [gateActive] }, description: "API keys and webhooks." });
export const apiV1Group = apiGroup({ name: "api", canonical: "api", description: "The Countersign REST API. Send `Authorization: Bearer <API key>`; every call acts as the key's maker." });

const id = () => input.int({ required: true });
const ua = () => s.set_var("user_agent", withFilters(sys.httpHeaders(), fl.get("User-Agent", "")));

// ── The app's developer screen ─────────────────────────────────────────────────────────────────────────────────────────────

export const listKeysRoute = query({
  apiGroup: developerGroup, auth: user, name: "developer/keys", verb: "GET", description: "API keys, without the keys themselves.",
  stack: [...rbac.signedIn(), s.function.run({ fn: listKeysFn, as: "list", input: { actor_id: auth("id") } })], response: ref("list"),
});
export const createKeyRoute = query({
  apiGroup: developerGroup, auth: user, name: "developer/keys", verb: "POST", description: "Make an API key. It's shown once.",
  input: { name: input.text({ methods: ["trim"] }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: createKeyFn, as: "made", input: { actor_id: auth("id"), name: inp("name") } })], response: ref("made"), history: false,
});
export const revokeKeyRoute = query({
  apiGroup: developerGroup, auth: user, name: "developer/keys/{id}/revoke", verb: "POST", description: "Revoke an API key.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: revokeKeyFn, as: "done", input: { actor_id: auth("id"), key_id: inp("id") } })], response: ref("done"),
});
export const listHooksRoute = query({
  apiGroup: developerGroup, auth: user, name: "developer/webhooks", verb: "GET", description: "Webhook endpoints and their recent deliveries.",
  stack: [...rbac.signedIn(), s.function.run({ fn: listEndpointsFn, as: "list", input: { actor_id: auth("id") } })], response: ref("list"),
});
export const addHookRoute = query({
  apiGroup: developerGroup, auth: user, name: "developer/webhooks", verb: "POST", description: "Add a webhook endpoint. Its signing secret is shown once.",
  input: { url: input.text({ methods: ["trim"] }), events: input.json(), description: input.text({ methods: ["trim"] }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: addEndpointFn, as: "made", input: { actor_id: auth("id"), url: inp("url"), events: inp("events"), description: inp("description") } })], response: ref("made"), history: false,
});
export const updateHookRoute = query({
  apiGroup: developerGroup, auth: user, name: "developer/webhooks/{id}", verb: "PATCH", description: "Turn a webhook endpoint on or off, or delete it.",
  input: { id: id(), enabled: input.bool(), remove: input.bool() },
  stack: [...rbac.signedIn(), s.function.run({ fn: updateEndpointFn, as: "done", input: { actor_id: auth("id"), endpoint_id: inp("id"), enabled: inp("enabled"), remove: inp("remove") } })], response: ref("done"),
});
export const pingHookRoute = query({
  apiGroup: developerGroup, auth: user, name: "developer/webhooks/{id}/ping", verb: "POST", description: "Send a signed test event now.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: pingEndpointFn, as: "result", input: { actor_id: auth("id"), endpoint_id: inp("id") } })], response: ref("result"),
});
export const redeliverRoute = query({
  apiGroup: developerGroup, auth: user, name: "developer/deliveries/{id}/resend", verb: "POST", description: "Send a webhook delivery again now.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: redeliverFn, as: "result", input: { actor_id: auth("id"), delivery_id: inp("id") } })], response: ref("result"),
});

// ── The REST API ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const apiListRoute = query({
  apiGroup: apiV1Group, auth: api_key, name: "v1/envelopes", verb: "GET",
  description: "Envelopes you can see, newest activity first. `segment`: action, waiting, completed, drafts, ended or all. `q` searches titles and people.",
  input: { segment: input.text(), q: input.text({ methods: ["trim"] }), page: input.int() },
  stack: [...keyActor("v1/envelopes"), s.function.run({ fn: listEnvelopes, as: "list", input: { actor_id: ref("actor_id"), segment: withFilters(inp("segment"), fl.first_notempty(c.text("all"))), q: inp("q"), page: inp("page") } })],
  response: obj({ items: ref("list.items"), people: ref("list.people"), next_page: ref("list.next_page"), total: ref("list.total") }), history: false,
});
export const apiGetRoute = query({
  apiGroup: apiV1Group, auth: api_key, name: "v1/envelopes/{id}", verb: "GET",
  description: "One envelope: its people, emails, audit trail and integrity check.",
  input: { id: id() },
  stack: [...keyActor("v1/envelopes/{id}"), s.function.run({ fn: envelopeDetail, as: "detail", input: { actor_id: ref("actor_id"), envelope_id: inp("id") } })],
  response: ref("detail"), history: false,
});
export const apiTemplatesRoute = query({
  apiGroup: apiV1Group, auth: api_key, name: "v1/templates", verb: "GET",
  description: "Templates you can see, with their roles. Fill a role by its id when sending.",
  stack: [...keyActor("v1/templates"), s.function.run({ fn: listTemplatesFn, as: "list", input: { actor_id: ref("actor_id") } })],
  response: ref("list"), history: false,
});
export const apiSendRoute = query({
  apiGroup: apiV1Group, auth: api_key, name: "v1/templates/{id}/send", verb: "POST",
  description: "Send a template: `people` is [{ role_id, name, email }] for each role without a fixed person. Answers the new envelope's id.",
  input: { id: id(), people: input.json(), title: input.text({ methods: ["trim"] }) },
  stack: [...keyActor("v1/templates/{id}/send"), ua(), s.function.run({ fn: useTemplateFn, as: "used", input: { actor_id: ref("actor_id"), template_id: inp("id"), people: inp("people"), title: inp("title"), send: c.bool(true), ip: sys.remoteIp(), user_agent: ref("user_agent") } })],
  response: obj({ envelope_id: ref("used.envelope_id"), links: ref("used.sent.links") }), history: false,
});
export const apiVoidRoute = query({
  apiGroup: apiV1Group, auth: api_key, name: "v1/envelopes/{id}/void", verb: "POST",
  description: "Cancel an envelope that's out for signature. Everyone who had it is told the reason.",
  input: { id: id(), reason: input.text({ methods: ["trim"] }) },
  stack: [...keyActor("v1/envelopes/{id}/void"), ua(), s.function.run({ fn: voidFn, as: "done", input: { actor_id: ref("actor_id"), envelope_id: inp("id"), reason: inp("reason"), ip: sys.remoteIp(), user_agent: ref("user_agent") } })],
  response: obj({ ok: c.bool(true) }), history: false,
});
export const apiRemindRoute = query({
  apiGroup: apiV1Group, auth: api_key, name: "v1/envelopes/{id}/remind", verb: "POST",
  description: "Remind a recipient whose turn it is.",
  input: { id: id(), recipient_id: input.int({ required: true }) },
  stack: [...keyActor("v1/envelopes/{id}/remind"), ua(), s.function.run({ fn: remindFn, as: "done", input: { actor_id: ref("actor_id"), envelope_id: inp("id"), recipient_id: inp("recipient_id"), ip: sys.remoteIp(), user_agent: ref("user_agent") } })],
  response: obj({ ok: c.bool(true) }), history: false,
});
export const apiSignedPdfRoute = query({
  apiGroup: apiV1Group, auth: api_key, name: "v1/envelopes/{id}/signed_pdf", verb: "GET",
  description: "The signed PDF of a completed envelope: a short-lived `url` to download, or the file as base64 in `b64` when it's kept in the database.",
  input: { id: id() },
  stack: [...keyActor("v1/envelopes/{id}/signed_pdf"), s.function.run({ fn: memberFinal, as: "file", input: { actor_id: ref("actor_id"), envelope_id: inp("id"), with_bytes: c.bool(true) } })],
  response: ref("file"), history: false,
});

export const developerQueries = [listKeysRoute, createKeyRoute, revokeKeyRoute, listHooksRoute, addHookRoute, updateHookRoute, pingHookRoute, redeliverRoute];
export const apiQueries = [apiListRoute, apiGetRoute, apiTemplatesRoute, apiSendRoute, apiVoidRoute, apiRemindRoute, apiSignedPdfRoute];
