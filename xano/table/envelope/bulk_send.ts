import { f, table } from "@xano/sdk";
import { envelope } from "./envelope.js";

/** One template sent to many people from a CSV. Rows are worked through in small batches by the sweep. */
export const bulk_send = table({
  name: "bulk_send",
  description: "A bulk send of one template.",
  schema: {
    template_id: f.tableRef(envelope, { required: true }),
    sender_id: f.int({ required: true }),
    title: f.text(),
    status: f.enum(["running", "done", "cancelled"], { default: "running" }),
    total: f.int(),
    sent: f.int(),
    failed: f.int(),
    finished_at: f.timestamp({ nullable: true }),
  },
});

export const bulk_send_row = table({
  name: "bulk_send_row",
  description: "One person (or group of people) in a bulk send, and what became of them.",
  schema: {
    bulk_send_id: f.tableRef(bulk_send, { required: true }),
    line: f.int({ required: true }),
    /** { role name: { name, email } } for each of the template's roles. */
    people: f.json(),
    status: f.enum(["pending", "sent", "failed"], { default: "pending" }),
    envelope_id: f.int(),
    error: f.text(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "bulk_send_id", op: "asc" }, { name: "line", op: "asc" }] },
    { type: "btree", fields: [{ name: "status", op: "asc" }] },
  ],
});
