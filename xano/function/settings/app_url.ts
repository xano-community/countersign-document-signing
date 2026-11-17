// The app's own public addresses, learned from requests. Emails need the frontend's address to build signing links, and
// background work (the sweep, a seal) runs where `sys.apiBaseUrl()` isn't available, so both are kept on the settings row.
//
// How callers use it: any signed-in route that comes before mail goes out (sending an envelope, "Copy link", the email
// settings screen) adds `...rememberUrls()` to its stack. It reads the browser's `Origin` header, or an `app_url` input
// the frontend sends (`window.location.origin`) when the route declares one:
//   stack: [...rbac.require("envelope.send", "…"), ...rememberUrls(inp("app_url")), s.function.run({ fn: sendFn, … })]
// An address is learned once by anyone. Changing it afterwards takes `settings.manage`, so a member can't point everyone's
// links somewhere else by sending a forged header.
import { auth, c, defineFunction, expr, fl, inp, input, obj, ref, s, statements, sys, withFilters, type Value } from "@xano/sdk";
import { org_setting } from "../../table/envelope/org_setting.js";
import { user } from "../../table/user.js";
import { rbac } from "../../rbac.js";

/** scheme://host[:port], nothing after it. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/i;
/** An API base: an origin, optionally with a path (an instance can serve under one). */
const API_BASE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/i;

export const rememberUrlsFn = defineFunction({
  name: "app/remember_urls",
  description: "Keep the app's public URL and API base on the settings row, learned from a signed-in request.",
  input: { actor_id: input.int({ required: true }), app_url: input.text(), origin: input.text(), api_base: input.text() },
  stack: [
    s.set_var("u_app", withFilters(inp("app_url"), fl.first_notempty(inp("origin")), fl.first_notnull(c.text("")), fl.trim(), fl.rtrim(c.text("/")), fl.lower())),
    s.set_var("u_app_ok", withFilters(c.regex(ORIGIN), fl.regex_test(ref("u_app")))),
    s.set_var("u_api", withFilters(inp("api_base"), fl.first_notnull(c.text("")), fl.trim(), fl.rtrim(c.text("/")))),
    s.set_var("u_api_ok", withFilters(c.regex(API_BASE), fl.regex_test(ref("u_api")))),
    s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["id", "app_url", "api_base_url"], returnType: "single", as: "u_org" }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role", "status"], as: "u_actor" }),
    s.set_var("u_admin", withFilters(c.array(rbac.rolesWith("settings.manage")), fl.in(ref("u_actor.role", { safe: true })))),
    s.set_var("u_was_app", withFilters(ref("u_org.app_url", { safe: true }), fl.first_notnull(c.text("")))),
    s.set_var("u_was_api", withFilters(ref("u_org.api_base_url", { safe: true }), fl.first_notnull(c.text("")))),
    s.set_var("u_patch", obj({})),
    s.conditional({ when: expr(c.expression('$var.u_app_ok && $var.u_app != $var.u_was_app && ($var.u_was_app == "" || $var.u_admin)'), "=", c.bool(true)), then: [
      s.update_var("u_patch", withFilters(ref("u_patch"), fl.set(c.text("app_url"), ref("u_app")))),
    ] }),
    s.conditional({ when: expr(c.expression('$var.u_api_ok && $var.u_api != $var.u_was_api && ($var.u_was_api == "" || $var.u_admin)'), "=", c.bool(true)), then: [
      s.update_var("u_patch", withFilters(ref("u_patch"), fl.set(c.text("api_base_url"), ref("u_api")))),
    ] }),
    s.set_var("u_changed", withFilters(ref("u_patch"), fl.count(), fl.to_int())),
    s.set_var("u_org_id", withFilters(ref("u_org.id", { safe: true }), fl.first_notempty(c.int(0)))),
    s.set_var("u_active", withFilters(ref("u_actor.status", { safe: true }), fl.first_notnull(c.text("")))),
    s.set_var("u_updated", c.bool(false)),
    s.conditional({ when: expr(c.expression('$var.u_changed > 0 && $var.u_org_id > 0 && $var.u_active == "active"'), "=", c.bool(true)), then: [
      s.db.patch({ table: org_setting, fieldValue: ref("u_org_id"), data: ref("u_patch") }),
      s.update_var("u_updated", c.bool(true)),
    ] }),
  ],
  response: obj({ updated: ref("u_updated") }),
});

/**
 * Statements for a signed-in route: remember where the app is served. `appUrl` is an optional input the frontend sends;
 * without it the request's `Origin` header is used. The API base comes from the request itself.
 */
export const rememberUrls = (appUrl: Value = c.text("")) => statements(
  s.set_var("ru_origin", withFilters(sys.httpHeaders(), fl.get(c.text("Origin"), c.text("")))),
  s.set_var("ru_api", withFilters(c.regex(/\/api:.*$/), fl.regex_replace(c.text(""), sys.apiBaseUrl()))),
  s.function.run({ fn: rememberUrlsFn, as: "ru_done", input: { actor_id: auth("id"), app_url: appUrl, origin: ref("ru_origin"), api_base: ref("ru_api") } }),
);
