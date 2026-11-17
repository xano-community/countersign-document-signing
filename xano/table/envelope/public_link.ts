import { f, table } from "@xano/sdk";
import { SEED_PUBLIC_LINKS } from "../../world.js";
import { envelope } from "./envelope.js";

/** A template's public signing link. Anyone who opens it signs as the template's first role after proving their email. */
export const public_link = table({
  name: "public_link",
  description: "A public link that starts a fresh envelope from a template.",
  schema: {
    template_id: f.tableRef(envelope, { required: true }),
    /** The random part of the URL. It's public by design: the link is meant to be shared. */
    slug: f.text({ required: true }),
    enabled: f.bool({ default: true }),
    created_by: f.int(),
    uses: f.int(),
  },
  seed: SEED_PUBLIC_LINKS,
  index: [
    { type: "btree|unique", fields: [{ name: "slug", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "template_id", op: "asc" }] },
  ],
});
