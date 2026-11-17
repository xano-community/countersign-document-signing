// The signed copy over HTTP. Each route is a thin wrapper around its function in function/seal/.
//
// - `seal` (public): the seal lambda's loopback. It reads the original and posts the signed copy back with the envelope's
//   one-time seal key in `X-Seal-Key`. Anything else gets a 404. Never called by a browser.
// - `verify` (public): does a file's fingerprint match a completed envelope.
// - `final` (public): a party's personal download, by the token in their completion email.
// - Members' downloads and Retry live in the `documents` group beside the original's.
// - `seal-check` (TEST ONLY): see function/seal/fixture.ts. Off unless SEAL_CHECK_FIXTURES is "on".
import { apiGroup, auth, c, env, expr, fl, inp, input, obj, query, ref, respond, s, sys, withFilters, type Value } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { envelope } from "../table/envelope/envelope.js";
import { org_setting } from "../table/envelope/org_setting.js";
import { user } from "../table/user.js";
import { documentsGroup } from "./documents.js";
import { sealBuild, sealKick, sealRetry, type BuildAnswer } from "../function/seal/build.js";
import {
  finalForToken, memberAuditPdf, memberFinal, memberZip, sealOriginal, sealStoreFinal, verifyFinal,
  type FinalAnswer, type MemberFinal, type VerifyAnswer,
} from "../function/seal/files.js";

export const sealGroup = apiGroup({ name: "seal", canonical: "seal", description: "Internal: how the seal lambda reads an original and stores the signed copy." });
export const verifyGroup = apiGroup({ name: "verify", canonical: "verify", description: "Public: check a PDF's fingerprint against completed envelopes." });
export const finalGroup = apiGroup({ name: "final", canonical: "final", description: "Public: a party's personal download of the signed copy." });

const sealKey = () => withFilters(sys.httpHeaders(), fl.get("X-Seal-Key", ""));

/**
 * Raw bytes as a download. Each header is on purpose: the file always downloads, never renders on this origin, and isn't cached.
 * `name` is the file name to offer.
 */
const download = (b64: Value, name: Value, type = "application/pdf") => [
  s.set_var("plain_name", withFilters(c.text("/[^A-Za-z0-9._ -]+/u"), fl.regex_replace(c.text("_"), name))),
  s.set_var("encoded_name", withFilters(name, fl.url_encode_rfc3986())),
  s.util.set_header({ value: c.text(`Content-Type: ${type}`), duplicates: "replace" }),
  s.util.set_header({ value: withFilters(c.text('Content-Disposition: attachment; filename="'), fl.concat(ref("plain_name")), fl.concat(c.text(`"; filename*=UTF-8''`)), fl.concat(ref("encoded_name"))), duplicates: "replace" }),
  respond.header("X-Content-Type-Options", "nosniff"),
  respond.header("Content-Security-Policy", "sandbox; default-src 'none'"),
  respond.header("Cache-Control", "private, no-store"),
  respond.header("Referrer-Policy", "no-referrer"),
  s.set_var("bytes", withFilters(b64, fl.base64_decode())),
];

export const sealOriginalRoute = query({
  apiGroup: sealGroup, name: "seal/{envelope_id}/original", verb: "GET",
  description: "Internal: the original's bytes, for the seal lambda holding the envelope's seal key.",
  input: { envelope_id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: sealOriginal, as: "orig", input: { envelope_id: inp("envelope_id"), key: sealKey() } }),
    s.util.set_header({ value: c.text("Content-Type: application/pdf"), duplicates: "replace" }),
    respond.header("Cache-Control", "no-store"),
    s.set_var("bytes", withFilters(ref("orig.b64"), fl.base64_decode())),
  ],
  response: ref("bytes"),
  history: false,
});

