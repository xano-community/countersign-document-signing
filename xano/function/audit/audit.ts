// The audit trail. Every event on an envelope goes through `appendFn`, which chains it to the one before: its hash covers
// the previous hash and this row's fields, in one fixed order. Editing any stored row breaks every hash from there on, and
// `verifyFn` names the first row that no longer adds up. The fixed order is the canonical form, so it must never change
// without bumping HASH_VERSION (old rows keep the version they were written with).
import { c, cmp, col, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { audit_event } from "../../table/signing/audit_event.js";
import { envelope } from "../../table/envelope/envelope.js";

export const HASH_VERSION = 1;

/** The text a row's hash covers. Writing and checking both build it here, so they can't drift apart. */
const canonical = (r: (k: string) => Value, prev: Value) => {
  const t = (k: string) => withFilters(r(k), fl.first_notnull(c.text("")), fl.to_text());
  const n = (k: string) => withFilters(r(k), fl.first_notnull(c.int(0)), fl.to_int());
  return withFilters(
    obj({
      v: n("hash_version"), envelope_id: n("envelope_id"), seq: n("seq"), kind: t("kind"),
      actor_type: t("actor_type"), actor_id: n("actor_id"), actor_name: t("actor_name"), actor_email: t("actor_email"),
      ip: t("ip"), user_agent: t("user_agent"), at: n("at"), data: t("data"), prev: withFilters(prev, fl.first_notnull(c.text(""))),
    }),
    fl.json_encode(),
  );
};

/** Add one event to an envelope's trail. Locks the envelope row, so two events never take the same place in the chain. */
export const appendFn = defineFunction({
  name: "audit/append",
  description: "Append a hash-chained event to an envelope's audit trail.",
  input: {
    envelope_id: input.int({ required: true }), kind: input.text({ required: true }),
    actor_type: input.text(), actor_id: input.int(), actor_name: input.text(), actor_email: input.text(),
    ip: input.text(), user_agent: input.text(), data: input.json(),
    /** When it happened, if not now. Only the demo world sets it, to lay out its backdated history; the hash covers it either way. */
    at: input.int(),
  },
  stack: [
    s.set_var("called_at", c.now()),
    s.db.transaction({ body: [
      s.db.get({ table: envelope, fieldValue: inp("envelope_id"), lock: true, output: ["id"], as: "audit_env" }),
      s.db.query({ table: audit_event, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "seq", dir: "desc" }], paging: { per_page: 1, metadata: false }, output: ["seq", "hash"], as: "audit_last" }),
      s.set_var("audit_seq", c.int(1)),
      s.set_var("audit_prev", c.text("")),
      s.conditional({ when: expr(withFilters(ref("audit_last"), fl.count()), ">", c.int(0)), then: [
        s.update_var("audit_seq", withFilters(ref("audit_last"), fl.first(), fl.get("seq"), fl.add(c.int(1)))),
        s.update_var("audit_prev", withFilters(ref("audit_last"), fl.first(), fl.get("hash"))),
      ] }),
      s.set_var("audit_now", withFilters(inp("at"), fl.first_notempty(ref("called_at")))),
      s.set_var("audit_row", obj({
        hash_version: c.int(HASH_VERSION), envelope_id: inp("envelope_id"), seq: ref("audit_seq"), kind: inp("kind"),
        actor_type: withFilters(inp("actor_type"), fl.first_notempty(c.text("system"))), actor_id: inp("actor_id"),
        actor_name: inp("actor_name"), actor_email: inp("actor_email"), ip: inp("ip"), user_agent: inp("user_agent"),
        at: ref("audit_now"), data: withFilters(inp("data"), fl.first_notnull(obj({})), fl.json_encode()),
      })),
      s.set_var("audit_hash", withFilters(canonical((k) => withFilters(ref("audit_row"), fl.get(k)), ref("audit_prev")), fl.sha256())),
      s.db.add({ table: audit_event, row: {
        envelope_id: inp("envelope_id"), seq: ref("audit_seq"), kind: inp("kind"),
        actor_type: withFilters(ref("audit_row"), fl.get("actor_type")), actor_id: inp("actor_id"), actor_name: inp("actor_name"),
        actor_email: inp("actor_email"), ip: inp("ip"), user_agent: inp("user_agent"),
        data: withFilters(ref("audit_row"), fl.get("data")), at: withFilters(ref("audit_row"), fl.get("at")),
        hash_version: c.int(HASH_VERSION), prev_hash: ref("audit_prev"), hash: ref("audit_hash"),
      }, as: "audit_added" }),
    ] }),
    // Webhook events (envelope.sent, recipient.signed, …) go out to developers' endpoints. Called by name: webhooks reads the trail's tables.
    s.function.run({ fn: "webhook/enqueue", as: "webhooks", input: { envelope_id: inp("envelope_id"), kind: inp("kind"), seq: ref("audit_seq"), at: ref("audit_now"), data: inp("data") } }),
  ],
  response: { seq: ref("audit_seq"), hash: ref("audit_hash") },
});

