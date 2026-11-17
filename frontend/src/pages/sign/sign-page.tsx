// A recipient's signing page, at /sign/:token. Their link opens it; they prove who they are if the sender asked, consent to
// sign electronically, then sign field by field. Every way the link can't be signed (not their turn yet, declined, cancelled,
// expired, replaced, already signed) is a page of its own that says why and who to ask. If the document changes under an open
// page, the next save re-opens the link and shows where it stands.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Check, ChevronDown, Clock, FileX2, Loader2, Lock, Mail, PenLine, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/components/kit/cn";
import { DocumentView, type PageSize } from "@/components/pdf/document-view";
import { AdoptDialog, typedPng, initialsOf, type Adopted } from "@/components/signature/adopt";
import { FIELD_LABEL } from "@/lib/envelopes";
import {
  fieldOrder, needsSigner, SignError, signApi, signSession, waitWords, type Brief, type OpenAnswer, type SignerState, type SignField, type SignState,
} from "@/lib/signing";

export function SignPage() {
  const token = useParams().token ?? "";
  const [answer, setAnswer] = useState<OpenAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(() => signSession.get(token));
  const [done, setDone] = useState<{ finishing: boolean } | null>(null);
  useReferrerOff();

  const open = useCallback(async () => {
    setError(null);
    try {
      const a = await signApi.open(token);
      setAnswer(a);
      if (a.session) { signSession.set(token, a.session); setSession(a.session); }
      else if (a.state !== "active" || a.needs !== "ready") { signSession.set(token, null); setSession(null); }
    } catch (e) { setError(e instanceof Error ? e.message : "This page didn't load."); }
  }, [token]);
  useEffect(() => { void open(); }, [open]);

  const ended = useCallback(() => { signSession.set(token, null); setSession(null); void open(); }, [open, token]);

  if (error) return <Frame><Card icon={FileX2} title="This page didn't load" body={error} action={<Button onClick={open}>Try again</Button>} /></Frame>;
  if (!answer) return <Frame><div className="grid min-h-[50vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading" className="animate-spin" /></div></Frame>;
  const brief = answer.envelope;
  if (done && brief) return <Frame brief={brief}><DoneCard brief={brief} finishing={done.finishing} /></Frame>;
  if (answer.state !== "active" || !brief) return <Frame brief={brief}><DeadEnd answer={answer} retry={open} /></Frame>;
  if (answer.needs === "identity") return <Frame brief={brief}><IdentityStep token={token} brief={brief} onPassed={open} /></Frame>;
  if (answer.needs === "consent" || !session) {
    return <Frame brief={brief}><ConsentStep brief={brief} disclosure={answer.disclosure} onAgree={async () => {
      const a = await signApi.consent(token, answer.disclosure?.version ?? 1);
      if (a.session) { signSession.set(token, a.session); setSession(a.session); setAnswer({ ...answer, needs: "ready" }); }
      else setAnswer({ ...answer, ...a });
    }} /></Frame>;
  }
  return <SigningView brief={brief} session={session} onEnded={ended} onDone={(finishing) => { signSession.set(token, null); setDone({ finishing }); }} />;
}

/** No referrer leaves a signing page, so its link never reaches another site. */
function useReferrerOff() {
  useEffect(() => {
    const m = document.createElement("meta");
    m.name = "referrer"; m.content = "no-referrer";
    document.head.append(m);
    return () => m.remove();
  }, []);
}

// ── Frames and cards ───────────────────────────────────────────────────────────────────────────────────────────────────

function OrgMark({ brief }: { brief?: Brief }) {
  const name = brief?.org_name || "Countersign";
  return brief?.logo ? <img src={brief.logo} alt="" className="size-8 rounded-md object-contain" />
    : <span aria-hidden className="grid size-8 place-items-center rounded-md bg-primary font-serif text-sm text-primary-foreground">{name[0]}</span>;
}

