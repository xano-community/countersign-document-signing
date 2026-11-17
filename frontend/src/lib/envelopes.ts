// The sender's side of Countersign: every call the Documents, Prepare and detail screens make, the shapes they answer, and
// the words and tones a status is shown with. Paths come from xano/routes.gen.ts; every call goes through request().
import { routePath } from "../../../xano/routes.gen";
import { ApiError, XANO_HOST, qs, request, token } from "@/lib/api";
import type { Tone } from "@/components/kit";

export type EnvelopeStatus = "draft" | "in_progress" | "sealing" | "completed" | "declined" | "voided" | "expired";
export type RecipientRole = "signer" | "approver" | "viewer" | "cc";
export type RecipientStatus = "waiting" | "sent" | "opened" | "completed" | "declined";
export type IdentityCheck = "none" | "access_code" | "email_code";
export type FieldType = "signature" | "initials" | "name" | "email" | "date" | "text" | "number" | "checkbox" | "radio" | "dropdown";
export type Segment = "action" | "waiting" | "completed" | "drafts" | "ended" | "all";
export type PageMeta = { w: number; h: number; rotation?: number };

export type EnvelopeRow = {
  id: number; public_id: string; title: string; status: EnvelopeStatus; sender_id: number; sender_name: string | null;
  visibility: "private" | "team"; signing_order: "parallel" | "ordered"; sent_at: number | null; expires_at: number | null;
  completed_at: number | null; ended_at: number | null; updated_at: number | null; created_at: number; seal_failed: boolean;
  page_count: number; is_demo: boolean;
};
export type PersonRow = {
  id: number; envelope_id: number; name: string; email: string; role: RecipientRole; status: RecipientStatus; step: number; color: number;
  user_id: number; bounced: boolean;
};
export type EnvelopePage = { items: EnvelopeRow[]; people: PersonRow[]; my_turn: number[]; next_page: number | null; total: number };
export type Stats = { waiting_on_you: number; out: number; completed_this_month: number; median_ms: number | null; completed_last_30: number };

export type Recipient = {
  id: number; name: string; email: string; role: RecipientRole; role_name: string; step: number; color: number;
  identity_check: IdentityCheck; user_id: number; status: RecipientStatus; has_access_code?: boolean;
};
export type Field = {
  id?: number; recipient_id: number; type: FieldType; page: number; x: number; y: number; w: number; h: number;
  required: boolean; label: string; options: string[]; validation: { max_length?: number; min?: number; max?: number };
};
export type Problem = { code: string; message: string; recipient_id?: number; field_id?: number };
export type EmailStatus = { state: "ready" | "missing_key" | "missing_from" | "webhook_missing"; can_send: boolean };
export type PrepareView = {
  envelope: {
    id: number; public_id: string; title: string; status: EnvelopeStatus; sender_id: number; visibility: "private" | "team";
    signing_order: "parallel" | "ordered"; subject: string; message: string; expiry_days: number; reminder_days: number;
    page_count: number; pages: PageMeta[]; original_file_id: number; is_template: boolean; updated_at: number | null;
  };
  recipients: Recipient[]; fields: Field[]; problems: Problem[]; email: EmailStatus; editable: boolean;
};
export type SharedLink = { recipient_id: number; name: string; email: string; url: string };
export type SendAnswer = { ok: boolean; envelope_id: number; links: SharedLink[]; email: EmailStatus["state"] };

export type DetailRecipient = PersonRow & {
  role_name: string; identity_check: IdentityCheck; opened_at: number | null; completed_at: number | null; declined_at: number | null;
  decline_reason: string; reminders_sent: number; last_reminded_at: number | null; hosted_by: number | null;
};
export type EmailRow = { id: number; kind: string; recipient_id: number; to: string; status: string; sent_at: number | null; last_error: string; created_at: number };
export type AuditRow = { seq: number; kind: string; actor_type: string; actor_name: string; actor_email: string; ip: string; user_agent: string; data: string; at: number };
export type Detail = {
  envelope: EnvelopeRow & {
    subject: string; message: string; reminder_days: number; end_reason: string; pages: PageMeta[]; original_sha256: string;
    final_sha256: string; chain_head: string; seal_error: string; seal_attempts: number; is_template: boolean;
  };
  recipients: DetailRecipient[]; emails: EmailRow[]; events: AuditRow[];
  integrity: { ok: boolean; events: number; head: string; broken_at: number }; can_manage: boolean;
};
export type CreateAnswer = { ok: boolean; code: string; message: string; envelope?: { id: number } | null };
export type Storage = { mode: "signed" | "table"; max_upload_bytes: number };

