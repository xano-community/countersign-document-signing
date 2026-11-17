// Resend's delivery webhook. Public (Resend has no account here), so nothing is believed until the Svix signature checks out.
// Point Resend at POST {api}/api:email_hooks/resend and put its signing secret in RESEND_WEBHOOK_SECRET.
import { apiGroup, c, env, expr, fl, query, ref, respond, s, sys, withFilters } from "@xano/sdk";
import { applyEventFn, svixVerifyFn } from "../function/email/hooks.js";

export const emailHooksGroup = apiGroup({ name: "email_hooks", canonical: "email_hooks", description: "Delivery webhooks from Resend. Signature-checked; no person auth." });

export type ResendHookResult = { ok: boolean; state: string; status: string };

export const resendHookRoute = query({
  apiGroup: emailHooksGroup, history: false,
  name: "resend", verb: "POST",
  description: "Resend delivery events (delivered, bounced, complained), verified with the Svix signature.",
  stack: [
    s.util.get_raw_input({ encoding: "none", as: "raw" }),
    s.set_var("headers", sys.httpHeaders()),
    s.function.run({ fn: svixVerifyFn, as: "check", input: {
      secret: env("RESEND_WEBHOOK_SECRET"), raw: ref("raw"), now_ms: c.int(0),
      id: withFilters(ref("headers"), fl.get(c.text("Svix-Id"), c.text(""))),
      timestamp: withFilters(ref("headers"), fl.get(c.text("Svix-Timestamp"), c.text(""))),
      signature: withFilters(ref("headers"), fl.get(c.text("Svix-Signature"), c.text(""))),
    } }),
    s.set_var("applied_status", c.text("")),
    s.conditional({
      when: expr(ref("check.ok"), "=", c.bool(true)),
      then: [
        s.function.run({ fn: applyEventFn, as: "applied", input: { event: withFilters(ref("raw"), fl.json_decode()) } }),
        s.update_var("applied_status", ref("applied.status")),
      ],
      // Not believed. 401 so Resend shows the failure and retries once the secret is right; 503 while none is set.
      else: [s.conditional({
        when: expr(ref("check.reason"), "=", c.text("missing_secret")),
        then: [respond.status(503)],
        else: [respond.status(401)],
      })],
    }),
  ],
  response: { ok: ref("check.ok"), state: ref("check.reason"), status: ref("applied_status") },
  responseShape: {} as ResendHookResult,
});

export const emailHookQueries = [resendHookRoute];