export const sealFinalRoute = query({
  apiGroup: sealGroup, name: "seal/{envelope_id}/final", verb: "POST",
  description: "Internal: store the seal lambda's signed PDF (multipart `file`) for the envelope holding this seal key.",
  input: { envelope_id: input.int({ required: true }), file: input.file() },
  stack: [s.function.run({ fn: sealStoreFinal, as: "stored", input: { envelope_id: inp("envelope_id"), key: sealKey(), file: inp("file") } })],
  response: ref("stored"), responseShape: {} as { file_id: number; sha256: string; size: number },
  history: false,
});

/** `{ sha256, public_id? }`: the browser hashes the file and sends only the hash. Answers a state, always at 200. */
export const verifyRoute = query({
  apiGroup: verifyGroup, name: "verify", verb: "POST",
  description: "Check a PDF's SHA-256 against completed envelopes. Names who signed only when the public id matches too.",
  input: { sha256: input.text({ required: true }), public_id: input.text() },
  stack: [s.function.run({ fn: verifyFinal, as: "verdict", input: { sha256: inp("sha256"), public_id: inp("public_id"), ip: sys.remoteIp() } })],
  response: ref("verdict"), responseShape: {} as VerifyAnswer,
});

/** The organisation's name and logo, for the public verify and download pages. Nothing else about the deployment. */
export const brandRoute = query({
  apiGroup: verifyGroup, name: "brand", verb: "GET",
  description: "The organisation's name and logo, for public pages.",
  stack: [s.db.query({ table: org_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["org_name", "logo_data_url"], returnType: "single", as: "org" })],
  response: obj({ org_name: withFilters(ref("org.org_name", { safe: true }), fl.first_notempty(c.text("Countersign"))), logo: ref("org.logo_data_url", { safe: true }) }),
  responseShape: {} as { org_name: string; logo: string | null },
});

/** Ask this first, with the token from the email: what the link opens, and how to get the file now. */
export const finalLinkRoute = query({
  apiGroup: finalGroup, name: "sign/final", verb: "POST",
  description: "What a party's download link opens: the signed copy's details and how to download it now.",
  input: { token: input.text({ required: true }) },
  stack: [
    respond.header("Referrer-Policy", "no-referrer"),
    s.function.run({ fn: finalForToken, as: "found", input: { token: inp("token"), ip: sys.remoteIp(), with_bytes: c.bool(false) } }),
  ],
  response: obj({ state: ref("found.state"), how: ref("found.how"), url: ref("found.url"), name: ref("found.name"), retry_after: ref("found.retry_after"), envelope: ref("found.envelope") }),
  responseShape: {} as FinalAnswer,
  history: false,
});

/** The signed copy's bytes for a table-kept copy. Anything else answers the same JSON state as `sign/final`. */
export const finalRawRoute = query({
  apiGroup: finalGroup, name: "sign/final/raw", verb: "POST",
  description: "A party's signed copy, as a download.",
  input: { token: input.text({ required: true }) },
  stack: [
    s.function.run({ fn: finalForToken, as: "found", input: { token: inp("token"), ip: sys.remoteIp(), with_bytes: c.bool(true) } }),
    s.conditional({ when: expr(withFilters(ref("found.b64"), fl.first_notnull(c.text(""))), "=", c.text("")), then: [
      s.return(obj({ state: withFilters(ref("found.state"), fl.first_notnull(c.text("expired"))), how: ref("found.how"), url: ref("found.url"), name: c.null(), retry_after: ref("found.retry_after"), envelope: c.null() })),
    ] }),
    ...download(ref("found.b64"), ref("found.name")),
  ],
  response: ref("bytes"),
  responseShape: {} as string | Omit<FinalAnswer, "envelope"> & { envelope: null },
  history: false,
});

const id = () => input.int({ required: true });

export const memberFinalRoute = query({
  apiGroup: documentsGroup, auth: user, name: "envelopes/{id}/final", verb: "GET",
  description: "How to download an envelope's signed PDF right now.",
  input: { id: id() },
  stack: [...rbac.signedIn(), s.function.run({ fn: memberFinal, as: "link", input: { actor_id: auth("id"), envelope_id: inp("id"), with_bytes: c.bool(false) } })],
  response: obj({ state: ref("link.state"), how: ref("link.how"), url: ref("link.url"), name: ref("link.name") }),
  responseShape: {} as Omit<MemberFinal, "b64">,
});

