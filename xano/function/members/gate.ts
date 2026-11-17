// A person's token stays valid until it expires, so removing someone has to be enforced on every call: each
// signed-in group runs this first, and a removed person is refused at once (their open tab signs out on the 401).
import { auth, c, expr, guard, middleware, ref, s } from "@xano/sdk";
import { user } from "../../table/user.js";

export const gateActive = middleware({
  name: "members/gate_active",
  exceptionPolicy: "rethrow",
  description: "Refuses a signed-in caller whose member row is gone or removed.",
  stack: [
    s.db.get({ table: user, fieldValue: auth("id"), output: ["id", "status"], as: "gate_me" }),
    guard.require(expr(ref("gate_me.status", { safe: true }), "=", c.text("active")), { errorType: "unauthorized", message: "Your access to this workspace has ended." }),
  ],
});
