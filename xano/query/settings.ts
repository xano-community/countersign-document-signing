// The organisation's settings over HTTP (admins), the export, and removing someone from the team. Thin routes over function/settings.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { clearDemoFn, exportRecordsFn, readOrgFn, removeMemberFn, saveDisclosureFn, updateOrgFn } from "../function/settings/org.js";

export const orgGroup = apiGroup({ name: "org", canonical: "org", middleware: { pre: [gateActive] }, description: "The organisation's branding, defaults, disclosure, retention and team removal." });

export const readOrgRoute = query({
  apiGroup: orgGroup, auth: user, name: "org", verb: "GET", description: "The organisation's settings and current disclosure.",
  stack: [...rbac.signedIn(), s.function.run({ fn: readOrgFn, as: "org", input: { actor_id: auth("id") } })], response: ref("org"),
});
export const updateOrgRoute = query({
  apiGroup: orgGroup, auth: user, name: "org", verb: "PATCH", description: "Change the organisation's settings.",
  input: {
    org_name: input.text({ methods: ["trim"] }), logo_data_url: input.text(), accent: input.text(), email_sender_name: input.text({ methods: ["trim"] }),
    reply_to: input.text({ methods: ["trim", "lower"] }), default_expiry_days: input.int(), default_reminder_days: input.int(), retention_days: input.int(), demo_mode: input.bool(),
  },
  stack: [...rbac.signedIn(), s.function.run({ fn: updateOrgFn, as: "saved", input: {
    actor_id: auth("id"), org_name: inp("org_name"), logo_data_url: inp("logo_data_url"), accent: inp("accent"), email_sender_name: inp("email_sender_name"), reply_to: inp("reply_to"),
    default_expiry_days: inp("default_expiry_days"), default_reminder_days: inp("default_reminder_days"), retention_days: inp("retention_days"), demo_mode: inp("demo_mode"),
  } })],
  response: ref("saved"),
});
export const disclosureRoute = query({
  apiGroup: orgGroup, auth: user, name: "org/disclosure", verb: "POST", description: "Publish a new version of the consent disclosure.",
  input: { text: input.text({ methods: ["trim"] }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: saveDisclosureFn, as: "saved", input: { actor_id: auth("id"), text: inp("text") } })], response: ref("saved"),
});
export const clearDemoRoute = query({
  apiGroup: orgGroup, auth: user, name: "org/clear_demo", verb: "POST", description: "Delete every demo document and template.",
  stack: [...rbac.signedIn(), s.function.run({ fn: clearDemoFn, as: "cleared", input: { actor_id: auth("id") } })], response: ref("cleared"),
});
export const exportRoute = query({
  apiGroup: orgGroup, auth: user, name: "org/export", verb: "GET", description: "Every document's record, with its people.",
  stack: [...rbac.signedIn(), s.function.run({ fn: exportRecordsFn, as: "records", input: { actor_id: auth("id") } })], response: ref("records"), history: false,
});
export const removeMemberRoute = query({
  apiGroup: orgGroup, auth: user, name: "members/{id}/remove", verb: "POST", description: "Remove someone from the team.",
  input: { id: input.int({ required: true }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: removeMemberFn, as: "done", input: { actor_id: auth("id"), user_id: inp("id") } })], response: ref("done"),
});

export const orgQueries = [readOrgRoute, updateOrgRoute, disclosureRoute, clearDemoRoute, exportRoute, removeMemberRoute];
