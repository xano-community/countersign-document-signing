// Signing over HTTP. `sign` is public: a recipient brings their link token, proves who they are, consents, and gets a short
// signer session. `signing` takes that session, and every route runs the signer gate first.
import { apiGroup, auth, c, expr, fl, guard, inp, input, query, ref, respond, s, sys, withFilters } from "@xano/sdk";
import { recipient } from "../table/envelope/recipient.js";
import { document_blob, document_file } from "../table/files/document_file.js";
import { envelope } from "../table/envelope/envelope.js";
import { giveConsent, openLink, sendCode, verifyIdentity } from "../function/signing/open.js";
import { adoptMark, declineSigning, fillField, finishSigning, signerGate, signerState } from "../function/signing/sign.js";
import { advanceFn } from "../function/envelope/send.js";
import { sealKick } from "../function/seal/build.js";
import { demoSignerFn } from "../function/demo/world.js";

export const signGroup = apiGroup({ name: "sign", canonical: "sign", description: "A recipient's way in: their link, identity check and consent." });
export const signingGroup = apiGroup({ name: "signing", canonical: "signing", middleware: { pre: [signerGate] }, description: "Signing, inside a signer session." });

const ua = () => s.set_var("user_agent", withFilters(sys.httpHeaders(), fl.get("User-Agent", "")));
const req = () => ({ token: inp("token"), ip: sys.remoteIp(), user_agent: ref("user_agent") });
const signer = () => ({ recipient_id: auth("id"), ip: sys.remoteIp(), user_agent: ref("user_agent") });
/** The signing page never leaks its link: no referrer leaves it. */
const noReferrer = respond.header("Referrer-Policy", "no-referrer");

export const openRoute = query({
  apiGroup: signGroup, name: "sign/open", verb: "POST",
  description: "Open a signing link: what this recipient sees next.",
  input: { token: input.text({ required: true }) },
  stack: [ua(), noReferrer, s.function.run({ fn: openLink, as: "opened", input: req() })],
  response: ref("opened"), history: false,
});

export const sendCodeRoute = query({
  apiGroup: signGroup, name: "sign/code", verb: "POST",
  description: "Email this recipient a one-time code.",
  input: { token: input.text({ required: true }) },
  stack: [ua(), noReferrer, s.function.run({ fn: sendCode, as: "sent", input: req() })],
  response: ref("sent"), history: false,
});

export const identityRoute = query({
  apiGroup: signGroup, name: "sign/identity", verb: "POST",
  description: "Check an access code or an emailed code.",
  input: { token: input.text({ required: true }), code: input.text({ methods: ["trim"] }) },
  stack: [ua(), noReferrer, s.function.run({ fn: verifyIdentity, as: "checked", input: { ...req(), code: inp("code") } })],
  response: ref("checked"), history: false,
});

export const consentRoute = query({
  apiGroup: signGroup, name: "sign/consent", verb: "POST",
  description: "Agree to sign electronically, and start a signing session.",
  input: { token: input.text({ required: true }), disclosure_version: input.int({ required: true }), agree: input.bool() },
  stack: [ua(), noReferrer, s.function.run({ fn: giveConsent, as: "agreed", input: { ...req(), disclosure_version: inp("disclosure_version"), agree: inp("agree") } })],
  response: ref("agreed"), history: false,
});

export const stateRoute = query({
  apiGroup: signingGroup, auth: recipient, name: "signing/state", verb: "GET",
  description: "The document's pages, this signer's fields, and what others have filled in.",
  stack: [ua(), noReferrer, s.function.run({ fn: signerState, as: "state", input: signer() })],
  response: ref("state"),
});

/** How the signer gets the document's bytes: a short signed link, or the raw route on a deployment that keeps them in a table. */
export const documentRoute = query({
  apiGroup: signingGroup, auth: recipient, name: "signing/document", verb: "GET",
  description: "How to load the document for signing.",
  stack: [
    s.db.get({ table: recipient, fieldValue: auth("id"), output: ["envelope_id"], as: "me" }),
    guard.found("me", { errorType: "unauthorized", message: "This link no longer works." }),
    s.db.get({ table: envelope, fieldValue: ref("me.envelope_id"), output: ["original_file_id"], as: "env" }),
    guard.found("env", { errorType: "notfound", message: "That document doesn't exist." }),
    s.db.get({ table: document_file, fieldValue: ref("env.original_file_id"), output: ["id", "mode", "attachment"], as: "doc" }),
    s.set_var("how", c.text("table")),
    s.set_var("url", c.null()),
    s.conditional({ when: expr(ref("doc.mode", { safe: true }), "=", c.text("signed")), then: [
      s.try_catch({
        try: [s.storage.sign_private_url({ pathname: ref("doc.attachment.path", { safe: true }), ttl: c.int(120), as: "signed" }), s.update_var("url", ref("signed")), s.update_var("how", c.text("signed"))],
        catch: [s.update_var("how", c.text("unavailable"))],
      }),
    ] }),
  ],
  response: { how: ref("how"), url: ref("url") },
});

