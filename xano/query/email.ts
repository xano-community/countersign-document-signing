// Email settings over HTTP: whether email is ready, and the test-email button. Thin routes; the work is in function/email.
import { apiGroup, auth, c, inp, input, query, ref, s } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { emailStatusFn, type EmailState } from "../function/email/status.js";
import { sendTestFn } from "../function/email/drain.js";
import { rememberUrls } from "../function/settings/app_url.js";

export const emailGroup = apiGroup({ name: "email", canonical: "email", middleware: { pre: [gateActive] }, description: "Email settings: readiness and a test send." });

export type EmailStatus = { state: EmailState; can_send: boolean; key_set: boolean; from_set: boolean; tracking: boolean };
export type EmailTestResult = { ok: boolean; state: EmailState; status: string; error: string; resend_id: string; to: string };

/** Anyone signed in may read it: prepare screens switch off the emailed code and public links when mail can't go out. */
export const emailStatusRoute = query({
  apiGroup: emailGroup, auth: user,
  name: "email/status", verb: "GET",
  description: "Whether email is ready: ready, missing_key, missing_from or webhook_missing. Never shows a key.",
  stack: [...rbac.signedIn(), s.function.run({ fn: emailStatusFn, as: "status", input: { test_key: c.text(""), test_from: c.text(""), test_webhook: c.text("") } })],
  response: ref("status"),
  responseShape: {} as EmailStatus,
});

export const emailTestRoute = query({
  apiGroup: emailGroup, auth: user, history: false,
  name: "email/test", verb: "POST",
  description: "Send a test email to yourself now, and see Resend's exact answer.",
  input: { app_url: input.text() },
  stack: [
    ...rbac.require("settings.manage", "Only admins can send a test email."),
    ...rememberUrls(inp("app_url")),
    s.function.run({ fn: sendTestFn, as: "result", input: { actor_id: auth("id"), test_key: c.text(""), test_from: c.text("") } }),
  ],
  response: ref("result"),
  responseShape: {} as EmailTestResult,
});

export const emailQueries = [emailStatusRoute, emailTestRoute];
