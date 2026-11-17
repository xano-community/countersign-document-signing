// Templates, public links and bulk sends: a template fills its roles with the right people, a public link only opens when it's
// on and only after the visitor proves their email, codes can't be used to flood an inbox, and a bulk send sends each good row
// exactly once.
import { c, cmp, col, obj, ref, s, withFilters, fl, workflowTest as plainWorkflowTest } from "@xano/sdk";
import { envelope } from "../table/envelope/envelope.js";
import { recipient } from "../table/envelope/recipient.js";
import { field } from "../table/envelope/field.js";
import { public_link } from "../table/envelope/public_link.js";
import { bulk_send, bulk_send_row } from "../table/envelope/bulk_send.js";
import { org_setting } from "../table/envelope/org_setting.js";
import { instantiateFn } from "../function/templates/templates.js";
import { publicBriefFn, publicStartFn, publicVerifyFn } from "../function/templates/public.js";
import { bulkCreateFn, bulkStepFn } from "../function/templates/bulk.js";
import { draft, person, workflowTest } from "./fixtures.js";

/** A one-page lease template: "Tenant" is filled in each time, "Landlord" is always the same person. Each signs once. */
const leaseTemplate = (sender: string) => [
  draft("tpl", sender, "Lease template", { original_file_id: c.int(1), page_count: c.int(1) }),
  s.db.patch({ table: envelope, fieldValue: ref("tpl.id"), data: obj({ is_template: c.bool(true), signing_order: c.text("ordered") }), as: "tpl_marked" }),
  s.db.add({ table: recipient, as: "tenant", row: { envelope_id: ref("tpl.id"), role: c.text("signer"), role_name: c.text("Tenant"), name: c.text(""), email: c.text(""), step: c.int(1), color: c.int(1), status: c.text("waiting"), round: c.int(1) } }),
  s.db.add({ table: recipient, as: "landlord", row: { envelope_id: ref("tpl.id"), role: c.text("signer"), role_name: c.text("Landlord"), name: c.text("Jordan Lee"), email: c.text("jordan@fernhill-test.example"), step: c.int(2), color: c.int(2), status: c.text("waiting"), round: c.int(1) } }),
  s.db.add({ table: field, as: "f_tenant", row: { envelope_id: ref("tpl.id"), recipient_id: ref("tenant.id"), type: c.text("signature"), page: c.int(1), x: c.decimal(0.1), y: c.decimal(0.7), w: c.decimal(0.3), h: c.decimal(0.06), required: c.bool(true) } }),
  s.db.add({ table: field, as: "f_landlord", row: { envelope_id: ref("tpl.id"), recipient_id: ref("landlord.id"), type: c.text("signature"), page: c.int(1), x: c.decimal(0.55), y: c.decimal(0.7), w: c.decimal(0.3), h: c.decimal(0.06), required: c.bool(true) } }),
];
const org = () => s.db.add({ table: org_setting, as: "org", row: { org_name: c.text("Fernhill Test"), app_url: c.text("https://sign.fernhill-test.example"), demo_mode: c.bool(false) } });

