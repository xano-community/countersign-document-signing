// Templates, bulk sends and public links over HTTP. `templates` is for the team; `public` is open to anyone holding a public
// link, and only ever reaches a template whose link is turned on.
import { apiGroup, auth, fl, inp, input, query, ref, respond, s, sys, withFilters } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { rememberUrls } from "../function/settings/app_url.js";
import { deleteTemplateFn, listTemplatesFn, publicProblemsFn, saveAsTemplateFn, useTemplateFn } from "../function/templates/templates.js";
import { publicBriefFn, publicStartFn, publicVerifyFn, setPublicLinkFn } from "../function/templates/public.js";
import { bulkCancelFn, bulkCreateFn, bulkDetailFn } from "../function/templates/bulk.js";

export const templatesGroup = apiGroup({ name: "templates", canonical: "templates", middleware: { pre: [gateActive] }, description: "Templates, bulk sends and public links." });
export const publicGroup = apiGroup({ name: "public", canonical: "public", description: "Public links: anyone signs a template after proving their email." });

const id = () => input.int({ required: true });
const ua = () => s.set_var("user_agent", withFilters(sys.httpHeaders(), fl.get("User-Agent", "")));

export const listTemplatesRoute = query({
  apiGroup: templatesGroup, auth: user, name: "templates", verb: "GET",
  description: "The templates you can see, with their roles and public link.",
  stack: [...rbac.signedIn(), s.function.run({ fn: listTemplatesFn, as: "list", input: { actor_id: auth("id") } })],
  response: ref("list"),
});

export const useTemplateRoute = query({
  apiGroup: templatesGroup, auth: user, name: "templates/{id}/use", verb: "POST",
  description: "Make a document from a template with these people ([{ role_id, name, email }]), and send it if `send` is true.",
  input: { id: id(), people: input.json(), title: input.text({ methods: ["trim"] }), send: input.bool(), app_url: input.text() },
  stack: [
    ...rbac.signedIn(), ...rememberUrls(inp("app_url")), ua(),
    s.function.run({ fn: useTemplateFn, as: "used", input: {
      actor_id: auth("id"), template_id: inp("id"), people: inp("people"), title: inp("title"), send: inp("send"), ip: sys.remoteIp(), user_agent: ref("user_agent"),
    } }),
  ],
  response: ref("used"),
});

export const saveAsTemplateRoute = query({
  apiGroup: templatesGroup, auth: user, name: "templates", verb: "POST",
  description: "Save a document as a template: the same file and fields, with roles where the people were.",
  input: { envelope_id: input.int({ required: true }), title: input.text({ methods: ["trim"] }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: saveAsTemplateFn, as: "made", input: { actor_id: auth("id"), envelope_id: inp("envelope_id"), title: inp("title") } })],
  response: ref("made"),
});

export const deleteTemplateRoute = query({
  apiGroup: templatesGroup, auth: user, name: "templates/{id}", verb: "DELETE",
  description: "Delete a template and its public link. Documents made from it are unaffected.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: deleteTemplateFn, as: "gone", input: { actor_id: auth("id"), template_id: inp("id") } })],
  response: ref("gone"),
});

export const publicProblemsRoute = query({
  apiGroup: templatesGroup, auth: user, name: "templates/{id}/public_problems", verb: "GET",
  description: "What stops this template from having a public link.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: publicProblemsFn, as: "problems", input: { template_id: inp("id") } })],
  response: ref("problems"),
});

export const setPublicLinkRoute = query({
  apiGroup: templatesGroup, auth: user, name: "templates/{id}/public_link", verb: "POST",
  description: "Turn a template's public link on or off.",
  input: { id: id(), enabled: input.bool({ required: true }), app_url: input.text() },
  stack: [...rbac.signedIn(), ...rememberUrls(inp("app_url")), s.function.run({ fn: setPublicLinkFn, as: "link", input: { actor_id: auth("id"), template_id: inp("id"), enabled: inp("enabled") } })],
  response: ref("link"),
});

export const bulkCreateRoute = query({
  apiGroup: templatesGroup, auth: user, name: "templates/{id}/bulk", verb: "POST",
  description: "Send a template to many people: rows of [{ line, people: [{ role_id, name, email }] }].",
  input: { id: id(), rows: input.json({ required: true }), title: input.text({ methods: ["trim"] }), app_url: input.text() },
  stack: [...rbac.signedIn(), ...rememberUrls(inp("app_url")), s.function.run({ fn: bulkCreateFn, as: "bulk", input: { actor_id: auth("id"), template_id: inp("id"), rows: inp("rows"), title: inp("title") } })],
  response: ref("bulk"),
});

export const bulkDetailRoute = query({
  apiGroup: templatesGroup, auth: user, name: "bulk/{id}", verb: "GET",
  description: "A bulk send's progress and its failed rows.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: bulkDetailFn, as: "detail", input: { actor_id: auth("id"), bulk_send_id: inp("id") } })],
  response: ref("detail"),
});

export const bulkCancelRoute = query({
  apiGroup: templatesGroup, auth: user, name: "bulk/{id}/cancel", verb: "POST",
  description: "Stop a bulk send.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: bulkCancelFn, as: "done", input: { actor_id: auth("id"), bulk_send_id: inp("id") } })],
  response: ref("done"),
});

/** The public page never leaks its link: no referrer leaves it. */
const noReferrer = respond.header("Referrer-Policy", "no-referrer");

export const publicBriefRoute = query({
  apiGroup: publicGroup, name: "public/{slug}", verb: "GET",
  description: "What a public link's page shows before anyone gives their email.",
  input: { slug: input.text({ required: true }) },
  stack: [noReferrer, s.function.run({ fn: publicBriefFn, as: "brief", input: { slug: inp("slug") } })],
  response: ref("brief"), history: false,
});

export const publicStartRoute = query({
  apiGroup: publicGroup, name: "public/{slug}/start", verb: "POST",
  description: "Email a visitor a one-time code.",
  input: { slug: input.text({ required: true }), name: input.text({ methods: ["trim"] }), email: input.text({ methods: ["trim", "lower"] }) },
  stack: [noReferrer, s.function.run({ fn: publicStartFn, as: "started", input: { slug: inp("slug"), name: inp("name"), email: inp("email"), ip: sys.remoteIp() } })],
  response: ref("started"), history: false,
});

export const publicVerifyRoute = query({
  apiGroup: publicGroup, name: "public/{slug}/verify", verb: "POST",
  description: "Check a visitor's code and answer their signing link.",
  input: { slug: input.text({ required: true }), name: input.text({ methods: ["trim"] }), email: input.text({ methods: ["trim", "lower"] }), code: input.text({ methods: ["trim"] }) },
  stack: [noReferrer, ua(), s.function.run({ fn: publicVerifyFn, as: "verified", input: {
    slug: inp("slug"), name: inp("name"), email: inp("email"), code: inp("code"), ip: sys.remoteIp(), user_agent: ref("user_agent"),
  } })],
  response: ref("verified"), history: false,
});

export const templateQueries = [
  listTemplatesRoute, useTemplateRoute, saveAsTemplateRoute, deleteTemplateRoute, publicProblemsRoute, setPublicLinkRoute,
  bulkCreateRoute, bulkDetailRoute, bulkCancelRoute, publicBriefRoute, publicStartRoute, publicVerifyRoute,
];