export const documentRawRoute = query({
  apiGroup: signingGroup, auth: recipient, name: "signing/document/raw", verb: "GET",
  description: "The document's bytes, on a deployment that keeps them in a table.",
  stack: [
    s.db.get({ table: recipient, fieldValue: auth("id"), output: ["envelope_id"], as: "me" }),
    guard.found("me", { errorType: "unauthorized", message: "This link no longer works." }),
    s.db.get({ table: envelope, fieldValue: ref("me.envelope_id"), output: ["original_file_id"], as: "env" }),
    guard.found("env", { errorType: "notfound", message: "That document doesn't exist." }),
    s.db.get({ table: document_blob, fieldName: "file_id", fieldValue: ref("env.original_file_id"), output: ["b64"], as: "blob" }),
    s.util.set_header({ value: c.text("Content-Type: application/pdf"), duplicates: "replace" }),
    respond.header("X-Content-Type-Options", "nosniff"),
    respond.header("Content-Security-Policy", "sandbox; default-src 'none'"),
    respond.header("Cache-Control", "private, no-store"),
    noReferrer,
    s.set_var("bytes", withFilters(ref("blob.b64", { safe: true }), fl.first_notnull(c.text("")), fl.base64_decode())),
  ],
  response: ref("bytes"), history: false,
});

export const fillRoute = query({
  apiGroup: signingGroup, auth: recipient, name: "signing/fill", verb: "POST",
  description: "Save a value for one of this signer's fields.",
  input: { field_id: input.int({ required: true }), value: input.text() },
  stack: [ua(), s.function.run({ fn: fillField, as: "saved", input: { ...signer(), field_id: inp("field_id"), value: inp("value") } })],
  response: ref("saved"),
});

export const adoptRoute = query({
  apiGroup: signingGroup, auth: recipient, name: "signing/adopt", verb: "POST",
  description: "Adopt a signature or initials.",
  input: { kind: input.text({ required: true }), method: input.text({ required: true }), png_b64: input.text({ required: true }) },
  stack: [ua(), s.function.run({ fn: adoptMark, as: "adopted", input: { ...signer(), kind: inp("kind"), method: inp("method"), png_b64: inp("png_b64") } })],
  response: ref("adopted"), history: false,
});

export const finishRoute = query({
  apiGroup: signingGroup, auth: recipient, name: "signing/finish", verb: "POST",
  description: "Finish signing. The next person is invited, or the document starts finishing.",
  input: { agree: input.bool(), timezone: input.text() },
  stack: [
    ua(),
    s.function.run({ fn: finishSigning, as: "done", input: { ...signer(), agree: inp("agree"), timezone: inp("timezone") } }),
    s.db.get({ table: recipient, fieldValue: auth("id"), output: ["id", "name", "email"], as: "me" }),
    guard.found("me", { errorType: "unauthorized", message: "This link no longer works." }),
    s.function.run({ fn: advanceFn, as: "next", input: {
      envelope_id: ref("done.envelope_id"), actor_type: c.text("recipient"), actor_id: ref("me.id"), actor_name: ref("me.name"), actor_email: ref("me.email"),
      ip: sys.remoteIp(), user_agent: ref("user_agent"),
    } }),
    // The last person is done: make the signed copy once this answer has gone.
    s.conditional({ when: expr(ref("next.finishing"), "=", c.bool(true)), then: [...sealKick(ref("done.envelope_id"))] }),
  ],
  response: { ok: c.bool(true), already: ref("done.already"), finishing: ref("next.finishing") },
});

export const declineRoute = query({
  apiGroup: signingGroup, auth: recipient, name: "signing/decline", verb: "POST",
  description: "Decline (or, for an approver, reject) the document.",
  input: { reason: input.text({ methods: ["trim"] }) },
  stack: [ua(), s.function.run({ fn: declineSigning, as: "declined", input: { ...signer(), reason: inp("reason") } })],
  response: ref("declined"),
});

export const demoSignerRoute = query({
  apiGroup: signGroup, name: "sign/demo", verb: "POST",
  description: "In demo mode: a signing page for the demo signer, so a visitor sees what a recipient sees.",
  stack: [noReferrer, s.function.run({ fn: demoSignerFn, as: "link" })],
  response: ref("link"), history: false,
});

export const signQueries = [demoSignerRoute, openRoute, sendCodeRoute, identityRoute, consentRoute, stateRoute, documentRoute, documentRawRoute, fillRoute, adoptRoute, finishRoute, declineRoute];