/** Walk an envelope's trail from the start. `ok` with the chain head, or the first `seq` whose hash doesn't add up. */
export const verifyFn = defineFunction({
  name: "audit/verify",
  description: "Check an envelope's audit chain and report the first broken row.",
  input: { envelope_id: input.int({ required: true }) },
  stack: [
    s.db.query({ table: audit_event, where: cmp(col("envelope_id"), "=", inp("envelope_id")), sort: [{ sortBy: "seq", dir: "asc" }], as: "chain" }),
    s.set_var("prev", c.text("")),
    s.set_var("broken_at", c.int(0)),
    s.set_var("expect_seq", c.int(1)),
    s.foreach({ list: ref("chain"), as: "row", body: [
      s.conditional({ when: expr(ref("broken_at"), "=", c.int(0)), then: [
        s.set_var("want", withFilters(canonical((k) => ref(`row.${k}`, { safe: true }), ref("prev")), fl.sha256())),
        s.conditional({
          when: expr(ref("want"), "!=", ref("row.hash")),
          then: [s.update_var("broken_at", ref("row.seq"))],
        }),
        s.conditional({ when: expr(ref("row.prev_hash"), "!=", ref("prev")), then: [s.update_var("broken_at", ref("row.seq"))] }),
        s.conditional({ when: expr(ref("row.seq"), "!=", ref("expect_seq")), then: [s.update_var("broken_at", ref("row.seq"))] }),
        s.update_var("prev", ref("row.hash")),
        s.update_var("expect_seq", withFilters(ref("expect_seq"), fl.add(c.int(1)))),
      ] }),
    ] }),
  ],
  response: obj({
    ok: withFilters(ref("broken_at"), fl.eq(c.int(0))),
    events: withFilters(ref("chain"), fl.count()),
    head: ref("prev"),
    broken_at: ref("broken_at"),
  }),
});

/** One step in a stack: append an event. `actor` is the event's who; `data` an obj({...}) of details. */
export const audit = (o: { envelope: Value; kind: string | Value; actor?: { type?: Value; id?: Value; name?: Value; email?: Value; ip?: Value; ua?: Value }; data?: Value; as?: string }) =>
  s.function.run({ fn: appendFn, as: o.as ?? "_audited", input: {
    envelope_id: o.envelope, kind: typeof o.kind === "string" ? c.text(o.kind) : o.kind,
    actor_type: o.actor?.type ?? c.text("system"), actor_id: o.actor?.id ?? c.int(0), actor_name: o.actor?.name ?? c.text(""),
    actor_email: o.actor?.email ?? c.text(""), ip: o.actor?.ip ?? c.text(""), user_agent: o.actor?.ua ?? c.text(""),
    data: o.data ?? obj({}),
  } });
