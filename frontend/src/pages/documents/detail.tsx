// One document: where it stands, who's done what, how each email went, and the full trail, with the integrity check on top.
// The sender (or an admin) can remind, share a fresh link, correct someone's details, extend the deadline, cancel it, or retry a
// signed copy that failed. Once it's complete, the signed PDF, its audit trail and a ZIP of everything download from here.
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useCan } from "@xano-sdk/rbac/react";
import { templatesApi } from "@/lib/templates";
import { useLive } from "@/base/live";
import { AlertTriangle, CalendarPlus, Eye, Check, Copy, Download, FileArchive, FileCheck2, FileText, Loader2, Mail, HandHeart, LayoutTemplate, MoreHorizontal, PenLine, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar, LoadError, PageHeader, StatusBadge, useLoad } from "@/components/kit";
import { relative } from "@/components/kit/time";
import { cn } from "@/components/kit/cn";
import { routePath } from "../../../../xano/routes.gen";
import {
  envelopesApi, fetchDocument, RECIPIENT_STATUS_LABEL, ROLE_LABEL, saveBlob, STATUS_LABEL, STATUS_TONE, type AuditRow, type Detail, type DetailRecipient, type EmailRow,
} from "@/lib/envelopes";

const at = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

/** What happened, in the sender's words, from an audit event. */
function eventText(e: AuditRow): { text: string; tone: "ok" | "accent" | "warn" | "muted" } {
  let d: Record<string, unknown> = {};
  try { d = e.data ? JSON.parse(e.data) : {}; } catch { /* kept as written */ }
  const who = e.actor_name || e.actor_email || "Countersign";
  const email = typeof d.recipient_email === "string" ? d.recipient_email : "";
  switch (e.kind) {
    case "envelope.created": return { text: `${who} uploaded the document`, tone: "muted" };
    case "envelope.sent": return { text: `${who} sent it`, tone: "accent" };
    case "recipient.invited": return { text: `Invited ${email}`, tone: "muted" };
    case "recipient.opened": return { text: `${who} opened it`, tone: "accent" };
    case "recipient.identity_checked": return { text: `${who} proved who they are`, tone: "muted" };
    case "recipient.identity_failed": return { text: `${who} entered a wrong code`, tone: "warn" };
    case "recipient.code_sent": return { text: `A code was emailed to ${e.actor_email}`, tone: "muted" };
    case "recipient.consented": return { text: `${who} agreed to sign electronically`, tone: "muted" };
    case "recipient.adopted_signature": return { text: `${who} adopted a signature`, tone: "muted" };
    case "recipient.adopted_initials": return { text: `${who} adopted initials`, tone: "muted" };
    case "recipient.signed": return { text: `${who} signed`, tone: "ok" };
    case "recipient.approved": return { text: `${who} approved`, tone: "ok" };
    case "recipient.viewed": return { text: `${who} confirmed they read it`, tone: "ok" };
    case "recipient.completed": return { text: d.role === "cc" ? `${email || who} will get the signed copy` : `${who} finished`, tone: "muted" };
    case "recipient.declined": return { text: `${who} declined${typeof d.reason === "string" && d.reason ? `: “${d.reason}”` : ""}`, tone: "warn" };
    case "recipient.rejected": return { text: `${who} rejected it${typeof d.reason === "string" && d.reason ? `: “${d.reason}”` : ""}`, tone: "warn" };
    case "recipient.hosted": return { text: `${who} handed their device to ${email} to sign in person`, tone: "muted" };
    case "recipient.reminded": return { text: `Reminder sent to ${email}`, tone: "muted" };
    case "recipient.corrected": return { text: `${who} changed ${String(d.old_email ?? "")} to ${String(d.new_email ?? "")}`, tone: "muted" };
    case "recipient.bounced": return { text: `Email to ${email} bounced`, tone: "warn" };
    case "link.created": return { text: `A signing link was made for ${email}`, tone: "muted" };
    case "link.download_created": return { text: `${who} made a link to the signed copy for ${email}`, tone: "muted" };
    case "envelope.all_signed": return { text: "Everyone has finished", tone: "ok" };
    case "envelope.completed": return { text: "The signed copy was sealed", tone: "ok" };
    case "envelope.voided": return { text: `${who} cancelled it${typeof d.reason === "string" && d.reason ? `: “${d.reason}”` : ""}`, tone: "warn" };
    case "envelope.expired": return { text: "The deadline passed", tone: "warn" };
    case "envelope.extended": return { text: `${who} extended the deadline`, tone: "muted" };
    case "envelope.declined": return { text: "It ended when someone declined", tone: "warn" };
    case "envelope.seal_failed": return { text: "The signed copy couldn't be made", tone: "warn" };
    case "envelope.seal_retried": return { text: `${who} retried the signed copy`, tone: "muted" };
    default: return { text: e.kind.replace(/[._]/g, " "), tone: "muted" };
  }
}

