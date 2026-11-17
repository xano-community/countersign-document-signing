import { defineApprovals } from "@xano-sdk/agents";
import { user } from "./table/user.js";
import { rbac } from "./rbac.js";
import { useTemplateFn } from "./function/templates/templates.js";
import { voidFn } from "./function/envelope/manage.js";

/**
 * What an agent asks a person's OK for (AGENT-APPROVALS.md): one entry per action, each a function that does the
 * thing as `actor_id` and re-checks that person's permission. `change_role` is the base app's (an agent asks, a
 * team manager decides; rbac's own set_role runs it). A template adds its domain's actions beside it, and seeds one
 * waiting request for the main persona.
 */
export const approvals = defineApprovals({
  user,
  canonical: "approvals",
  actions: {
    change_role: { fn: rbac.setRoleFn, label: "Change role", editable: "role", approvers: rbac.rolesWith("team.manage") },
    // An agent's send or cancel waits for the person who connected it. The function re-checks their permission when it runs.
    send_from_template: { fn: useTemplateFn, label: "Send it", editable: "title" },
    void_envelope: { fn: voidFn, label: "Cancel the document", editable: "reason" },
  },
  seed: [],
});