export const memberFinalRawRoute = query({
  apiGroup: documentsGroup, auth: user, name: "envelopes/{id}/final/raw", verb: "GET",
  description: "An envelope's signed PDF, as a download (table-kept copies).",
  input: { id: id() },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: memberFinal, as: "link", input: { actor_id: auth("id"), envelope_id: inp("id"), with_bytes: c.bool(true) } }),
    s.conditional({ when: expr(withFilters(ref("link.b64"), fl.first_notnull(c.text(""))), "=", c.text("")), then: [
      s.return(obj({ state: ref("link.state"), how: ref("link.how"), url: ref("link.url"), name: ref("link.name") })),
    ] }),
    ...download(ref("link.b64"), ref("link.name")),
  ],
  response: ref("bytes"),
  responseShape: {} as string | Omit<MemberFinal, "b64">,
  history: false,
});

export const memberAuditRoute = query({
  apiGroup: documentsGroup, auth: user, name: "envelopes/{id}/audit-trail", verb: "GET",
  description: "An envelope's certificate and audit trail as a PDF download. Not allowed or failed: a JSON state.",
  input: { id: id() },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: memberAuditPdf, as: "trail", input: { actor_id: auth("id"), envelope_id: inp("id") } }),
    s.conditional({ when: expr(ref("trail.state"), "!=", c.text("ready")), then: [s.return(obj({ state: ref("trail.state") }))] }),
    ...download(ref("trail.b64"), ref("trail.name")),
  ],
  response: ref("bytes"),
  responseShape: {} as string | { state: "refused" | "unavailable" },
  history: false,
});

export const memberZipRoute = query({
  apiGroup: documentsGroup, auth: user, name: "envelopes/{id}/bundle", verb: "GET",
  description: "The original, signed copy and audit trail in one ZIP download. When it can't be built here: a JSON state.",
  input: { id: id() },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: memberZip, as: "zip", input: { actor_id: auth("id"), envelope_id: inp("id") } }),
    s.conditional({ when: expr(ref("zip.state"), "!=", c.text("ready")), then: [s.return(obj({ state: ref("zip.state") }))] }),
    ...download(ref("zip.b64"), ref("zip.name"), "application/zip"),
  ],
  response: ref("bytes"),
  responseShape: {} as string | { state: "refused" | "not_ready" | "unavailable" },
  history: false,
});

export const sealRetryRoute = query({
  apiGroup: documentsGroup, auth: user, name: "envelopes/{id}/seal/retry", verb: "POST",
  description: "Try again to make the signed copy of an envelope whose seal failed.",
  input: { id: id() },
  stack: [
    ...rbac.signedIn(),
    s.set_var("user_agent", withFilters(sys.httpHeaders(), fl.get("User-Agent", ""))),
    s.function.run({ fn: sealRetry, as: "retry", input: { actor_id: auth("id"), envelope_id: inp("id"), ip: sys.remoteIp(), user_agent: ref("user_agent") } }),
    s.conditional({ when: expr(ref("retry.state"), "=", c.text("scheduled")), then: [...sealKick(inp("id"))] }),
  ],
  response: ref("retry"), responseShape: {} as { ok: boolean; state: "scheduled" | "completed" | "not_sealing" | "refused" },
});

/**
 * TEST ONLY. Fill a draft as if everyone signed, then seal it now (`run: "now"`, answering the seal's result and time) or after
 * the response the way the last signer's request does (`run: "kick"`).
 */
export const sealApiGroups = [sealGroup, verifyGroup, finalGroup];
export const sealQueries = [
  sealOriginalRoute, sealFinalRoute, verifyRoute, brandRoute, finalLinkRoute, finalRawRoute,
  memberFinalRoute, memberFinalRawRoute, memberAuditRoute, memberZipRoute, sealRetryRoute,
];

