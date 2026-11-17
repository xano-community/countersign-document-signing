// The one-minute sweep: background work that must happen whether or not anyone is using the app. Each step is a function
// that is safe to run again, and runs on its own: one step failing doesn't stop the rest. Add a step by adding it to
// `SWEEP_STEPS` (expiry and reminders before mail, so their emails go out in the same minute).
import { s, task as scheduledTask, type FunctionDef } from "@xano/sdk";
import { drainFn, markStuckFn } from "../function/email/drain.js";
import { dueExpiriesFn, dueRemindersFn } from "../function/envelope/manage.js";
import { sealDue } from "../function/seal/build.js";
import { bulkStepFn } from "../function/templates/bulk.js";
import { deliverDueFn } from "../function/developer/webhooks.js";
import { buildWorldFn } from "../function/demo/world.js";

type Step = { as: string; fn: FunctionDef<any, any, any> };

/** In order. Emails stuck in sending are settled before the drain looks for due mail. */
export const SWEEP_STEPS: Step[] = [
  // Once, after a deploy with the demo: the seeded documents' history, before anything else looks at them.
  { as: "world", fn: buildWorldFn },
  { as: "expiries", fn: dueExpiriesFn },
  { as: "reminders", fn: dueRemindersFn },
  { as: "seals", fn: sealDue },
  { as: "bulk", fn: bulkStepFn },
  { as: "webhooks", fn: deliverDueFn },
  { as: "email_stuck", fn: markStuckFn },
  { as: "email_drain", fn: drainFn },
];

export const sweepEveryMinute = scheduledTask({
  name: "sweep/every_minute",
  description: "Expire late envelopes, send due reminders, finish stalled seals, send bulk batches and webhooks, settle stuck emails and send what's due.",
  schedule: [{ startsOn: "2026-01-01 00:00:00+0000", freq: 60 }],
  stack: SWEEP_STEPS.map((step) => s.try_catch({ try: [s.function.run({ fn: step.fn, as: step.as })] })),
});

export const tasks = [sweepEveryMinute];
