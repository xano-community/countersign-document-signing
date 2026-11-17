// The signer's side: a recipient's link, identity check, consent, and the signing session. These pages are public, so a
// team member's own session is never sent from them: only the signer session, and only to the signing routes. The session
// lives in memory and in this tab's sessionStorage (keyed by the link), so a reload resumes; it never goes to localStorage.
import { routePath } from "../../../xano/routes.gen";
import { XANO_HOST } from "@/base/request";
import type { FieldType, PageMeta, RecipientRole } from "@/lib/envelopes";

export type SignState =
  | "active" | "not_found" | "replaced" | "voided" | "expired" | "declined" | "finishing" | "completed" | "already_signed"
  | "not_your_turn" | "rate_limited" | "wrong_code";

export type Brief = {
  title: string; message: string; public_id: string; page_count: number; pages: PageMeta[]; status: string; end_reason: string;
  expires_at: number | null; sender_name: string | null; sender_email: string | null; reply_to: string | null;
  org_name: string | null; logo: string | null; accent: string | null;
  recipient: { name: string; email: string; role: RecipientRole; identity_check: "none" | "access_code" | "email_code" };
  ahead: { name: string; role_name: string }[];
  /** False when this person was handed their link because email isn't set up: nothing more will be emailed to them. */
  emailed: boolean;
};
export type OpenAnswer = {
  state: SignState; needs?: "identity" | "consent" | "ready"; envelope?: Brief; disclosure?: { version: number; text: string };
  session?: string | null; retry_after?: number; tries_left?: number; ok?: boolean; sent_to?: string;
};
export type SignField = {
  id: number; type: FieldType; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string;
  options: string[] | null; validation: { max_length?: number; min?: number; max?: number } | null; value: string | null; filled_at: number | null;
};
export type OtherField = { id: number; type: FieldType; page: number; x: number; y: number; w: number; h: number; value: string | null; owner_name: string | null };
export type Mark = { kind: "signature" | "initials"; method: "typed" | "drawn" | "uploaded"; png_b64: string };
export type SignerState = {
  title: string; public_id: string; page_count: number; pages: PageMeta[];
  recipient: { id: number; name: string; email: string; role: RecipientRole };
  fields: SignField[]; others: OtherField[]; marks: Mark[];
};

/** A refusal from a signing route: `ended` means the session no longer works and the link should be opened again. */
export class SignError extends Error {
  constructor(message: string, readonly ended: boolean) { super(message); }
}

const sessionKey = (token: string) => `sign.session.${token.slice(0, 16)}`;
export const signSession = {
  get: (token: string): string | null => { try { return sessionStorage.getItem(sessionKey(token)); } catch { return null; } },
  set: (token: string, s: string | null) => { try { if (s) sessionStorage.setItem(sessionKey(token), s); else sessionStorage.removeItem(sessionKey(token)); } catch { /* storage off */ } },
};

async function call<T>(verb: string, path: string, body?: unknown, session?: string | null): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (session) headers.authorization = `Bearer ${session}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(XANO_HOST + path, { method: verb, headers, body: body === undefined ? undefined : JSON.stringify(body), referrerPolicy: "no-referrer" });
  } catch {
    throw new SignError("We can't reach the server. Check your connection, then try again.", false);
  }
  const j = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (res.status === 401) throw new SignError(j?.message || "This page has changed since you opened it.", true);
  if (res.status >= 500) throw new SignError("Something went wrong on our side. Try again in a moment.", false);
  if (!res.ok) throw new SignError(j?.message || "That didn't work. Try again.", false);
  return j as T;
}

export const signApi = {
  open: (token: string) => call<OpenAnswer>("POST", routePath("POST sign/open"), { token }),
  sendCode: (token: string) => call<OpenAnswer>("POST", routePath("POST sign/code"), { token }),
  identity: (token: string, code: string) => call<OpenAnswer>("POST", routePath("POST sign/identity"), { token, code }),
  consent: (token: string, version: number) => call<OpenAnswer>("POST", routePath("POST sign/consent"), { token, disclosure_version: version, agree: true }),
  state: (session: string) => call<SignerState>("GET", routePath("GET signing/state"), undefined, session),
  fill: (session: string, fieldId: number, value: string) => call<SignField>("POST", routePath("POST signing/fill"), { field_id: fieldId, value }, session),
  adopt: (session: string, kind: Mark["kind"], method: Mark["method"], pngB64: string) =>
    call<{ kind: string }>("POST", routePath("POST signing/adopt"), { kind, method, png_b64: pngB64 }, session),
  finish: (session: string) =>
    call<{ ok: boolean; already: boolean; finishing: boolean }>("POST", routePath("POST signing/finish"), { agree: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, session),
  decline: (session: string, reason: string) => call<{ ok: boolean }>("POST", routePath("POST signing/decline"), { reason }, session),
  /** The document's bytes, as a Blob, however this deployment keeps them. */
  document: async (session: string): Promise<Blob> => {
    const how = await call<{ how: "signed" | "table" | "unavailable"; url: string | null }>("GET", routePath("GET signing/document"), undefined, session);
    if (how.how === "unavailable") throw new SignError("The document couldn't be loaded just now. Try again in a moment.", false);
    const res = how.how === "signed" && how.url
      ? await fetch(how.url, { referrerPolicy: "no-referrer" })
      : await fetch(XANO_HOST + routePath("GET signing/document/raw"), { headers: { authorization: `Bearer ${session}` }, referrerPolicy: "no-referrer" });
    if (res.status === 401) throw new SignError("This page has changed since you opened it.", true);
    if (!res.ok) throw new SignError("The document couldn't be loaded. Try again.", false);
    return res.blob();
  },
};

/** The order a signer is walked through their fields: page by page, top to bottom, left to right. */
export function fieldOrder<T extends { page: number; x: number; y: number }>(fields: T[]): T[] {
  return [...fields].sort((a, b) => a.page - b.page || Math.round(a.y * 100) - Math.round(b.y * 100) || a.x - b.x);
}

/** Whether a field still needs the signer: required, not one that fills itself, and not yet filled. */
export const needsSigner = (f: SignField) => f.required && !["name", "email", "date"].includes(f.type) && !f.filled_at;

/** "a minute", "3 minutes": how long to wait. */
export const waitWords = (secs?: number) => {
  const m = Math.max(1, Math.ceil((secs ?? 60) / 60));
  return m === 1 ? "a minute" : `${m} minutes`;
};
