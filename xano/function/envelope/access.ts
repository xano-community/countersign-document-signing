// Who sees an envelope. Every read of an envelope, its documents and its trail asks this one function, so the rule lives in one place:
// the person who sent it, anyone who reads the team's envelopes when it's shared with the team, and anyone who reads them all.
import { c, defineFunction, expr, inp, input, ref, s } from "@xano/sdk";
import { rbac } from "../../rbac.js";
import { envelope } from "../../table/envelope/envelope.js";
import { user } from "../../table/user.js";

export const canRead = defineFunction({
  name: "envelope/can_read",
  description: "Whether a member may see an envelope: they sent it, it's shared with the team and they read the team's, or they read all.",
  input: { actor_id: input.int({ required: true }), envelope_id: input.int({ required: true }) },
  stack: [
    s.set_var("allowed", c.bool(false)),
    s.db.get({ table: envelope, fieldValue: inp("envelope_id"), output: ["id", "sender_id", "visibility"], as: "env" }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role", "status"], as: "reader" }),
    s.conditional({ when: expr(ref("env"), "!=", c.null()), then: [
      s.conditional({ when: expr(ref("reader.status", { safe: true }), "=", c.text("active")), then: [
        s.conditional({ when: expr(ref("env.sender_id", { safe: true }), "=", inp("actor_id")), then: [s.update_var("allowed", c.bool(true))] }),
        s.conditional({ when: expr(ref("env.visibility", { safe: true }), "=", c.text("team")), then: [
          s.conditional({ when: rbac.has(ref("reader.role", { safe: true }), "envelope.read_team"), then: [s.update_var("allowed", c.bool(true))] }),
        ] }),
        s.conditional({ when: rbac.has(ref("reader.role", { safe: true }), "envelope.read_all"), then: [s.update_var("allowed", c.bool(true))] }),
      ] }),
    ] }),
  ],
  response: ref("allowed"),
  responseShape: false as boolean,
});
