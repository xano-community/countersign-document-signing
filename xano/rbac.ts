import { defineRbac } from "@xano-sdk/rbac";
import { c, cmp, col, inp, or, s } from "@xano/sdk";
import { user } from "./table/user.js";

/** Who may do what (RBAC.md). Roles are user.role's values (xano/app.ts ROLES). `team.manage` is required. */
export const rbac = defineRbac({
  user,
  canonical: "rbac",
  permissions: {
    // Prepare, send and manage envelopes and templates.
    "envelope.send": ["admin", "member"],
    // Read envelopes the team can see (a member's own are always theirs).
    "envelope.read_team": ["admin", "member", "viewer"],
    // Every envelope, private ones included.
    "envelope.read_all": ["admin"],
    "template.manage": ["admin", "member"],
    // Branding, email, signing defaults, the disclosure and retention.
    "settings.manage": ["admin"],
    // API keys and webhooks.
    "developer.manage": ["admin"],
    "team.manage": ["admin"],
  },
});

// Removing someone (function/settings/org.ts) keeps their row for the record, with status "removed". The rbac module's team list
// reads every row, so its query is swapped for the same one that leaves removed people out.
const memberList = rbac.endpoints.members as unknown as { stack: unknown[] };
memberList.stack[memberList.stack.length - 1] = s.db.query({
  table: user,
  where: [cmp(col("status"), "=", c.text("active")), or(cmp(col("name"), "includes", inp("q"), { ignoreEmpty: true }), cmp(col("email"), "includes", inp("q"), { ignoreEmpty: true }))],
  sort: [{ sortBy: "name", dir: "asc" }],
  output: ["items.id", "items.name", "items.email", "items.role", "items.created_at", "curPage", "nextPage", "prevPage", "itemsTotal", "pageTotal"],
  paging: { page: inp("page"), per_page: 50, metadata: true, totals: true },
  as: "rows",
});
