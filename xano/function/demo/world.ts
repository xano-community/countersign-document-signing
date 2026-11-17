// Writes the demo world's history once, on the first sweep after deploy (or the first visit, whichever comes first): each seeded
// document's audit trail through audit/append with its backdated times, the link-only invites on each page, and then lets the
// seal finish the documents everyone has signed. See xano/world.ts for the world itself.
import { c, cmp, col, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { envelope } from "../../table/envelope/envelope.js";
import { org_setting } from "../../table/envelope/org_setting.js";
import { recipient } from "../../table/envelope/recipient.js";
import { appendFn } from "../audit/audit.js";
import { enqueueFn } from "../email/outbox.js";
import { mintLinkFn } from "../signing/links.js";
import { DEMO_SIGNER_RECIPIENT, WORLD_EVENTS, WORLD_INVITED, WORLD_TO_SEAL } from "../../world.js";

export const buildWorldFn = defineFunction({
  name: "demo/build_world",
  description: "Write the demo documents' history once: their audit trails, invites, and the seal of the signed ones.",
  stack: [
    s.set_var("claimed", c.bool(false)),
    s.db.transaction({ body: [
      s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["id", "world_built_at"], returnType: "single", as: "org" }),
      s.conditional({ when: expr(ref("org"), "!=", c.null()), then: [
        s.set_var("org_id", withFilters(ref("org"), fl.get("id"))),
        s.db.get({ table: org_setting, fieldValue: ref("org_id"), lock: true, output: ["id", "world_built_at"], as: "locked" }),
        s.conditional({ when: expr(ref("locked.world_built_at", { safe: true }), "=", c.null()), then: [
          s.set_var("now_ms", c.now()),
          s.db.patch({ table: org_setting, fieldValue: ref("org_id"), data: obj({ world_built_at: ref("now_ms") }), as: "marked" }),
          s.update_var("claimed", c.bool(true)),
        ] }),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("claimed"), "=", c.bool(false)), then: [s.return(obj({ built: c.bool(false) }))] }),
    // Cleared or never seeded: nothing to write.
    s.db.query({ table: envelope, where: cmp(col("is_demo"), "=", c.bool(true)), returnType: "count", as: "demo_docs" }),
    s.conditional({ when: expr(ref("demo_docs"), "=", c.int(0)), then: [s.return(obj({ built: c.bool(false) }))] }),
    s.foreach({ list: c.array(WORLD_EVENTS), as: "ev", body: [
      s.db.get({ table: envelope, fieldValue: ref("ev.envelope_id"), output: ["id", "is_demo"], as: "ev_env" }),
      s.conditional({ when: expr(ref("ev_env.is_demo", { safe: true }), "=", c.bool(true)), then: [
        s.function.run({ fn: appendFn, as: "written", input: {
          envelope_id: ref("ev.envelope_id"), kind: ref("ev.kind"), at: ref("ev.at"), data: ref("ev.data"), actor_type: ref("ev.actor_type"), actor_id: ref("ev.actor_id"),
          actor_name: ref("ev.actor_name"), actor_email: ref("ev.actor_email"), ip: ref("ev.ip"), user_agent: ref("ev.user_agent"),
        } }),
      ] }),
    ] }),
    s.foreach({ list: c.array(WORLD_INVITED), as: "rid", body: [
      s.try_catch({ try: [s.function.run({ fn: enqueueFn, as: "invite", input: { kind: c.text("invite"), recipient_id: ref("rid") } })], catch: [] }),
    ] }),
    // Their trails are written, so the seal may take the signed ones now (the next sweep, or straight away below).
    s.foreach({ list: c.array(WORLD_TO_SEAL), as: "sid", body: [
      s.db.get({ table: envelope, fieldValue: ref("sid"), output: ["id", "status"], as: "to_seal" }),
      s.conditional({ when: expr(ref("to_seal.status", { safe: true }), "=", c.text("sealing")), then: [
        s.db.patch({ table: envelope, fieldValue: ref("sid"), data: obj({ seal_next_at: c.null() }), as: "due_now" }),
      ] }),
    ] }),
  ],
  response: obj({ built: c.bool(true) }),
  responseShape: {} as { built: boolean },
});

/** "See what a signer sees": a fresh link to the demo signer's page, only while demo mode is on and her turn hasn't passed. */
export const demoSignerFn = defineFunction({
  name: "demo/signer_link",
  description: "In demo mode, a signing link for the demo signer, as a path.",
  stack: [
    s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["demo_mode"], returnType: "single", as: "org" }),
    s.conditional({ when: expr(ref("org.demo_mode", { safe: true }), "!=", c.bool(true)), then: [s.return(obj({ state: c.text("off"), path: c.text("") }))] }),
    s.db.get({ table: recipient, fieldValue: c.int(DEMO_SIGNER_RECIPIENT), output: ["id", "status", "is_demo", "envelope_id"], as: "maya" }),
    s.conditional({ when: expr(ref("maya.is_demo", { safe: true }), "!=", c.bool(true)), then: [s.return(obj({ state: c.text("gone"), path: c.text("") }))] }),
    s.function.run({ fn: mintLinkFn, as: "minted", input: { recipient_id: c.int(DEMO_SIGNER_RECIPIENT), via: c.text("demo"), path_only: c.bool(true) } }),
  ],
  response: obj({ state: c.text("ok"), path: ref("minted.url") }),
  responseShape: {} as { state: "ok" | "off" | "gone"; path: string },
});

export const worldFunctions = [buildWorldFn, demoSignerFn];
