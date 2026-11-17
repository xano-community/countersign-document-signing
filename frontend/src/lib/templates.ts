// Templates, bulk sends and public links: the calls the Templates screens make, and the CSV reading a bulk send starts with.
import { routePath } from "../../../xano/routes.gen";
import { XANO_HOST, request } from "@/lib/api";
import type { RecipientRole, SendAnswer } from "@/lib/envelopes";

export type TemplateRole = { id: number; role: RecipientRole; role_name: string; name: string; email: string; step: number; color: number };
export type Template = {
  id: number; title: string; sender_id: number; owner_name: string | null; visibility: "private" | "team"; signing_order: "parallel" | "ordered";
  page_count: number; updated_at: number | null; created_at: number; roles: TemplateRole[]; field_count: number; uses: number;
  public_link: { slug: string; enabled: boolean; uses: number } | null;
};
export type PersonIn = { role_id: number; name: string; email: string };
export type BulkRowIn = { line: number; people: PersonIn[] };
export type Bulk = {
  bulk: { id: number; template_id: number; title: string; status: "running" | "done" | "cancelled"; total: number; sent: number; failed: number; created_at: number; finished_at: number | null };
  failed_rows: { line: number; people: PersonIn[]; error: string }[];
};

const appUrl = () => window.location.origin;

export const templatesApi = {
  list: () => request<{ items: Template[] }>("GET", routePath("GET templates")),
  use: (id: number, people: PersonIn[], o: { title?: string; send: boolean }) =>
    request<{ envelope_id: number; sent: SendAnswer | null }>("POST", routePath("POST templates/{id}/use", { id }), { people, title: o.title, send: o.send, app_url: appUrl() }),
  saveFrom: (envelopeId: number, title?: string) => request<{ template_id: number }>("POST", routePath("POST templates"), { envelope_id: envelopeId, title }),
  remove: (id: number) => request<unknown>("DELETE", routePath("DELETE templates/{id}", { id })),
  publicProblems: (id: number) => request<string[]>("GET", routePath("GET templates/{id}/public_problems", { id })),
  setPublicLink: (id: number, enabled: boolean) =>
    request<{ slug: string; enabled: boolean; uses: number }>("POST", routePath("POST templates/{id}/public_link", { id }), { enabled, app_url: appUrl() }),
  bulk: (id: number, rows: BulkRowIn[], title?: string) =>
    request<{ bulk_send_id: number; total: number; failed: number }>("POST", routePath("POST templates/{id}/bulk", { id }), { rows, title, app_url: appUrl() }),
  bulkDetail: (id: number) => request<Bulk>("GET", routePath("GET bulk/{id}", { id })),
  bulkCancel: (id: number) => request<unknown>("POST", routePath("POST bulk/{id}/cancel", { id })),
};

/** A template's public address, as people share it. */
export const publicUrl = (slug: string) => `${window.location.origin}/p/${slug}`;

/** The roles each use of a template fills in: those without a fixed person. */
export const openRoles = (t: Pick<Template, "roles">) => t.roles.filter((r) => !r.email);

// ── The public page (no sign-in) ─────────────────────────────────────────────────────────────────────────────────────

export type PublicBrief = { state: "ok" | "off" | "not_found"; title?: string; message?: string; page_count?: number; role_name?: string | null; org_name?: string | null; logo?: string | null };
export type PublicAnswer = { state: "code_sent" | "email_off" | "rate_limited" | "wrong_code" | "ok" | "off" | "not_found" | "unavailable"; sent_to?: string; retry_after?: number; tries_left?: number; url?: string };

async function call<T>(verb: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(XANO_HOST + path, { method: verb, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, referrerPolicy: "no-referrer" });
  } catch { throw new Error("We can't reach the server. Check your connection, then try again."); }
  const j = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (res.status >= 500) throw new Error("Something went wrong on our side. Try again in a moment.");
  if (!res.ok) throw new Error(j?.message || "That didn't work. Try again.");
  return j as T;
}

export const publicApi = {
  brief: (slug: string) => call<PublicBrief>("GET", routePath("GET public/{slug}", { slug })),
  start: (slug: string, name: string, email: string) => call<PublicAnswer>("POST", routePath("POST public/{slug}/start", { slug }), { name, email }),
  verify: (slug: string, name: string, email: string, code: string) => call<PublicAnswer>("POST", routePath("POST public/{slug}/verify", { slug }), { name, email, code }),
};

// ── CSV ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Reads CSV text into rows of cells: quoted cells, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

/**
 * Guesses which column holds each role's name and email from the header row: "Client name" / "Client email" for a role named
 * Client, or plain "name" / "email" when there's one role to fill. Answers -1 for a column it can't find.
 */
export function guessColumns(header: string[], roles: TemplateRole[]): Record<number, { name: number; email: number }> {
  const h = header.map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  const find = (pred: (x: string) => boolean) => h.findIndex(pred);
  const out: Record<number, { name: number; email: number }> = {};
  for (const r of roles) {
    const role = r.role_name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let name = find((x) => x.includes(role) && x.includes("name"));
    let email = find((x) => x.includes(role) && (x.includes("email") || x.includes("e mail")));
    if (roles.length === 1) {
      if (name < 0) name = find((x) => x === "name" || x === "full name" || x.endsWith(" name") || x === role);
      if (email < 0) email = find((x) => x === "email" || x === "e mail" || x.includes("email"));
    }
    out[r.id] = { name, email };
  }
  return out;
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