const DOT = { ok: "bg-[var(--success)]", accent: "bg-primary", warn: "bg-[var(--warning)]", muted: "bg-input" } as const;
const MAIL_LABEL: Record<string, string> = {
  queued: "Email queued", link_only: "Share the link yourself", sending: "Sending", sent: "Email sent", delivered: "Email delivered",
  bounced: "Email bounced", complained: "Marked as spam", failed: "Email failed", unknown: "Email may have sent", skipped: "No email",
};

export function DocumentDetailPage() {
  const id = Number(useParams().id);
  const detail = useLoad(() => envelopesApi.detail(id), [id]);
  useLive("envelope", detail.reload);
  if (detail.error) return <div className="mx-auto max-w-4xl p-8"><LoadError title="This document didn't open" error={detail.error} onRetry={detail.reload} /></div>;
  if (!detail.data) return <div className="grid min-h-[50vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading" className="animate-spin" /></div>;
  return <DetailView d={detail.data} reload={detail.reload} />;
}

function DetailView({ d, reload }: { d: Detail; reload: () => void }) {
  const e = d.envelope;
  const [dialog, setDialog] = useState<null | "void" | "extend" | { correct: DetailRecipient } | { host: DetailRecipient }>(null);
  const [busy, setBusy] = useState("");
  const out = e.status === "in_progress";
  const manage = d.can_manage && out;
  const navigate = useNavigate();
  const canTemplate = useCan("template.manage");
  const saveAsTemplate = async () => {
    try {
      const made = await templatesApi.saveFrom(e.id);
      toast.success("Saved as a template. Name its roles, then it's ready to use.");
      navigate(`/documents/${made.template_id}/prepare`);
    } catch (err) { toast.error(err instanceof Error ? err.message : "The template wasn't saved. Try again."); }
  };
  const acting = d.recipients.filter((r) => r.role !== "cc");
  const done = acting.filter((r) => r.status === "completed").length;
  const latestMail = (r: DetailRecipient): EmailRow | undefined => d.emails.find((m) => m.recipient_id === r.id && ["invite", "reminder"].includes(m.kind));

  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try { await fn(); toast.success(success); reload(); }
    catch (err) { toast.error(err instanceof Error ? err.message : "That didn't work. Try again."); }
    finally { setBusy(""); }
  };
  const copyDownload = async (r: DetailRecipient) => {
    setBusy(`dl-${r.id}`);
    try { const l = await envelopesApi.copyDownload(e.id, r.id); await navigator.clipboard.writeText(l.url); toast.success(`Copied ${r.name}'s link to their signed copy`); reload(); }
    catch (err) { toast.error(err instanceof Error ? err.message : "That didn't work. Try again."); }
    finally { setBusy(""); }
  };
  const copyLink = async (r: DetailRecipient) => {
    setBusy(`link-${r.id}`);
    try { const l = await envelopesApi.copyLink(e.id, r.id); await navigator.clipboard.writeText(l.url); toast.success(`Copied a new signing link for ${r.name}`); reload(); }
    catch (err) { toast.error(err instanceof Error ? err.message : "That didn't work. Try again."); }
    finally { setBusy(""); }
  };
  const download = async (kind: "final" | "original" | "audit" | "bundle") => {
    setBusy(`dl-${kind}`);
    try {
      const paths = {
        final: [routePath("GET envelopes/{id}/final", { id: e.id }), routePath("GET envelopes/{id}/final/raw", { id: e.id })],
        original: [routePath("GET envelopes/{id}/original", { id: e.id }), routePath("GET envelopes/{id}/original/raw", { id: e.id })],
        audit: [routePath("GET envelopes/{id}/audit-trail", { id: e.id }), routePath("GET envelopes/{id}/audit-trail", { id: e.id })],
        bundle: [routePath("GET envelopes/{id}/bundle", { id: e.id }), routePath("GET envelopes/{id}/bundle", { id: e.id })],
      }[kind];
      const got = kind === "final" || kind === "original" ? await fetchDocument(paths[0], paths[1]) : await fetchBinary(paths[0], kind === "audit" ? `${e.title} (audit trail).pdf` : `${e.title}.zip`);
      if ("error" in got) toast.error(got.error); else saveBlob(got.blob, got.name);
    } finally { setBusy(""); }
  };

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-8">
      <PageHeader
        back={{ href: "/", label: "Documents" }}
        title={e.title}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge tone={e.seal_failed ? "danger" : STATUS_TONE[e.status]} dot>{e.seal_failed ? "Signed copy failed" : STATUS_LABEL[e.status]}</StatusBadge>
            <span>Sent by {e.sender_name ?? "someone"}</span>
            {out && e.expires_at ? <span>Deadline {relative(e.expires_at)}</span> : null}
            {e.signing_order === "ordered" ? <span>In order</span> : null}
            <span className="font-mono text-caption">{e.public_id}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {e.status === "completed" && <Button variant="outline" asChild><Link to={`/documents/${e.id}/view`}><Eye aria-hidden />View signed copy</Link></Button>}
            {e.status === "completed" && <Button onClick={() => download("final")} disabled={!!busy}>{busy === "dl-final" ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}Signed PDF</Button>}
            {e.status !== "completed" && e.status !== "draft" && <Button variant="outline" asChild><Link to={`/documents/${e.id}/view`}><Eye aria-hidden />View document</Link></Button>}
            {e.status === "draft" && d.can_manage && <Button asChild><Link to={`/documents/${e.id}/prepare`}><PenLine aria-hidden />Continue preparing</Link></Button>}
            {e.seal_failed && d.can_manage && <Button onClick={() => run("retry", () => envelopesApi.retrySeal(e.id), "Trying again to make the signed copy")} disabled={!!busy}><RefreshCw aria-hidden />Retry signed copy</Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" aria-label="More actions"><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {e.status === "completed" && <DropdownMenuItem asChild><Link to={`/documents/${e.id}/view?copy=original`}><Eye aria-hidden />View the original</Link></DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => download("original")}><FileText aria-hidden />Download the original</DropdownMenuItem>
                {e.status === "completed" && <DropdownMenuItem onSelect={() => download("audit")}><FileCheck2 aria-hidden />Download the audit trail</DropdownMenuItem>}
                {e.status === "completed" && <DropdownMenuItem onSelect={() => download("bundle")}><FileArchive aria-hidden />Download everything (ZIP)</DropdownMenuItem>}
                {canTemplate && <DropdownMenuItem onSelect={() => void saveAsTemplate()}><LayoutTemplate aria-hidden />Save as a template</DropdownMenuItem>}
                {manage && <DropdownMenuItem onSelect={() => setDialog("extend")}><CalendarPlus aria-hidden />Extend the deadline</DropdownMenuItem>}
                {manage && <DropdownMenuItem onSelect={() => setDialog("void")} className="text-destructive"><XCircle aria-hidden />Cancel this document</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      {e.seal_failed ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>Everyone signed, but the signed copy couldn't be made after {e.seal_attempts} tries: {e.seal_error || "an unknown error"}. Fix the cause, then press Retry.</span>
        </p>
      ) : e.status === "sealing" ? (
        <p className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm"><Loader2 aria-hidden className="size-4 animate-spin text-primary-text" />Everyone has signed. Making the signed copy now; this page updates when it's ready.</p>
      ) : e.end_reason && ["declined", "voided", "expired"].includes(e.status) ? (
        <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">{STATUS_LABEL[e.status]}: “{e.end_reason}”</p>
      ) : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] [&>*]:min-w-0">
        <section aria-labelledby="people-h" className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 id="people-h" className="font-semibold">People</h2>
            {acting.length ? <span className="text-caption text-muted-foreground">{done} of {acting.length} done</span> : null}
          </div>
          <ul className="divide-y">
            {d.recipients.map((r) => {
              const mail = latestMail(r);
              const turn = r.status === "sent" || r.status === "opened";
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Avatar name={r.name || r.email} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.name} <span className="font-normal text-muted-foreground">· {ROLE_LABEL[r.role]}{e.signing_order === "ordered" && r.role !== "cc" ? `, step ${r.step}` : ""}</span></p>
                    <p className="truncate text-caption text-muted-foreground">
                      {r.email}
                      {r.status === "completed" && r.completed_at ? ` · done ${relative(r.completed_at)}` : ""}
                      {r.status === "opened" && r.opened_at ? ` · opened ${relative(r.opened_at)}` : ""}
                      {r.status === "declined" && r.decline_reason ? ` · “${r.decline_reason}”` : ""}
                      {mail && turn ? ` · ${MAIL_LABEL[mail.status] ?? mail.status}` : ""}
                    </p>
                  </div>
                  {/* On a phone the status sits under the name, so the name and email keep the row's width. */}
                  <span className="order-last w-full pl-9 sm:order-none sm:w-auto sm:pl-0">
                    {r.bounced && turn ? <StatusBadge tone="warning" dot>Email bounced</StatusBadge>
                      : r.status === "completed" ? <StatusBadge tone="success" dot>{r.role === "cc" ? "Got a copy" : "Done"}</StatusBadge>
                      : r.status === "declined" ? <StatusBadge tone="danger" dot>Declined</StatusBadge>
                      : turn ? <StatusBadge tone="info" dot>{r.status === "opened" ? "Opened" : "Their turn"}</StatusBadge>
                      : <StatusBadge>{RECIPIENT_STATUS_LABEL[r.status]}</StatusBadge>}
                  </span>
                  {manage && r.role !== "cc" && r.status !== "completed" && r.status !== "declined" ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for ${r.name}`} disabled={!!busy}>{busy.endsWith(`-${r.id}`) ? <Loader2 aria-hidden className="animate-spin" /> : <MoreHorizontal aria-hidden />}</Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {turn && <DropdownMenuItem onSelect={() => run(`remind-${r.id}`, () => envelopesApi.remind(e.id, r.id), `Reminder sent to ${r.name}`)}><Mail aria-hidden />Remind now</DropdownMenuItem>}
                        {turn && <DropdownMenuItem onSelect={() => setDialog({ host: r })}><HandHeart aria-hidden />Sign in person on this device</DropdownMenuItem>}
                        <DropdownMenuItem onSelect={() => void copyLink(r)}><Copy aria-hidden />Copy a new signing link</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setDialog({ correct: r })}><PenLine aria-hidden />Correct name or email</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : d.can_manage && e.status === "completed" ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for ${r.name}`} disabled={!!busy}>{busy === `dl-${r.id}` ? <Loader2 aria-hidden className="animate-spin" /> : <MoreHorizontal aria-hidden />}</Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => void copyDownload(r)}><Copy aria-hidden />Copy their link to the signed copy</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        <aside className="flex flex-col gap-4">
          <section aria-labelledby="trail-h" className="rounded-lg border bg-card">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h2 id="trail-h" className="font-semibold">Timeline</h2>
              <span className={cn("flex items-center gap-1 text-caption", d.integrity.ok ? "text-[var(--success)]" : "text-destructive")}>
                {d.integrity.ok ? <ShieldCheck aria-hidden className="size-3.5" /> : <ShieldAlert aria-hidden className="size-3.5" />}
                {d.integrity.ok ? `Intact · ${d.integrity.events} events` : `Broken at event ${d.integrity.broken_at}`}
              </span>
            </div>
            <ol className="max-h-[32rem] overflow-y-auto px-4 py-2">
              {[...d.events].reverse().map((ev) => {
                const t = eventText(ev);
                return (
                  <li key={ev.seq} className="grid grid-cols-[0.75rem_1fr] gap-2 py-2 text-sm">
                    <span aria-hidden className={cn("mt-1.5 size-2 rounded-full", DOT[t.tone])} />
                    <div className="min-w-0">
                      <p className="break-words">{t.text}</p>
                      <p className="text-caption text-muted-foreground">{at(ev.at)}{ev.ip ? ` · ${ev.ip}` : ""}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
          {e.status === "completed" ? (
            <section className="rounded-lg border bg-card p-4 text-caption">
              <h2 className="mb-2 font-semibold text-foreground">Fingerprints</h2>
              <dl className="grid gap-2">
                <div><dt className="text-muted-foreground">Signed PDF (SHA-256)</dt><dd className="break-all font-mono">{e.final_sha256}</dd></div>
                <div><dt className="text-muted-foreground">Original</dt><dd className="break-all font-mono">{e.original_sha256}</dd></div>
                <div><dt className="text-muted-foreground">Audit chain head on the certificate</dt><dd className="break-all font-mono">{e.chain_head}</dd></div>
              </dl>
              <p className="mt-3 text-muted-foreground">Anyone can check a copy at <Link to="/verify" className="underline">the verify page</Link>.</p>
            </section>
          ) : null}
        </aside>
      </div>

      <VoidDialog open={dialog === "void"} onClose={() => setDialog(null)} onConfirm={(reason) => run("void", () => envelopesApi.voidIt(e.id, reason), "Cancelled. Everyone who had it has been told.").then(() => setDialog(null))} />
      <ExtendDialog open={dialog === "extend"} onClose={() => setDialog(null)} onConfirm={(days) => run("extend", () => envelopesApi.extend(e.id, days), "Deadline extended").then(() => setDialog(null))} />
      {dialog && typeof dialog === "object" && "correct" in dialog && (
        <CorrectDialog r={dialog.correct} onClose={() => setDialog(null)}
          onConfirm={(name, email) => run(`correct-${dialog.correct.id}`, () => envelopesApi.correct(e.id, dialog.correct.id, name, email), `${name} will get a new link. The old one no longer works.`).then(() => setDialog(null))} />
      )}
      {dialog && typeof dialog === "object" && "host" in dialog && <HostDialog envelopeId={e.id} r={dialog.host} onClose={() => setDialog(null)} />}
    </div>
  );
}

async function fetchBinary(path: string, name: string): Promise<{ blob: Blob; name: string } | { error: string }> {
  const { XANO_HOST, token } = await import("@/lib/api");
  const t = token.get();
  const res = await fetch(XANO_HOST + path, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!res.ok) return { error: "This file couldn't be downloaded. Try again." };
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = (await res.json().catch(() => null)) as { message?: string; state?: string } | null;
    if (j?.state === "unavailable" && name.endsWith(".zip")) return { error: "This deployment can't build ZIP files. Download the signed PDF and the audit trail separately." };
    if (j?.state === "not_ready") return { error: "This isn't ready until everyone has signed." };
    return { error: j?.message ?? "This file isn't available right now. Try again in a moment." };
  }
  return { blob: await res.blob(), name };
}

function VoidDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this document?</DialogTitle>
          <DialogDescription>Everyone who has it is told it's cancelled, with your reason, and their links stop working. This can't be undone.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="void-reason">Reason</Label>
          <Textarea id="void-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="The rent amount was wrong. A corrected copy is on its way." />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep it</Button>
          <Button variant="destructive" disabled={!reason.trim() || busy} onClick={async () => { setBusy(true); await onConfirm(reason.trim()); setBusy(false); setReason(""); }}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Cancel document</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExtendDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (days: number) => Promise<unknown> }) {
  const [days, setDays] = useState(7);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Extend the deadline</DialogTitle><DialogDescription>Signers keep their links. The new deadline counts from the current one, or from today if it has passed.</DialogDescription></DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="extend-days">Extra days</Label>
          <Input id="extend-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Not now</Button>
          <Button onClick={() => void onConfirm(days)}><Check aria-hidden />Extend by {days} {days === 1 ? "day" : "days"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CorrectDialog({ r, onClose, onConfirm }: { r: DetailRecipient; onClose: () => void; onConfirm: (name: string, email: string) => Promise<unknown> }) {
  const [name, setName] = useState(r.name);
  const [email, setEmail] = useState(r.email);
  const ok = name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Correct {r.name}'s details</DialogTitle><DialogDescription>Their old link stops working at once, including a page they have open. If it's their turn, they get a new invite at this address.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label htmlFor="c-name">Name</Label><Input id="c-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="c-email">Email</Label><Input id="c-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!ok} onClick={() => void onConfirm(name.trim(), email.trim())}>Save and re-invite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Hand this device to a recipient who's in the room: their signing page opens here, and the trail names you as the host. */
function HostDialog({ envelopeId, r, onClose }: { envelopeId: number; r: DetailRecipient; onClose: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try { const l = await envelopesApi.host(envelopeId, r.id); navigate(new URL(l.url).pathname); }
    catch (err) { toast.error(err instanceof Error ? err.message : "Signing in person didn't start. Try again."); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in person</DialogTitle>
          <DialogDescription>
            {r.name}'s signing page opens on this device, for you to hand over. They still confirm who they are and agree to sign electronically.
            The audit trail and certificate record that you hosted it.
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-lg border bg-paper px-3 py-2 text-sm">You stay signed in here. When they finish, come back to this document from Documents.</p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={start} disabled={busy}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : <HandHeart aria-hidden />}Open {r.name}'s signing page</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