/** The app's own address, so links in emails and copied links point back here. */
const appUrl = () => window.location.origin;

export const envelopesApi = {
  list: (q: { segment: Segment; q?: string; page?: number }) => request<EnvelopePage>("GET", routePath("GET envelopes") + qs(q)),
  stats: () => request<Stats>("GET", routePath("GET envelopes/stats")),
  /** Once a session: tells the backend where the app is served, and lets a fresh demo finish setting up. */
  hello: () => request<{ ok: boolean }>("POST", routePath("POST app/hello"), { app_url: appUrl() }),
  detail: (id: number) => request<Detail>("GET", routePath("GET envelopes/{id}", { id })),
  storage: () => request<Storage>("GET", routePath("GET document-storage")),
  prepare: (id: number) => request<PrepareView>("GET", routePath("GET envelopes/{id}/prepare", { id })),
  update: (id: number, patch: Pick<PrepareView["envelope"], "title" | "subject" | "message" | "expiry_days" | "reminder_days" | "visibility" | "signing_order">) =>
    request<unknown>("PATCH", routePath("PATCH envelopes/{id}", { id }), patch),
  saveRecipients: (id: number, recipients: (Partial<Recipient> & { access_code?: string })[]) =>
    request<Recipient[]>("PUT", routePath("PUT envelopes/{id}/recipients", { id }), { recipients }),
  saveFields: (id: number, fields: Field[]) => request<Field[]>("PUT", routePath("PUT envelopes/{id}/fields", { id }), { fields }),
  send: (id: number) => request<SendAnswer>("POST", routePath("POST envelopes/{id}/send", { id }), { app_url: appUrl() }),
  copyLink: (id: number, recipientId: number) =>
    request<SharedLink>("POST", routePath("POST envelopes/{id}/recipients/{recipient_id}/link", { id, recipient_id: recipientId }), { app_url: appUrl() }),
  host: (id: number, recipientId: number) =>
    request<{ url: string; name: string }>("POST", routePath("POST envelopes/{id}/recipients/{recipient_id}/host", { id, recipient_id: recipientId }), { app_url: appUrl() }),
  copyDownload: (id: number, recipientId: number) =>
    request<SharedLink>("POST", routePath("POST envelopes/{id}/recipients/{recipient_id}/download_link", { id, recipient_id: recipientId }), { app_url: appUrl() }),
  signAsMe: (id: number) => request<{ url: string }>("POST", routePath("POST envelopes/{id}/sign", { id }), { app_url: appUrl() }),
  remind: (id: number, recipientId: number) =>
    request<unknown>("POST", routePath("POST envelopes/{id}/recipients/{recipient_id}/remind", { id, recipient_id: recipientId }), { app_url: appUrl() }),
  correct: (id: number, recipientId: number, name: string, email: string) =>
    request<unknown>("POST", routePath("POST envelopes/{id}/recipients/{recipient_id}/correct", { id, recipient_id: recipientId }), { name, email, app_url: appUrl() }),
  voidIt: (id: number, reason: string) => request<unknown>("POST", routePath("POST envelopes/{id}/void", { id }), { reason }),
  extend: (id: number, days: number) => request<{ expires_at: number }>("POST", routePath("POST envelopes/{id}/extend", { id }), { days }),
  retrySeal: (id: number) => request<unknown>("POST", routePath("POST envelopes/{id}/seal/retry", { id })),
  /** Upload one PDF (several are combined in the browser first) and make a draft from it. */
  create: async (file: Blob, o: { clientId: string; title: string; visibility: "private" | "team"; sources: unknown[]; asTemplate?: boolean }) => {
    const form = new FormData();
    form.append("file", file, `${o.title || "document"}.pdf`);
    form.append("client_id", o.clientId);
    form.append("title", o.title);
    form.append("visibility", o.visibility);
    form.append("sources", JSON.stringify(o.sources));
    if (o.asTemplate) form.append("as_template", "true");
    return upload<CreateAnswer>(routePath("POST envelopes"), form);
  },
};

