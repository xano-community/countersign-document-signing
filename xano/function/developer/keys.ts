// Developer API keys. A key is random, shown once, and stored only as its SHA-256 with its first characters for recognising it.
// A call made with a key acts as the person who made it, with their role as it is now: remove them or lower their role and
// the key loses that access at once. Keys go to the separate `api` group; the app's own routes never accept them.
import { auth, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { api_key, api_key_use } from "../../table/developer/api_key.js";
import { user } from "../../table/user.js";
import { loadActor } from "../envelope/draft.js";

const MOST_KEYS = 20;
/** Keys last until revoked; the token itself is good for ten years. */
const KEY_SECONDS = 10 * 365 * 24 * 3600;
const KEY_REFUSED = "This API key isn't valid. It may have been revoked.";
const manage = [...loadActor(), rbac.allows(ref("actor.role"), "developer.manage", "Your role can't manage API keys.")];

/** Make a key. Answers it in full, once. */
export const createKeyFn = defineFunction({
  name: "api_key/create",
  description: "Make an API key that acts as you. It's shown once.",
  input: { actor_id: input.int({ required: true }), name: input.text({ methods: ["trim"] }) },
  stack: [
    ...manage,
    s.set_var("k_name", withFilters(inp("name"), fl.first_notnull(c.text("")), fl.substr(c.int(0), c.int(80)))),
    guard.require(expr(withFilters(ref("k_name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Name the key after what uses it, like “CRM sync”." }),
    s.db.query({ table: api_key, where: [cmp(col("user_id"), "=", ref("actor.id")), cmp(col("revoked_at"), "=", c.null())], returnType: "count", as: "live" }),
    guard.require(expr(ref("live"), "<", c.int(MOST_KEYS)), { errorType: "badrequest", message: `You can have up to ${MOST_KEYS} keys. Revoke one you don't use.` }),
    s.security.random_bytes({ length: c.int(16), as: "placeholder" }),
    s.db.add({ table: api_key, row: { name: ref("k_name"), prefix: c.text(""), key_hash: withFilters(ref("placeholder"), fl.bin2hex()), user_id: ref("actor.id") }, as: "made" }),
    s.security.create_auth_token({ table: api_key, id: ref("made.id"), extras: obj({ kind: c.text("api") }), expiration: c.int(KEY_SECONDS), as: "key" }),
    s.set_var("key_len", withFilters(ref("key"), fl.strlen())),
    s.set_var("tail_from", withFilters(ref("key_len"), fl.sub(c.int(6)))),
    s.set_var("tail", withFilters(ref("key"), fl.substr(ref("tail_from"), c.int(6)))),
    s.db.patch({ table: api_key, fieldValue: ref("made.id"), data: obj({ prefix: ref("tail"), key_hash: withFilters(ref("key"), fl.sha256()) }), as: "sealed" }),
    changed({ entity: "api_key", id: ref("made.id"), op: "created", actor: inp("actor_id") }),
  ],
  response: obj({ id: ref("made.id"), name: ref("k_name"), key: ref("key"), prefix: ref("tail") }),
});

/** Keys: your own, or everyone's for someone who reads every envelope (so an admin can revoke a leaver's). Never the key itself. */
export const listKeysFn = defineFunction({
  name: "api_key/list",
  description: "API keys, without the keys themselves.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...manage,
    s.set_var("all", c.bool(false)),
    s.conditional({ when: rbac.has(ref("actor.role"), "envelope.read_all"), then: [s.update_var("all", c.bool(true))] }),
    s.db.query({ table: api_key, sort: [{ sortBy: "id", dir: "desc" }], output: ["id", "name", "prefix", "user_id", "last_used_at", "revoked_at", "created_at"], as: "keys" }),
    s.set_var("items", c.array([])),
    s.foreach({ list: ref("keys"), as: "k", body: [
      s.conditional({ when: expr(c.expression("$var.all || $var.k.user_id == $var.actor.id"), "=", c.bool(true)), then: [
        s.db.get({ table: user, fieldValue: ref("k.user_id"), output: ["name"], as: "owner" }),
        s.db.query({ table: api_key_use, where: cmp(col("key_id"), "=", ref("k.id")), sort: [{ sortBy: "created_at", dir: "desc" }], output: ["created_at"], returnType: "single", as: "last_use" }),
        s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("k"), fl.set("owner_name", ref("owner.name", { safe: true })), fl.set("last_used_at", ref("last_use.created_at", { safe: true })))))),
      ] }),
    ] }),
  ],
  response: obj({ items: ref("items") }),
});

/** Revoke a key: it stops working on its next call. */
export const revokeKeyFn = defineFunction({
  name: "api_key/revoke",
  description: "Revoke an API key. It stops working at once.",
  input: { actor_id: input.int({ required: true }), key_id: input.int({ required: true }) },
  stack: [
    ...manage,
    s.db.get({ table: api_key, fieldValue: inp("key_id"), as: "k" }),
    guard.found("k", { errorType: "notfound", message: "That key doesn't exist." }),
    s.conditional({ when: expr(ref("k.user_id"), "!=", ref("actor.id")), then: [
      rbac.allows(ref("actor.role"), "envelope.read_all", "Only the person who made this key can revoke it."),
    ] }),
    s.conditional({ when: expr(ref("k.revoked_at"), "=", c.null()), then: [
      s.set_var("now_ms", c.now()),
      s.db.patch({ table: api_key, fieldValue: ref("k.id"), data: obj({ revoked_at: ref("now_ms") }), as: "revoked" }),
    ] }),
    changed({ entity: "api_key", id: ref("k.id"), actor: inp("actor_id") }),
  ],
  response: obj({ ok: c.bool(true) }),
});

/** Who an API key acts as, or refuses: a revoked key, and a key whose maker has left, are refused like an unknown one. Logs the use. */
export const resolveKeyFn = defineFunction({
  name: "api_key/resolve",
  description: "The person an API key acts as, if it's live and they're still on the team. Records the call.",
  input: { key_id: input.int({ required: true }), route: input.text() },
  stack: [
    s.db.get({ table: api_key, fieldValue: inp("key_id"), output: ["id", "user_id", "revoked_at"], as: "used_key" }),
    guard.found("used_key", { errorType: "unauthorized", message: KEY_REFUSED }),
    guard.require(expr(ref("used_key.revoked_at"), "=", c.null()), { errorType: "unauthorized", message: KEY_REFUSED }),
    s.db.get({ table: user, fieldValue: ref("used_key.user_id"), output: ["id", "status"], as: "key_owner" }),
    guard.found("key_owner", { errorType: "unauthorized", message: KEY_REFUSED }),
    guard.require(expr(ref("key_owner.status"), "=", c.text("active")), { errorType: "unauthorized", message: KEY_REFUSED }),
    s.db.add({ table: api_key_use, row: { key_id: ref("used_key.id"), route: withFilters(inp("route"), fl.first_notnull(c.text(""))) }, as: "logged" }),
  ],
  response: ref("key_owner.id"),
  responseShape: 0 as number,
});

/** The first statements of every `api` route (auth: api_key): bind `actor_id` to the key's maker, or refuse. */
export const keyActor = (route: string) => statements(
  guard.require(expr(withFilters(auth("extras"), fl.get(c.text("kind")), fl.first_notnull(c.text(""))), "=", c.text("api")), { errorType: "unauthorized", message: KEY_REFUSED }),
  s.function.run({ fn: resolveKeyFn, as: "actor_id", input: { key_id: auth("id"), route: c.text(route) } }),
);

export const keyFunctions = [createKeyFn, listKeysFn, revokeKeyFn, resolveKeyFn];
