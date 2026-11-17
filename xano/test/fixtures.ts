// What every Countersign workflow test builds on. A test run starts with an empty database, so each test makes its own rows.
import { c, ref, s, workflowTest as sdkWorkflowTest } from "@xano/sdk";
import { user } from "../table/user.js";
import { envelope } from "../table/envelope/envelope.js";
import { recipient } from "../table/envelope/recipient.js";

// A test reads rows it just made, and a missing row should fail that test: the null-safety warning doesn't apply.
export const workflowTest: typeof sdkWorkflowTest = (def) => sdkWorkflowTest({ ...def, diagnostics: { allow: ["stack.drill-maybe-null"] } });

export const person = (key: string, role = "member") => s.db.add({ table: user, as: key, row: {
  name: c.text(`Test ${key}`), email: c.text(`${key}@countersign-test.example`), password: c.text("Count-test-1"), role: c.text(role), status: c.text("active"),
} });

export const draft = (as: string, sender: string, title = "Test lease", extra: Record<string, ReturnType<typeof c.text> | ReturnType<typeof c.int>> = {}) =>
  s.db.add({ table: envelope, as, row: { public_id: c.text(`T-${as}-${title}`), title: c.text(title), status: c.text("draft"), sender_id: ref(`${sender}.id`), expiry_days: c.int(30), ...extra } });

export const signer = (as: string, env: string, email: string, step = 1, role = "signer") =>
  s.db.add({ table: recipient, as, row: { envelope_id: ref(`${env}.id`), name: c.text(email.split("@")[0]), email: c.text(email), role: c.text(role), step: c.int(step), status: c.text("waiting"), round: c.int(1) } });
