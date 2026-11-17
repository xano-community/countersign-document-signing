import { f, table } from "@xano/sdk";
import { SEED_FIELDS } from "../../world.js";
import { envelope } from "./envelope.js";
import { recipient } from "./recipient.js";

export const FIELD_TYPES = ["signature", "initials", "name", "email", "date", "text", "number", "checkbox", "radio", "dropdown"] as const;

/**
 * A place on the document one recipient fills in. Position is a fraction of the displayed page (0–1 from its top-left),
 * so it lines up at any zoom; the seal turns it into PDF points for the page's rotation and crop.
 */
export const field = table({
  name: "field",
  description: "A field on an envelope's document, owned by one recipient.",
  schema: {
    envelope_id: f.tableRef(envelope, { required: true }),
    recipient_id: f.tableRef(recipient, { required: true }),
    type: f.enum(FIELD_TYPES, { required: true }),
    page: f.int({ required: true }),
    x: f.decimal({ required: true }),
    y: f.decimal({ required: true }),
    w: f.decimal({ required: true }),
    h: f.decimal({ required: true }),
    required: f.bool({ default: true }),
    label: f.text(),
    /** Radio and dropdown choices, as a list of strings. */
    options: f.json(),
    /** { max_length, min, max } where they apply. */
    validation: f.json(),
    value: f.text({ nullable: true }),
    filled_at: f.timestamp({ nullable: true }),
  },
  seed: SEED_FIELDS,
  index: [
    { type: "btree", fields: [{ name: "envelope_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "recipient_id", op: "asc" }] },
  ],
});