/** A multipart POST through the same session and error handling as request(). */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const t = token.get();
  if (t) headers.authorization = `Bearer ${t}`;
  let res: Response;
  try { res = await fetch(XANO_HOST + path, { method: "POST", headers, body: form }); }
  catch { throw new ApiError("We can't reach the server. Check your connection, then try again.", 0); }
  const j = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok) throw new ApiError(j?.message || `That didn't work (${res.status}).`, res.status);
  return j as T;
}

/**
 * A file the app hands back in one of three ways: a short signed link, the raw route, or not at all. Fetches it as a Blob, so
 * nothing from storage ever renders on its own origin.
 */
export async function fetchDocument(linkPath: string, rawPath: string): Promise<{ blob: Blob; name: string } | { error: string }> {
  const link = await request<{ state?: string; how: "signed" | "table" | "refused" | "unavailable"; url: string | null; name: string | null }>("GET", linkPath);
  if (link.how === "refused" || link.state === "not_ready") return { error: "This file isn't available yet." };
  if (link.how === "unavailable") return { error: "Storage didn't answer just now. Try again in a moment." };
  const headers: Record<string, string> = {};
  const t = token.get();
  let res: Response;
  if (link.how === "signed" && link.url) res = await fetch(link.url);
  else { if (t) headers.authorization = `Bearer ${t}`; res = await fetch(XANO_HOST + rawPath, { headers }); }
  if (!res.ok) return { error: "This file couldn't be downloaded. Try again." };
  return { blob: await res.blob(), name: link.name ?? "document.pdf" };
}

/** Save a Blob as a file, named. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Words and tones ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<EnvelopeStatus, string> = {
  draft: "Draft", in_progress: "Out for signature", sealing: "Finishing", completed: "Completed", declined: "Declined", voided: "Cancelled", expired: "Expired",
};
export const STATUS_TONE: Record<EnvelopeStatus, Tone> = {
  draft: "neutral", in_progress: "info", sealing: "info", completed: "success", declined: "danger", voided: "neutral", expired: "warning",
};
export const ROLE_LABEL: Record<RecipientRole, string> = { signer: "Signer", approver: "Approver", viewer: "Viewer", cc: "Gets a copy" };
export const RECIPIENT_STATUS_LABEL: Record<RecipientStatus, string> = { waiting: "Waiting their turn", sent: "Sent", opened: "Opened", completed: "Done", declined: "Declined" };
export const FIELD_LABEL: Record<FieldType, string> = {
  signature: "Signature", initials: "Initials", name: "Full name", email: "Email", date: "Date signed", text: "Text", number: "Number",
  checkbox: "Checkbox", radio: "Choice", dropdown: "Dropdown",
};
export const IDENTITY_LABEL: Record<IdentityCheck, string> = { none: "Their email link", access_code: "An access code you give them", email_code: "A code we email them" };

/** A recipient's colour on the prepare view: --r1…--r6, by their position. */
export const recipientColor = (n: number) => `var(--r${((Math.max(1, n) - 1) % 6) + 1})`;

/** "1.4 days", "5 hours", "12 minutes": how long something took. */
export function duration(ms: number | null | undefined) {
  if (ms == null) return "—";
  const h = ms / 3_600_000;
  const n = (v: number, one: string) => `${v} ${v === 1 ? one : one + "s"}`;
  if (h >= 24) { const d = Number((h / 24).toFixed(1)); return n(d, "day"); }
  if (h >= 1) return n(Math.round(h), "hour");
  return n(Math.max(1, Math.round(ms / 60_000)), "minute");
}