function Frame({ brief, children }: { brief?: Brief; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-paper text-foreground">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <OrgMark brief={brief} />
          <span className="font-medium">{brief?.org_name || "Countersign"}</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}

function Card({ icon: Icon, title, body, action, tone = "neutral" }: { icon: typeof FileX2; title: string; body: React.ReactNode; action?: React.ReactNode; tone?: "neutral" | "ok" | "warn" }) {
  return (
    <div className="mx-auto max-w-xl rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
      <span className={cn("grid size-12 place-items-center rounded-full", tone === "ok" ? "bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-[var(--success)]" : tone === "warn" ? "bg-[color-mix(in_oklch,var(--warning)_14%,transparent)] text-[var(--warning)]" : "bg-muted text-muted-foreground")}>
        <Icon aria-hidden className="size-6" />
      </span>
      <h1 className="mt-4 text-xl font-semibold text-balance">{title}</h1>
      <div className="mt-2 text-muted-foreground">{body}</div>
      {action ? <div className="mt-6 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

function Contact({ brief }: { brief?: Brief }) {
  if (!brief?.sender_name && !brief?.reply_to) return null;
  return <p className="mt-3 text-sm">Questions? Contact {brief.sender_name ?? "the sender"}{brief.reply_to ? <> at <a className="underline" href={`mailto:${brief.reply_to}`}>{brief.reply_to}</a></> : null}.</p>;
}

const DEAD_ENDS: Record<Exclude<SignState, "active">, { icon: typeof FileX2; title: string; body: (b?: Brief, a?: OpenAnswer) => string; tone?: "ok" | "warn" }> = {
  not_found: { icon: FileX2, title: "This link doesn't work", body: () => "Check that you opened the whole link from your email. If it still doesn't work, ask the sender for a new one." },
  replaced: { icon: FileX2, title: "This link no longer works", body: () => "The sender sent you a newer link, or changed your details. Check your email for the latest one, or ask the sender." },
  voided: { icon: XCircle, title: "The sender cancelled this document", body: (b) => `${b?.end_reason ? `Their reason: “${b.end_reason}”. ` : ""}You don't need to do anything.` },
  expired: { icon: Clock, title: "This signing link has expired", body: () => "The deadline to sign passed. Ask the sender to extend it, and your link will work again.", tone: "warn" },
  declined: { icon: XCircle, title: "This document was declined", body: (b) => `Someone declined it, so it won't be completed${b?.end_reason ? `: “${b.end_reason}”` : ""}. You don't need to do anything.` },
  finishing: { icon: Loader2, title: "Everyone has signed", body: (b) => b?.emailed === false ? `The signed copy is being made now. ${senderOf(b)} will send you your copy.` : "The signed copy is being made now. Everyone gets their own link to it by email.", tone: "ok" },
  completed: { icon: ShieldCheck, title: "This document is complete", body: (b) => b?.emailed === false ? `Everyone has signed it. Ask ${senderOf(b, true)} for your copy of the signed document.` : "Everyone has signed it. Your copy of the signed document was sent to you by email.", tone: "ok" },
  already_signed: { icon: Check, title: "You've already signed", body: (b) => b?.emailed === false ? `Thanks. When everyone has signed, ${senderOf(b, true)} will send you the signed copy.` : "Thanks. When everyone has signed, you'll get the signed copy by email.", tone: "ok" },
  not_your_turn: { icon: Clock, title: "It's not your turn yet", body: (b) => `${b?.ahead?.length ? `${b.ahead.map((x) => x.name || x.role_name).join(" and ")} ${b.ahead.length === 1 ? "signs" : "sign"} first. ` : ""}${b?.emailed === false ? `Open this link again once they have.` : "We'll email you when it's ready for you."}` },
  rate_limited: { icon: Lock, title: "Too many tries", body: (_b, a) => `For your security, wait ${waitWords(a?.retry_after)} and try again.`, tone: "warn" },
  wrong_code: { icon: Lock, title: "That code didn't match", body: () => "Check the code and try again." },
};

function DeadEnd({ answer, retry }: { answer: OpenAnswer; retry: () => void }) {
  const d = DEAD_ENDS[answer.state as Exclude<SignState, "active">] ?? DEAD_ENDS.not_found;
  return (
    <Card icon={d.icon} tone={d.tone} title={d.title}
      body={<><p>{d.body(answer.envelope, answer)}</p>{answer.envelope?.title ? <p className="mt-3 text-sm text-foreground">“{answer.envelope.title}”</p> : null}<Contact brief={answer.envelope} /></>}
      action={answer.state === "rate_limited" || answer.state === "finishing" ? <Button variant="outline" onClick={retry}>Check again</Button> : undefined} />
  );
}

/** Who to look to for the signed copy when email isn't set up: the sender by name, or plainly "the sender". */
const senderOf = (b: Brief | undefined, lower = false) => b?.sender_name || (lower ? "the sender" : "The sender");

function DoneCard({ brief, finishing }: { brief: Brief; finishing: boolean }) {
  return (
    <Card icon={Check} tone="ok"
      title={finishing ? "You're done, and everyone has signed" : "You're done"}
      body={<>
        <p>{brief.emailed === false
          ? finishing ? `The signed copy is being made now. ${senderOf(brief)} will send you your copy.` : `Thanks for signing. When everyone else has signed, ${senderOf(brief, true)} will send you the signed copy.`
          : finishing ? "The signed copy is being made now. You'll get your own link to it by email in a moment." : "Thanks for signing. We'll email you the signed copy once everyone else has signed."}</p>
        <p className="mt-3 text-sm text-foreground">“{brief.title}”</p>
        <Contact brief={brief} />
      </>} />
  );
}

// ── Identity and consent ────────────────────────────────────────────────────────────────────────────────────────────────

function IdentityStep({ token, brief, onPassed }: { token: string; brief: Brief; onPassed: () => void }) {
  const emailed = brief.recipient.identity_check === "email_code";
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setNote(null);
    try {
      const a = await signApi.sendCode(token);
      if (a.state === "rate_limited") setNote(`You've asked for a few codes. Wait ${waitWords(a.retry_after)}, then ask again.`);
      else setSent(a.sent_to ?? brief.recipient.email);
    } catch (e) { setNote(e instanceof Error ? e.message : "The code didn't send. Try again."); }
    finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setNote(null);
    try {
      const a = await signApi.identity(token, code.trim());
      if (a.ok) onPassed();
      else if (a.state === "wrong_code") setNote(a.tries_left != null && a.tries_left <= 3 ? `That code didn't match. ${Math.max(0, a.tries_left)} ${a.tries_left === 1 ? "try" : "tries"} left.` : "That code didn't match. Check it and try again.");
      else if (a.state === "rate_limited") setNote(`Too many tries. Wait ${waitWords(a.retry_after)}, then try again.`);
      else onPassed();
    } catch (e) { setNote(e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-md rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
      <span className="grid size-12 place-items-center rounded-full bg-muted"><Lock aria-hidden className="size-5" /></span>
      <h1 className="mt-4 text-xl font-semibold">Confirm it's you</h1>
      <p className="mt-1 text-muted-foreground">
        {emailed
          ? sent ? <>We sent a 6-digit code to <strong className="text-foreground">{sent}</strong>. It works for 10 minutes.</> : <>{brief.sender_name ?? "The sender"} asked us to check your email before you sign “{brief.title}”.</>
          : <>{brief.sender_name ?? "The sender"} gave you an access code for “{brief.title}”. Enter it to continue.</>}
      </p>
      {emailed && !sent ? (
        <Button className="mt-6 w-full" onClick={send} disabled={busy}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : <Mail aria-hidden />}Email me a code</Button>
      ) : (
        <form className="mt-6 grid gap-3" onSubmit={(e) => { e.preventDefault(); void check(); }}>
          <div className="grid gap-1.5">
            <Label htmlFor="code">{emailed ? "Code" : "Access code"}</Label>
            <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode={emailed ? "numeric" : undefined} maxLength={40} autoFocus className={cn(emailed && "text-center font-mono text-lg tracking-[0.4em]")} />
          </div>
          <Button type="submit" disabled={busy || !code.trim()}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Continue</Button>
          {emailed ? <Button type="button" variant="ghost" onClick={send} disabled={busy}>Send a new code</Button> : null}
        </form>
      )}
      {note ? <p role="alert" className="mt-3 text-sm text-destructive">{note}</p> : null}
      <Contact brief={brief} />
    </div>
  );
}

function ConsentStep({ brief, disclosure, onAgree }: { brief: Brief; disclosure?: { version: number; text: string }; onAgree: () => Promise<void> }) {
  const [agree, setAgree] = useState(false);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = useMemo(() => brief.page_count, [brief.page_count]);
  return (
    <div className="mx-auto max-w-xl">
      <p className="text-sm text-muted-foreground">{brief.sender_name ?? "Someone"} asked you to sign</p>
      <h1 className="mt-1 text-2xl font-semibold text-balance">{brief.title}</h1>
      {brief.message ? <blockquote className="mt-4 rounded-lg border-l-4 border-primary bg-card px-4 py-3 text-sm whitespace-pre-line">{brief.message}</blockquote> : null}
      <p className="mt-4 text-sm text-muted-foreground">{count} {count === 1 ? "page" : "pages"}{brief.expires_at ? ` · sign by ${new Date(brief.expires_at).toLocaleDateString(undefined, { dateStyle: "medium" })}` : ""}</p>
      <section className="mt-6 rounded-xl border bg-card p-5" aria-labelledby="consent-h">
        <h2 id="consent-h" className="font-semibold">Electronic records and signatures</h2>
        <div className={cn("mt-2 text-sm whitespace-pre-line text-muted-foreground", !full && "line-clamp-4")}>{disclosure?.text}</div>
        <button type="button" className="focus-ring mt-1 inline-flex items-center gap-1 rounded-sm text-sm underline" onClick={() => setFull((v) => !v)} aria-expanded={full}>
          {full ? "Show less" : "Read the full disclosure"}<ChevronDown aria-hidden className={cn("size-3.5 transition-transform", full && "rotate-180")} />
        </button>
        <label className="mt-4 flex items-start gap-3 text-sm">
          <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} className="mt-0.5" aria-describedby="consent-note" />
          <span className="font-medium">I agree to use electronic records and signatures</span>
        </label>
        <p id="consent-note" className="mt-3 text-caption text-muted-foreground">Your email, IP address and the time are recorded with your consent. Disclosure version {disclosure?.version ?? 1}.</p>
      </section>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
      <Button className="mt-6 w-full sm:w-auto" disabled={!agree || busy} onClick={async () => { setBusy(true); setError(null); try { await onAgree(); } catch (e) { setError(e instanceof Error ? e.message : "That didn't work. Try again."); } finally { setBusy(false); } }}>
        {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Review the document
      </Button>
      <Contact brief={brief} />
    </div>
  );
}

// ── Signing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function SigningView({ brief, session, onEnded, onDone }: { brief: Brief; session: string; onEnded: () => void; onDone: (finishing: boolean) => void }) {
  const [state, setState] = useState<SignerState | null>(null);
  const [file, setFile] = useState<Blob | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adopt, setAdopt] = useState<null | { kind: "signature" | "initials"; field: SignField }>(null);
  const [declining, setDeclining] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [live, setLive] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const role = brief.recipient.role;

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof SignError && e.ended) { onEnded(); return undefined; }
      setToast(e instanceof Error ? e.message : "That didn't save. Try again.");
      return undefined;
    }
  }, [onEnded]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, f] = await Promise.all([signApi.state(session), signApi.document(session)]);
      setState(s); setFile(f);
    } catch (e) {
      if (e instanceof SignError && e.ended) onEnded();
      else setLoadError(e instanceof Error ? e.message : "The document didn't load.");
    }
  }, [session, onEnded]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  const ordered = useMemo(() => fieldOrder(state?.fields ?? []), [state?.fields]);
  const left = ordered.filter(needsSigner);
  const total = ordered.filter((f) => f.required && !["name", "email", "date"].includes(f.type)).length;
  const doneCount = total - left.length;
  const mark = (kind: "signature" | "initials") => state?.marks.find((m) => m.kind === kind);

  const setField = (f: SignField) => setState((s) => (s ? { ...s, fields: s.fields.map((x) => (x.id === f.id ? { ...x, ...f } : x)) } : s));
  const save = async (f: SignField, value: string) => {
    const saved = await guard(() => signApi.fill(session, f.id, value));
    if (saved) { setField({ ...f, value: saved.value ?? null, filled_at: saved.filled_at ?? null }); setLive(`${FIELD_LABEL[f.type]} saved. ${Math.max(0, left.length - (needsSigner(f) && value ? 1 : 0))} left.`); }
    return !!saved;
  };
  /** After a field is done, the keyboard moves on: to the next field still needed, or to the finish button. */
  const advanceFrom = (f: SignField) => {
    const next = left.find((x) => x.id !== f.id);
    setTimeout(() => {
      if (next) { setCurrent(next.id); const el = document.getElementById(`field-${next.id}`); el?.scrollIntoView({ behavior: "smooth", block: "center" }); el?.focus({ preventScroll: true }); }
      else document.getElementById("sign-finish")?.focus();
    }, 350);
  };
  const signField = async (f: SignField) => {
    const kind = f.type === "initials" ? "initials" : "signature";
    if (f.filled_at) { await save(f, ""); return; }
    if (!mark(kind)) { setAdopt({ kind, field: f }); return; }
    if (await save(f, "adopted")) advanceFrom(f);
  };
  const onAdopted = async (a: Adopted) => {
    if (!adopt) return;
    const ok = await guard(() => signApi.adopt(session, adopt.kind, a.method, a.pngB64));
    if (!ok) throw new Error("Your signature didn't save. Try again.");
    // Initials come in the same style as a typed signature, ready for when they're needed.
    const extra = adopt.kind === "signature" && a.method === "typed" && !mark("initials")
      ? await typedPng(initialsOf(brief.recipient.name), a.style ?? 0).then((b) => guard(() => signApi.adopt(session, "initials", "typed", b)).then((r) => (r ? b : null)))
      : null;
    setState((s) => s ? { ...s, marks: [...s.marks.filter((m) => m.kind !== adopt.kind && !(extra && m.kind === "initials")), { kind: adopt.kind, method: a.method, png_b64: a.pngB64 }, ...(extra ? [{ kind: "initials" as const, method: "typed" as const, png_b64: extra }] : [])] } : s);
    const field = adopt.field;
    setAdopt(null);
    if (await save(field, "adopted")) advanceFrom(field);
  };
  const goNext = () => {
    const next = left[0];
    if (!next) return;
    setCurrent(next.id);
    document.getElementById(`field-${next.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => document.getElementById(`field-${next.id}`)?.focus({ preventScroll: true }), 350);
  };
  const finish = async () => {
    setFinishing(true);
    const r = await guard(() => signApi.finish(session));
    setFinishing(false);
    if (r) onDone(r.finishing);
  };

  if (loadError) return <Frame brief={brief}><Card icon={FileX2} title="The document didn't load" body={loadError} action={<Button onClick={load}>Try again</Button>} /></Frame>;
  if (!state || !file) return <Frame brief={brief}><div className="grid min-h-[50vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading the document" className="animate-spin" /></div></Frame>;

  const verb = role === "approver" ? "Approve" : role === "viewer" ? "Confirm you've read it" : "Sign and finish";
  const overlay = (page: number, size: PageSize) => (
    <>
      {state.others.filter((o) => o.page === page && o.value).map((o) => (
        <div key={`o${o.id}`} className="absolute flex items-center overflow-hidden rounded-[3px] border border-dashed border-[color-mix(in_oklch,var(--success)_45%,transparent)] px-1 text-[0.625rem] text-[var(--success)]"
          style={{ left: o.x * size.width, top: o.y * size.height, width: o.w * size.width, height: o.h * size.height }} title={`Filled by ${o.owner_name ?? "someone"}`}>
          <span className="truncate">{o.type === "signature" || o.type === "initials" ? `Signed by ${o.owner_name ?? "someone"}` : o.type === "checkbox" ? (o.value === "true" ? "✓" : "") : o.value}</span>
        </div>
      ))}
      {state.fields.filter((f) => f.page === page).map((f) => (
        <FieldWidget key={f.id} f={f} size={size} current={current === f.id} mark={f.type === "initials" ? mark("initials") : mark("signature")}
          onSign={() => void signField(f)} onSave={(v) => save(f, v)} onFocus={() => setCurrent(f.id)} onDone={() => advanceFrom(f)} />
      ))}
    </>
  );

  return (
    <div className="flex min-h-dvh flex-col bg-paper text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-3 py-2 sm:px-4">
          <OrgMark brief={brief} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{brief.title}</p>
            <p className="truncate text-caption text-muted-foreground">{brief.sender_name ?? "Someone"} at {brief.org_name ?? "their organisation"} sent this for your {role === "approver" ? "approval" : "signature"}</p>
          </div>
          {total > 0 && (
            <div className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex" aria-hidden>
              <span className="relative grid size-7 place-items-center rounded-full" style={{ background: `conic-gradient(var(--primary) ${(doneCount / total) * 360}deg, var(--border) 0)` }}>
                <span className="size-5 rounded-full bg-background" />
              </span>
              {doneCount} of {total}
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => setDeclining(true)}>{role === "approver" ? "Reject" : "Decline"}</Button>
        </div>
        {total > 0 ? <div className="h-1 bg-muted sm:hidden" aria-hidden><div className="h-full bg-primary transition-[width]" style={{ width: `${(doneCount / total) * 100}%` }} /></div> : null}
      </header>
      <p className="sr-only" aria-live="polite">{live}</p>
      <main className="flex-1 px-2 py-4 pb-40 sm:px-6 sm:py-8">
        <DocumentView file={file} pageCount={state.page_count} pages={state.pages} label={`${brief.title}, to sign`} renderOverlay={overlay} />
      </main>
      <footer className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
          {left.length ? (
            <Button onClick={goNext} className="bg-sign text-sign-ink hover:bg-[color-mix(in_oklch,var(--sign)_88%,black)]">
              {doneCount === 0 ? "Start" : "Next field"}<ChevronDown aria-hidden />
            </Button>
          ) : null}
          <p className="order-last w-full text-caption text-muted-foreground sm:order-none sm:w-auto sm:flex-1">
            By selecting “{verb}”, you agree that your electronic signature is the legal equivalent of your handwritten signature on this document.
          </p>
          <Button id="sign-finish" onClick={finish} disabled={left.length > 0 || finishing} className="ml-auto" title={left.length ? `${left.length} required ${left.length === 1 ? "field" : "fields"} left` : undefined}>
            {finishing ? <Loader2 aria-hidden className="animate-spin" /> : <PenLine aria-hidden />}{verb}
          </Button>
          {left.length ? <span className="sr-only">{left.length} required {left.length === 1 ? "field" : "fields"} left before you can finish.</span> : null}
        </div>
      </footer>
      {toast ? <div role="alert" className="fixed inset-x-4 bottom-24 z-30 mx-auto max-w-md rounded-lg border bg-card px-4 py-3 text-sm shadow-lg">{toast}</div> : null}
      <AdoptDialog open={!!adopt} kind={adopt?.kind ?? "signature"} name={brief.recipient.name} onClose={() => setAdopt(null)} onAdopt={onAdopted} />
      <DeclineDialog open={declining} approver={role === "approver"} onClose={() => setDeclining(false)}
        onDecline={async (reason) => { const r = await guard(() => signApi.decline(session, reason)); if (r) onEnded(); }} />
    </div>
  );
}

function FieldWidget({ f, size, current, mark, onSign, onSave, onFocus, onDone }: {
  f: SignField; size: PageSize; current: boolean; mark?: { png_b64: string }; onSign: () => void; onSave: (v: string) => Promise<boolean>; onFocus: () => void; onDone: () => void;
}) {
  const [value, setValue] = useState(f.value ?? "");
  const saved = useRef(f.value ?? "");
  useEffect(() => { setValue(f.value ?? ""); saved.current = f.value ?? ""; }, [f.value]);
  const box = { left: f.x * size.width, top: f.y * size.height, width: f.w * size.width, height: f.h * size.height };
  const filled = !!f.filled_at;
  const auto = f.type === "name" || f.type === "email" || f.type === "date";
  const label = `${FIELD_LABEL[f.type]}${f.label ? `, ${f.label}` : ""}${f.required && !auto ? ", required" : ""}, page ${f.page}`;
  const base = cn("absolute rounded-[4px] text-[0.6875rem] font-semibold",
    auto ? "border border-dashed border-input bg-transparent text-muted-foreground"
      : filled ? "border border-[color-mix(in_oklch,var(--success)_40%,transparent)] bg-transparent"
      : "border-[1.5px] border-dashed border-[color-mix(in_oklch,var(--sign)_70%,black)] bg-sign-soft text-sign-ink",
    current && !filled && "border-2 border-solid bg-sign shadow-[0_0_0_5px_color-mix(in_oklch,var(--sign)_35%,transparent)]");
  const commit = async () => { if (value !== saved.current) { if (await onSave(value)) saved.current = value; else setValue(saved.current); } };

  if (auto) return <div id={`field-${f.id}`} className={cn(base, "flex items-center px-1.5")} style={box} aria-label={`${label}, fills in when you finish`}><span className="truncate">{box.width < 140 ? FIELD_LABEL[f.type] : `${FIELD_LABEL[f.type]} · fills in when you finish`}</span></div>;
  if (f.type === "signature" || f.type === "initials") {
    return (
      <button id={`field-${f.id}`} type="button" className={cn(base, "focus-ring flex items-center justify-center overflow-hidden px-1")} style={box} onClick={onSign} onFocus={onFocus} aria-label={filled ? `${label}, signed. Select to remove.` : label}>
        {filled && mark ? <img src={`data:image/png;base64,${mark.png_b64}`} alt="" className="max-h-full max-w-full object-contain" /> : <span className="flex items-center gap-1 truncate"><PenLine aria-hidden className="size-3 shrink-0" />{box.width < 64 ? null : f.type === "initials" ? "Initial" : "Sign here"}</span>}
      </button>
    );
  }
  if (f.type === "checkbox") {
    const on = value === "true";
    return (
      <button id={`field-${f.id}`} type="button" role="checkbox" aria-checked={on} aria-label={f.label || label} onFocus={onFocus}
        className={cn(base, "focus-ring grid place-items-center before:absolute before:-inset-2.5 before:content-['']")} style={box} onClick={async () => { const v = on ? "false" : "true"; setValue(v); if (!(await onSave(v))) setValue(saved.current); else saved.current = v; }}>
        {on ? <Check aria-hidden className="size-[80%] text-foreground" /> : null}
      </button>
    );
  }
  if (f.type === "radio" || f.type === "dropdown") {
    return (
      <select id={`field-${f.id}`} aria-label={label} value={value} onFocus={onFocus}
        onChange={async (e) => { const v = e.target.value; setValue(v); if (!(await onSave(v))) setValue(saved.current); else saved.current = v; }}
        className={cn(base, "focus-ring appearance-auto px-1 text-[0.75rem] font-medium text-foreground")} style={box}>
        <option value="">{f.label || "Choose…"}</option>
        {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input id={`field-${f.id}`} aria-label={label} value={value} onFocus={onFocus} onChange={(e) => setValue(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) { e.preventDefault(); void commit().then(onDone); } }}
      inputMode={f.type === "number" ? "decimal" : undefined} maxLength={f.validation?.max_length ?? 500} placeholder={f.label || (f.type === "number" ? "Number" : "Type here")}
      className={cn(base, "focus-ring px-1.5 text-[0.75rem] font-medium text-foreground placeholder:text-sign-ink/70")} style={box} />
  );
}

function DeclineDialog({ open, approver, onClose, onDecline }: { open: boolean; approver: boolean; onClose: () => void; onDecline: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{approver ? "Reject this document?" : "Decline to sign?"}</DialogTitle>
          <DialogDescription>This ends the document for everyone. The sender sees your reason, so they can fix it and send a new one.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="decline-reason">Reason</Label>
          <Textarea id="decline-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="The start date should be 1 December." />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Go back</Button>
          <Button variant="destructive" disabled={!reason.trim() || busy} onClick={async () => { setBusy(true); await onDecline(reason.trim()); setBusy(false); }}>
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}{approver ? "Reject" : "Decline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
