// Whether email can go out, as a state rather than an error. A missing key or From address is normal on a fresh install: mail
// then waits as links to copy. This reads only whether each setting is present, never its value.
//
// The `test_*` inputs exist for workflow tests, which can't set env vars: a test passes a stand-in key and From to exercise
// the "email is set up" path. Production callers never pass them, so production always reads the env.
import { c, defineFunction, env, expr, fl, inp, input, ref, s, withFilters } from "@xano/sdk";

export const EMAIL_STATES = ["ready", "missing_key", "missing_from", "webhook_missing"] as const;
export type EmailState = (typeof EMAIL_STATES)[number];

/** The stand-in settings a workflow test may pass instead of the env. Never passed in production. */
export const testOverrideInputs = { test_key: input.text(), test_from: input.text(), test_webhook: input.text() };

const lengthOf = (override: string, name: "RESEND_API_KEY" | "RESEND_FROM" | "RESEND_WEBHOOK_SECRET") =>
  withFilters(inp(override), fl.first_notempty(env(name)), fl.first_notnull(c.text("")), fl.trim(), fl.strlen());

export const emailStatusFn = defineFunction({
  name: "email/status",
  description: "Whether email is ready: ready, missing_key, missing_from or webhook_missing. Never returns a value.",
  input: testOverrideInputs,
  stack: [
    s.set_var("key_len", lengthOf("test_key", "RESEND_API_KEY")),
    s.set_var("from_len", lengthOf("test_from", "RESEND_FROM")),
    s.set_var("hook_len", lengthOf("test_webhook", "RESEND_WEBHOOK_SECRET")),
    s.set_var("state", c.text("ready")),
    s.conditional({
      when: expr(ref("key_len"), "<", c.int(1)),
      then: [s.update_var("state", c.text("missing_key"))],
      elif: [
        { when: expr(ref("from_len"), "<", c.int(1)), then: [s.update_var("state", c.text("missing_from"))] },
        { when: expr(ref("hook_len"), "<", c.int(1)), then: [s.update_var("state", c.text("webhook_missing"))] },
      ],
    }),
  ],
  response: {
    state: ref("state"),
    /** A key and a From address are both set, so mail can be sent. */
    can_send: c.expression("$var.key_len > 0 && $var.from_len > 0"),
    key_set: c.expression("$var.key_len > 0"),
    from_set: c.expression("$var.from_len > 0"),
    /** Delivered, bounced and complained states need the Resend webhook's signing secret. */
    tracking: c.expression("$var.hook_len > 0"),
  },
});