export const templateTests = [
  workflowTest({
    name: "templates: using a template puts each field with the right person, and a repeat makes nothing new",
    description: "The tenant role takes the given person, the landlord keeps the template's fixed person, fields follow their roles, and the same origin key answers the same envelope.",
    stack: [
      person("sender"),
      ...leaseTemplate("sender"),
      s.set_var("people", withFilters(c.array([]), fl.array_push(obj({ role_id: ref("tenant.id"), name: c.text("Maya Chen"), email: c.text("Maya@Example.com") })))),
      s.function.call({ fn: instantiateFn, as: "made", input: { template_id: ref("tpl.id"), sender_id: ref("sender.id"), people: ref("people"), origin_key: c.text("test:1") } }),
      s.db.get({ table: envelope, fieldValue: ref("made.envelope_id"), as: "copy" }),
      s.expect.to_equal({ expr: ref("copy.is_template"), value: c.bool(false) }),
      s.expect.to_equal({ expr: ref("copy.template_id"), value: ref("tpl.id") }),
      s.expect.to_equal({ expr: ref("copy.status"), value: c.text("draft") }),
      s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("copy.id")), cmp(col("role_name"), "=", c.text("Tenant"))], returnType: "single", as: "maya" }),
      s.expect.to_equal({ expr: ref("maya.email"), value: c.text("maya@example.com") }),
      s.db.query({ table: recipient, where: [cmp(col("envelope_id"), "=", ref("copy.id")), cmp(col("role_name"), "=", c.text("Landlord"))], returnType: "single", as: "jordan" }),
      s.expect.to_equal({ expr: ref("jordan.email"), value: c.text("jordan@fernhill-test.example") }),
      s.db.query({ table: field, where: [cmp(col("envelope_id"), "=", ref("copy.id")), cmp(col("recipient_id"), "=", ref("maya.id"))], returnType: "single", as: "maya_field" }),
      s.expect.to_equal({ expr: ref("maya_field.x"), value: c.decimal(0.1) }),
      s.db.query({ table: field, where: [cmp(col("envelope_id"), "=", ref("copy.id")), cmp(col("recipient_id"), "=", ref("jordan.id"))], returnType: "count", as: "jordan_fields" }),
      s.expect.to_equal({ expr: ref("jordan_fields"), value: c.int(1) }),
      s.function.call({ fn: instantiateFn, as: "again", input: { template_id: ref("tpl.id"), sender_id: ref("sender.id"), people: ref("people"), origin_key: c.text("test:1") } }),
      s.expect.to_equal({ expr: ref("again.envelope_id"), value: ref("copy.id") }),
      s.expect.to_be_true({ expr: ref("again.repeat") }),
    ],
  }),
  plainWorkflowTest({
    name: "templates: a public link that's off says so, and works again when turned back on",
    description: "The brief answers off while the link is disabled and ok at the same address once enabled; an unknown address is not_found.",
    stack: [
      person("sender"),
      ...leaseTemplate("sender"),
      s.db.add({ table: public_link, as: "link", row: { template_id: ref("tpl.id"), slug: c.text("lease-test-slug"), enabled: c.bool(false), uses: c.int(0) } }),
      s.function.call({ fn: publicBriefFn, as: "off", input: { slug: c.text("lease-test-slug") } }),
      s.expect.to_equal({ expr: ref("off.state"), value: c.text("off") }),
      s.db.patch({ table: public_link, fieldValue: ref("link.id"), data: obj({ enabled: c.bool(true) }), as: "on" }),
      s.function.call({ fn: publicBriefFn, as: "open", input: { slug: c.text("lease-test-slug") } }),
      s.expect.to_equal({ expr: ref("open.state"), value: c.text("ok") }),
      s.expect.to_equal({ expr: ref("open.role_name"), value: c.text("Tenant") }),
      s.function.call({ fn: publicBriefFn, as: "nothing", input: { slug: c.text("no-such-link") } }),
      s.expect.to_equal({ expr: ref("nothing.state"), value: c.text("not_found") }),
    ],
  }),
  plainWorkflowTest({
    name: "templates: a public visitor without the right code gets no document and no signing link",
    description: "A wrong code answers wrong_code, and no envelope is made from the template.",
    stack: [
      person("sender"),
      ...leaseTemplate("sender"),
      s.db.add({ table: public_link, as: "link", row: { template_id: ref("tpl.id"), slug: c.text("lease-code-slug"), enabled: c.bool(true), uses: c.int(0) } }),
      s.function.call({ fn: publicStartFn, as: "started", input: { slug: c.text("lease-code-slug"), name: c.text("Visitor"), email: c.text("visitor@example.com"), ip: c.text("10.0.0.1") } }),
      s.function.call({ fn: publicVerifyFn, as: "guessed", input: { slug: c.text("lease-code-slug"), name: c.text("Visitor"), email: c.text("visitor@example.com"), code: c.text("000000"), ip: c.text("10.0.0.1") } }),
      s.expect.to_equal({ expr: ref("guessed.state"), value: c.text("wrong_code") }),
      s.db.query({ table: envelope, where: cmp(col("template_id"), "=", ref("tpl.id")), returnType: "count", as: "copies" }),
      s.expect.to_equal({ expr: ref("copies"), value: c.int(0) }),
    ],
  }),
  plainWorkflowTest({
    name: "templates: a fourth code for the same address within the hour is refused, even from another IP",
    description: "Three code requests go through; the fourth, from a different IP, answers rate_limited.",
    stack: [
      person("sender"),
      ...leaseTemplate("sender"),
      s.db.add({ table: public_link, as: "link", row: { template_id: ref("tpl.id"), slug: c.text("lease-flood-slug"), enabled: c.bool(true), uses: c.int(0) } }),
      ...[1, 2, 3].map((n) => s.function.call({ fn: publicStartFn, as: `try_${n}`, input: { slug: c.text("lease-flood-slug"), name: c.text("Visitor"), email: c.text("flood@example.com"), ip: c.text(`10.0.1.${n}`) } })),
      s.expect.to_not_equal({ expr: ref("try_3.state"), value: c.text("rate_limited") }),
      s.function.call({ fn: publicStartFn, as: "try_4", input: { slug: c.text("lease-flood-slug"), name: c.text("Visitor"), email: c.text("flood@example.com"), ip: c.text("10.0.9.9") } }),
      s.expect.to_equal({ expr: ref("try_4.state"), value: c.text("rate_limited") }),
    ],
  }),
  workflowTest({
    name: "templates: a bulk send sends each good row once, and keeps bad rows as failed with a reason",
    description: "Four rows with one bad email: three envelopes go out, one row fails naming the role, and a batch run again after stopping part-way sends nobody a second copy.",
    stack: [
      org(),
      person("sender"),
      ...leaseTemplate("sender"),
      s.set_var("rows", c.array([])),
      ...["ana@bulk.example", "ben@bulk.example", "not-an-email", "cy@bulk.example"].flatMap((email, i) => [
        s.set_var(`p${i}`, obj({ role_id: ref("tenant.id"), name: c.text(`Person ${i + 1}`), email: c.text(email) })),
        s.set_var(`ps${i}`, withFilters(c.array([]), fl.array_push(ref(`p${i}`)))),
        s.set_var(`row${i}`, obj({ line: c.int(i + 2), people: ref(`ps${i}`) })),
        s.update_var("rows", withFilters(ref("rows"), fl.array_push(ref(`row${i}`)))),
      ]),
      s.function.call({ fn: bulkCreateFn, as: "bulk", input: { actor_id: ref("sender.id"), template_id: ref("tpl.id"), rows: ref("rows") } }),
      s.expect.to_equal({ expr: ref("bulk.failed"), value: c.int(1) }),
      s.function.call({ fn: bulkStepFn, as: "first" }),
      // As if a batch stopped after making a row's envelope but before marking the row: running again finds that envelope.
      s.db.query({ table: bulk_send_row, where: [cmp(col("bulk_send_id"), "=", ref("bulk.bulk_send_id")), cmp(col("status"), "=", c.text("sent"))], returnType: "single", as: "a_sent" }),
      s.db.patch({ table: bulk_send_row, fieldValue: ref("a_sent.id"), data: obj({ status: c.text("pending") }), as: "rewound" }),
      s.db.patch({ table: bulk_send, fieldValue: ref("bulk.bulk_send_id"), data: obj({ status: c.text("running"), finished_at: c.null() }), as: "reopened" }),
      s.function.call({ fn: bulkStepFn, as: "second" }),
      s.db.query({ table: envelope, where: [cmp(col("bulk_send_id"), "=", ref("bulk.bulk_send_id")), cmp(col("status"), "=", c.text("in_progress"))], returnType: "count", as: "out" }),
      s.expect.to_equal({ expr: ref("out"), value: c.int(3) }),
      s.db.query({ table: envelope, where: cmp(col("bulk_send_id"), "=", ref("bulk.bulk_send_id")), returnType: "count", as: "made" }),
      s.expect.to_equal({ expr: ref("made"), value: c.int(3) }),
      s.db.query({ table: bulk_send_row, where: [cmp(col("bulk_send_id"), "=", ref("bulk.bulk_send_id")), cmp(col("status"), "=", c.text("failed"))], returnType: "single", as: "bad" }),
      s.expect.to_equal({ expr: ref("bad.line"), value: c.int(4) }),
      s.expect.to_equal({ expr: ref("bad.error"), value: c.text("Check the email for Tenant.") }),
      s.db.get({ table: bulk_send, fieldValue: ref("bulk.bulk_send_id"), as: "after" }),
      s.expect.to_equal({ expr: ref("after.status"), value: c.text("done") }),
      s.expect.to_equal({ expr: ref("after.sent"), value: c.int(3) }),
    ],
  }),
];
