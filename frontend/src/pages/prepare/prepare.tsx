// Prepare and send: one screen, three steps, with the document always in reach. Recipients (who, in what role and order, and
// how they prove who they are), Fields (where each person fills in), and Review (the email, deadline and reminders, and anything
// that still blocks sending). Everything saves as you go; the last save wins. Sending shows each person's link when email
// isn't set up.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Loader2, Mail, PenLine, Plus, Send, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoadError, Segmented, useLoad } from "@/components/kit";
import { cn } from "@/components/kit/cn";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMe } from "@/base/session";
import { useConfirm } from "@/components/confirm";
import {
  envelopesApi, fetchDocument, IDENTITY_LABEL, recipientColor, ROLE_LABEL, type IdentityCheck, type PrepareView, type Problem, type RecipientRole, type SendAnswer,
} from "@/lib/envelopes";
import { routePath } from "../../../../xano/routes.gen";
import { FieldsStep } from "./fields";
import {
  blankPerson, CAN_HAVE_FIELDS, fieldsFrom, fieldsPayload, normaliseSteps, peopleFrom, peoplePayload, personProblem, whoIs, type DraftField, type DraftPerson,
} from "./model";

type Step = "recipients" | "fields" | "review";
type SaveState = "saved" | "saving" | "error" | "idle";

export function PreparePage() {
  const id = Number(useParams().id);
  const view = useLoad(() => envelopesApi.prepare(id), [id]);
  const doc = useLoad(async () => {
    const got = await fetchDocument(routePath("GET envelopes/{id}/original", { id }), routePath("GET envelopes/{id}/original/raw", { id }));
    if ("error" in got) throw new Error(got.error);
    return got.blob;
  }, [id]);
  if (view.error) return <div className="mx-auto max-w-3xl p-8"><LoadError title="This document didn't open" error={view.error} onRetry={view.reload} /></div>;
  if (!view.data) return <div className="grid min-h-[60vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading" className="animate-spin" /></div>;
  return <Prepare key={id} initial={view.data} file={doc.data} fileError={doc.error} reloadFile={doc.reload} refresh={view.reload} />;
}

function Prepare({ initial, file, fileError, reloadFile, refresh }: { initial: PrepareView; file: Blob | null; fileError: unknown; reloadFile: () => void; refresh: () => void }) {
  const navigate = useNavigate();
  const narrow = useIsMobile();
  const env = initial.envelope;
  const editable = initial.editable;
  /** A template's rows are roles, filled in each time it's used, and it's saved rather than sent. */
  const template = !!env.is_template;
  const [step, setStep] = useState<Step>(initial.recipients.length ? (initial.fields.length ? "review" : "fields") : "recipients");
  const [ordered, setOrdered] = useState(env.signing_order === "ordered");
  const [people, setPeople] = useState<DraftPerson[]>(() => (initial.recipients.length ? peopleFrom(initial) : [blankPerson(1)]));
  const [fields, setFieldsState] = useState<DraftField[]>(() => fieldsFrom(initial));
  const [problems, setProblems] = useState<Problem[]>(initial.problems);
  const [settings, setSettings] = useState({
    title: env.title, subject: env.subject ?? "", message: env.message ?? "", expiry_days: env.expiry_days || 30,
    reminder_days: env.reminder_days ?? 3, visibility: env.visibility, signing_order: env.signing_order,
  });
  const [save, setSave] = useState<SaveState>("idle");
  const [sent, setSent] = useState<SendAnswer | null>(null);
  const [sending, setSending] = useState(false);
  const emailReady = initial.email.can_send;

  // ── Saving: people first (fields need their ids), then fields, then the envelope's settings. Last write wins. ──
  const pending = useRef({ people: false, fields: false, settings: false });
  const latest = useRef({ people, fields, settings, ordered });
  latest.current = { people, fields, settings, ordered };
  const timer = useRef<number>(0);
  const flush = useCallback(async () => {
    if (!editable) return;
    const p = pending.current;
    if (!p.people && !p.fields && !p.settings) return;
    pending.current = { people: false, fields: false, settings: false };
    setSave("saving");
    try {
      const cur = latest.current;
      if (p.settings || p.people) {
        await envelopesApi.update(env.id, { ...cur.settings, signing_order: cur.ordered ? "ordered" : "parallel" });
      }
      if (p.people) {
        const ready = cur.people.filter((x) => !personProblem(x, template));
        const saved = await envelopesApi.saveRecipients(env.id, peoplePayload(ready, cur.ordered));
        // The server answers the list in the order it was sent (its colour is its position), so match by position.
        const idOf = new Map(ready.map((x, i) => [x.key, saved[i]?.id]));
        setPeople((all) => all.map((x) => {
          const hit = idOf.get(x.key);
          return hit ? { ...x, id: hit, has_access_code: x.has_access_code || !!x.access_code.trim(), access_code: "" } : x;
        }));
        latest.current.people = latest.current.people.map((x) => {
          const hit = idOf.get(x.key);
          return hit ? { ...x, id: hit } : x;
        });
        p.fields = true;
      }
      if (p.fields) await envelopesApi.saveFields(env.id, fieldsPayload(latest.current.fields, latest.current.people));
      const fresh = await envelopesApi.prepare(env.id);
      setProblems(fresh.problems);
      setSave("saved");
    } catch (e) {
      setSave("error");
      toast.error(e instanceof Error ? e.message : "Your changes didn't save. Try again.");
    }
  }, [editable, env.id]);
  const queue = useCallback((what: keyof typeof pending.current) => {
    pending.current[what] = true;
    setSave("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 700);
  }, [flush]);
  useEffect(() => () => { window.clearTimeout(timer.current); void flush(); }, [flush]);

  const setFields = useCallback((fn: (f: DraftField[]) => DraftField[]) => { setFieldsState(fn); queue("fields"); }, [queue]);
  const editPeople = (fn: (p: DraftPerson[]) => DraftPerson[]) => { setPeople(fn); queue("people"); };
  const editSettings = (patch: Partial<typeof settings>) => { setSettings((s) => ({ ...s, ...patch })); queue("settings"); };

  const peopleIssues = people.map((p) => personProblem(p, template));
  const peopleOk = people.length > 0 && peopleIssues.every((x) => !x);
  const go = async (to: Step) => { window.clearTimeout(timer.current); await flush(); setStep(to); };

  const finishTemplate = async () => {
    window.clearTimeout(timer.current);
    await flush();
    toast.success("Template saved");
    navigate("/templates");
  };

  const send = async () => {
    window.clearTimeout(timer.current);
    await flush();
    setSending(true);
    try { setSent(await envelopesApi.send(env.id)); }
    catch (e) { toast.error(e instanceof Error ? e.message : "This document didn't send. Try again."); const fresh = await envelopesApi.prepare(env.id).catch(() => null); if (fresh) setProblems(fresh.problems); }
    finally { setSending(false); }
  };

  if (sent) return <SentScreen env={env} people={people} answer={sent} />;

  const steps: { value: Step; label: string; done: boolean }[] = [
    { value: "recipients", label: template ? "Roles" : "Recipients", done: peopleOk && !!people.some((p) => p.id) },
    { value: "fields", label: "Fields", done: fields.length > 0 },
    { value: "review", label: "Review", done: problems.length === 0 },
  ];

  return (
    <div className="flex h-[calc(100dvh-var(--header-h,3.5rem))] min-h-[32rem] flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-3 py-2 sm:px-4">
        <Button variant="ghost" size="sm" asChild><Link to={template ? "/templates" : "/"}><ArrowLeft aria-hidden />{template ? "Templates" : "Documents"}</Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{settings.title}</h1>
          <p className="text-caption text-muted-foreground" aria-live="polite">
            {!editable ? "Read only" : save === "saving" ? "Saving…" : save === "error" ? "Not saved" : save === "saved" ? (template ? "Template · saved" : "Draft · saved") : template ? "Template" : "Draft"}
            {save === "error" ? <button type="button" className="ml-2 underline" onClick={() => { pending.current = { people: true, fields: true, settings: true }; void flush(); }}>Retry</button> : null}
          </p>
        </div>
        <nav aria-label="Steps" className="order-last flex w-full items-center gap-1 overflow-x-auto sm:order-none sm:w-auto">
          {steps.map((s, i) => (
            <div key={s.value} className="flex items-center gap-1">
              {i > 0 && <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />}
              <button type="button" onClick={() => void go(s.value)} aria-current={step === s.value ? "step" : undefined}
                disabled={s.value !== "recipients" && !peopleOk}
                className={cn("focus-ring flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm disabled:opacity-50", step === s.value ? "bg-card font-medium ring-1 ring-border" : "text-muted-foreground hover:text-foreground")}>
                <span className={cn("grid size-5 place-items-center rounded-full border text-[0.6875rem] font-semibold", s.done && step !== s.value ? "border-primary bg-primary text-primary-foreground" : step === s.value ? "border-primary text-primary-text" : "border-input")}>
                  {s.done && step !== s.value ? <Check aria-hidden className="size-3" /> : i + 1}
                </span>
                {s.label}
              </button>
            </div>
          ))}
        </nav>
        {step === "recipients" && <Button size="sm" onClick={() => void go("fields")} disabled={!peopleOk}>Continue</Button>}
        {step === "fields" && <Button size="sm" onClick={() => void go("review")}>Continue</Button>}
        {step === "review" && template && <Button size="sm" onClick={finishTemplate} disabled={!editable || save === "saving"}><Check aria-hidden />Save template</Button>}
        {step === "review" && !template && <Button size="sm" onClick={send} disabled={!editable || sending || save === "saving" || problems.length > 0}>{sending ? <Loader2 aria-hidden className="animate-spin" /> : <Send aria-hidden />}Send</Button>}
      </div>

      {!editable && (
        <p className="border-b bg-paper px-4 py-2 text-sm text-muted-foreground">
          {env.status !== "draft" ? "This document has been sent, so it can't be changed here. " : "Only the person who started this document can change it. "}
          <Link to={`/documents/${env.id}`} className="underline">Open its page</Link>.
        </p>
      )}

      {step === "recipients" ? (
        <RecipientsStep template={template} people={people} issues={peopleIssues} ordered={ordered} editable={editable} emailReady={emailReady}
          setOrdered={(v) => { setOrdered(v); editPeople((p) => (v ? normaliseSteps(p.map((x, i) => ({ ...x, step: i + 1 }))) : p.map((x) => ({ ...x, step: 1 })))); }}
          edit={editPeople} fields={fields} />
      ) : step === "fields" ? (
        file ? (
          <FieldsStep file={file} pageCount={env.page_count} pages={env.pages ?? []} people={people.filter((p) => p.id)} fields={fields} setFields={setFields} editable={editable} narrow={narrow} />
        ) : fileError ? (
          <div className="p-6"><LoadError title="The document didn't load" error={fileError} onRetry={reloadFile} /></div>
        ) : <div className="grid flex-1 place-items-center text-muted-foreground"><Loader2 aria-label="Loading the document" className="animate-spin" /></div>
      ) : (
        <ReviewStep template={template} settings={settings} edit={editSettings} problems={problems} editable={editable} onFix={(p) => setStep(p.code === "no_options" || p.code === "no_signature" ? "fields" : p.code === "no_document" ? "review" : "recipients")} emailReady={emailReady} people={people} onRefresh={refresh} />
      )}
    </div>
  );
}

const ROLES: RecipientRole[] = ["signer", "approver", "viewer", "cc"];
const CHECKS: IdentityCheck[] = ["none", "access_code", "email_code"];

function RecipientsStep({ template, people, issues, ordered, editable, emailReady, setOrdered, edit, fields }: {
  template: boolean; people: DraftPerson[]; issues: string[]; ordered: boolean; editable: boolean; emailReady: boolean;
  setOrdered: (v: boolean) => void; edit: (fn: (p: DraftPerson[]) => DraftPerson[]) => void; fields: DraftField[];
}) {
  const me = useMe();
  const set = (key: string, patch: Partial<DraftPerson>) => edit((all) => all.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const move = (i: number, d: -1 | 1) => edit((all) => {
    const n = [...all]; const j = i + d;
    if (j < 0 || j >= n.length) return all;
    [n[i], n[j]] = [n[j], n[i]];
    return ordered ? normaliseSteps(n.map((x, k) => ({ ...x, step: k + 1 }))) : n;
  });
  const [confirm, confirmDialog] = useConfirm();
  const remove = async (p: DraftPerson) => {
    const count = fields.filter((f) => f.person === p.key).length;
    if (count && !(await confirm({ title: `Remove ${whoIs(p)}?`, body: `Their ${count} ${count === 1 ? "field goes" : "fields go"} too.`, action: "Remove", destructive: true }))) return;
    edit((all) => all.filter((x) => x.key !== p.key));
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{template ? "Who signs it?" : "Who's signing?"}</h2>
            <p className="text-sm text-muted-foreground">{template
              ? "Name each role. Leave the name and email blank to fill them in each time, or set them for someone who's always the same."
              : "Add everyone who signs, approves or views it, and anyone who should get the signed copy."}</p>
          </div>
          <Segmented label="Signing order" value={ordered ? "ordered" : "parallel"} onChange={(v) => setOrdered(v === "ordered")} options={[
            { value: "parallel", label: "Everyone at once" }, { value: "ordered", label: "In order" },
          ]} />
        </div>
        {confirmDialog}
        <ol className="flex flex-col gap-3">
          {people.map((p, i) => (
            <li key={p.key} className="rounded-lg border bg-card p-3 sm:p-4" style={{ borderLeft: `4px solid ${recipientColor(i + 1)}` }}>
              <div className="flex items-start gap-2">
                {ordered && (
                  <div className="flex flex-col items-center gap-0.5 pt-1">
                    <span className="grid size-6 place-items-center rounded-full bg-muted text-[0.6875rem] font-semibold" aria-label={`Step ${p.step}`}>{p.step}</span>
                    <Button size="icon" variant="ghost" className="size-7" aria-label={`Move ${whoIs(p)} earlier`} disabled={!editable || i === 0} onClick={() => move(i, -1)}><ChevronUp aria-hidden /></Button>
                    <Button size="icon" variant="ghost" className="-mt-1 size-7" aria-label={`Move ${whoIs(p)} later`} disabled={!editable || i === people.length - 1} onClick={() => move(i, 1)}><ChevronDown aria-hidden /></Button>
                  </div>
                )}
                <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                  {template && (
                    <div className="grid gap-1.5 sm:col-span-2">
                      <Label htmlFor={`rolename-${p.key}`}>Role</Label>
                      <Input id={`rolename-${p.key}`} disabled={!editable} value={p.role_name} maxLength={60} autoComplete="off" placeholder="Client" onChange={(e) => set(p.key, { role_name: e.target.value })} />
                    </div>
                  )}
                  <div className="grid gap-1.5">
                    <Label htmlFor={`name-${p.key}`}>{template ? "Name (optional)" : "Name"}</Label>
                    <Input id={`name-${p.key}`} disabled={!editable} value={p.name} maxLength={120} autoComplete="off" placeholder={template ? "Filled in each time" : "Maya Chen"} onChange={(e) => set(p.key, { name: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`email-${p.key}`}>{template ? "Email (optional)" : "Email"}</Label>
                    <Input id={`email-${p.key}`} disabled={!editable} type="email" value={p.email} autoComplete="off" placeholder={template ? "Filled in each time" : "maya@example.com"} onChange={(e) => set(p.key, { email: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`role-${p.key}`}>{template ? "What they do" : "Role"}</Label>
                    <select id={`role-${p.key}`} disabled={!editable} value={p.role} onChange={(e) => set(p.key, { role: e.target.value as RecipientRole })} className="focus-ring h-9 rounded-md border border-input bg-card px-2 text-sm">
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  </div>
                  {p.role !== "cc" && (
                    <div className="grid gap-1.5">
                      <Label htmlFor={`check-${p.key}`}>How they prove who they are</Label>
                      <select id={`check-${p.key}`} disabled={!editable} value={p.identity_check} onChange={(e) => set(p.key, { identity_check: e.target.value as IdentityCheck })} className="focus-ring h-9 rounded-md border border-input bg-card px-2 text-sm">
                        {CHECKS.map((c) => <option key={c} value={c} disabled={c === "email_code" && !emailReady}>{IDENTITY_LABEL[c]}{c === "email_code" && !emailReady ? " (set up email first)" : ""}</option>)}
                      </select>
                    </div>
                  )}
                  {p.identity_check === "access_code" && p.role !== "cc" && (
                    <div className="grid gap-1.5 sm:col-span-2">
                      <Label htmlFor={`code-${p.key}`}>Access code</Label>
                      <Input id={`code-${p.key}`} disabled={!editable} value={p.access_code} maxLength={40} autoComplete="off" placeholder={p.has_access_code ? "Set. Type a new one to change it." : "4 to 40 characters"} onChange={(e) => set(p.key, { access_code: e.target.value })} />
                      <p className="text-caption text-muted-foreground">Give them this yourself, by phone or in person. It's never emailed.</p>
                    </div>
                  )}
                </div>
                <Button size="icon" variant="ghost" aria-label={`Remove ${whoIs(p)}`} disabled={!editable} onClick={() => void remove(p)}><Trash2 aria-hidden /></Button>
              </div>
              {issues[i] && (p.name || p.email || p.role_name) ? <p className="mt-2 flex items-center gap-1.5 text-caption text-[var(--warning)]"><TriangleAlert aria-hidden className="size-3.5" />{issues[i]}</p> : null}
            </li>
          ))}
        </ol>
        {template || (!emailReady && people.some((p) => p.identity_check === "email_code")) ? null : !emailReady ? (
          <p className="flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-caption text-muted-foreground">
            <Mail aria-hidden className="mt-0.5 size-3.5 shrink-0" />Email isn't set up yet, so when you send you'll get a link for each person to share yourself. <Link to="/settings" className="underline">Set up email</Link>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="w-fit" disabled={!editable || people.length >= 20} onClick={() => edit((all) => [...all, blankPerson(ordered ? Math.max(0, ...all.map((x) => x.step)) + 1 : 1)])}>
            <Plus aria-hidden />{template ? "Add a role" : "Add a person"}
          </Button>
          {!template && !people.some((p) => p.email.trim().toLowerCase() === me.email.toLowerCase()) ? (
            <Button variant="ghost" className="w-fit" disabled={!editable || people.length >= 20} onClick={() => edit((all) => {
              const blank = all.length === 1 && !all[0].name.trim() && !all[0].email.trim();
              const meRow = { ...blankPerson(ordered ? Math.max(0, ...all.map((x) => x.step)) + 1 : 1), name: me.name, email: me.email };
              return blank ? [{ ...meRow, step: 1 }] : [...all, meRow];
            })}>
              <PenLine aria-hidden />Add me
            </Button>
          ) : null}
        </div>
        {people.some((p) => !CAN_HAVE_FIELDS(p.role)) ? <p className="text-caption text-muted-foreground">People who get a copy receive the signed document when everyone's done. They don't sign.</p> : null}
      </div>
    </div>
  );
}

function ReviewStep({ template, settings, edit, problems, editable, onFix, emailReady, people, onRefresh }: {
  settings: { title: string; subject: string; message: string; expiry_days: number; reminder_days: number; visibility: "private" | "team" };
  edit: (p: Partial<{ title: string; subject: string; message: string; expiry_days: number; reminder_days: number; visibility: "private" | "team" }>) => void;
  problems: Problem[]; editable: boolean; onFix: (p: Problem) => void; emailReady: boolean; people: DraftPerson[]; onRefresh: () => void; template: boolean;
}) {
  void onRefresh;
  const firstStep = people.filter((p) => p.role !== "cc" && p.step === Math.min(...people.filter((x) => x.role !== "cc").map((x) => x.step)));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto grid max-w-5xl gap-6 p-4 sm:p-8 lg:grid-cols-[1fr_20rem]">
        <section className="grid gap-5 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="review-email">
          <h2 id="review-email" className="text-lg font-semibold">The email</h2>
          <div className="grid gap-1.5">
            <Label htmlFor="r-title">Title</Label>
            <Input id="r-title" disabled={!editable} maxLength={200} value={settings.title} onChange={(e) => edit({ title: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="r-subject">Subject</Label>
            <Input id="r-subject" disabled={!editable} maxLength={200} value={settings.subject} placeholder={`Please sign: ${settings.title}`} onChange={(e) => edit({ subject: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="r-message">Message</Label>
            <Textarea id="r-message" disabled={!editable} maxLength={2000} rows={4} value={settings.message} placeholder="Anything they should know before they sign." onChange={(e) => edit({ message: e.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="r-expiry">Deadline (days)</Label>
              <Input id="r-expiry" type="number" min={1} max={365} disabled={!editable} value={settings.expiry_days} onChange={(e) => edit({ expiry_days: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="r-remind">Remind every (days)</Label>
              <Input id="r-remind" type="number" min={0} max={30} disabled={!editable} value={settings.reminder_days} onChange={(e) => edit({ reminder_days: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} />
              <p className="text-caption text-muted-foreground">{settings.reminder_days ? "Until they sign." : "No reminders."}</p>
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Visible to</span>
              <Segmented label="Visible to" value={settings.visibility} onChange={(v) => edit({ visibility: v })} options={[{ value: "team", label: "Team" }, { value: "private", label: "Me" }]} />
            </div>
          </div>
        </section>
        <aside className="flex flex-col gap-4">
          <section className="rounded-lg border bg-card p-4" aria-labelledby="review-checks">
            <h2 id="review-checks" className="mb-3 text-caption font-semibold uppercase tracking-wide text-muted-foreground">Before you send</h2>
            {problems.length === 0 ? (
              <p className="flex items-start gap-2 text-sm"><Check aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />Ready to send.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {problems.map((p, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                    <span className="flex-1">{p.message}</span>
                    <button type="button" className="focus-ring shrink-0 rounded-sm text-caption underline" onClick={() => onFix(p)}>Fix</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-lg border bg-card p-4 text-sm">
            <h2 className="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">What happens next</h2>
            <p className="text-muted-foreground">
              {template
                ? "Save it, and it's ready on the Templates page. Each time it's used you fill in the roles, check the details here, and send."
                : emailReady
                ? `We'll email ${firstStep.map((p) => p.name).filter(Boolean).join(" and ") || "the first signer"} a link to sign${people.length > firstStep.length ? ", then each next person as the one before finishes" : ""}.`
                : "Email isn't set up, so you'll get each person's link to share yourself. You can set up email in Settings at any time."}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SentScreen({ env, people, answer }: { env: PrepareView["envelope"]; people: DraftPerson[]; answer: SendAnswer }) {
  const me = useMe();
  const navigate = useNavigate();
  const [copied, setCopied] = useState<number | null>(null);
  const [opening, setOpening] = useState(false);
  // When the sender is among the first to sign, they can sign straight away: it's in their own "Action required" too.
  const actors = people.filter((p) => p.role !== "cc");
  const first = Math.min(...actors.map((p) => p.step));
  const mine = actors.find((p) => p.email.trim().toLowerCase() === me.email.toLowerCase() && p.step === first);
  const onlyMe = !!mine && actors.length === 1;
  const signNow = async () => {
    setOpening(true);
    try { const r = await envelopesApi.signAsMe(env.id); navigate(new URL(r.url).pathname); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Signing didn't open. Try again from the document's page."); setOpening(false); }
  };
  const names = people.filter((p) => p.role !== "cc").map((p) => p.name);
  const copy = async (url: string, id: number) => {
    try { await navigator.clipboard.writeText(url); setCopied(id); setTimeout(() => setCopied(null), 2000); }
    catch { toast.error("Couldn't copy. Select the link and copy it instead."); }
  };
  const list = useMemo(() => new Intl.ListFormat(undefined, { type: "conjunction" }).format(names.filter(Boolean)), [names]);
  return (
    <div className="grid min-h-[70vh] place-items-center bg-paper p-4">
      <div className="w-full max-w-xl rounded-2xl border bg-card p-6 sm:p-8">
        <span className="grid size-12 place-items-center rounded-full bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-[var(--success)]"><Send aria-hidden className="size-5" /></span>
        <h1 className="mt-4 text-xl font-semibold">{onlyMe ? "Ready for your signature" : answer.links.length ? "Ready to share" : "Sent"}</h1>
        <p className="mt-1 text-muted-foreground">
          {onlyMe
            ? "You're the only one signing, so nothing was emailed. Sign it now, and the signed copy is made as soon as you finish."
            : answer.links.length
            ? "Email isn't set up, so send each person their own link. Each link is shown once here; you can make a new one from the document's page."
            : `${env.title} is on its way to ${list || "everyone"}. You'll see each step on its page.`}
        </p>
        {answer.links.length > 0 && (
          <ul className="mt-5 flex flex-col gap-3">
            {answer.links.map((l) => (
              <li key={l.recipient_id} className="rounded-lg border bg-paper p-3">
                <p className="text-sm font-medium">{l.name} <span className="font-normal text-muted-foreground">· {l.email}</span></p>
                <div className="mt-2 flex gap-2">
                  <Input readOnly value={l.url} aria-label={`Signing link for ${l.name}`} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                  <Button variant="outline" onClick={() => copy(l.url, l.recipient_id)}>{copied === l.recipient_id ? <Check aria-hidden /> : <Copy aria-hidden />}{copied === l.recipient_id ? "Copied" : "Copy"}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {mine && !onlyMe ? <p className="mt-4 rounded-lg border bg-paper px-3 py-2 text-sm">You're one of the first to sign. Nothing was emailed to you: sign here, or later from “Action required”.</p> : null}
        <div className="mt-6 flex flex-wrap gap-2">
          {mine ? <Button onClick={signNow} disabled={opening} className="bg-sign text-sign-ink hover:bg-[color-mix(in_oklch,var(--sign)_88%,black)]">{opening ? <Loader2 aria-hidden className="animate-spin" /> : <PenLine aria-hidden />}Sign now</Button> : null}
          <Button asChild variant={mine ? "outline" : "default"}><Link to={`/documents/${env.id}`}>Open its page</Link></Button>
          <Button variant="outline" asChild><Link to="/">Back to documents</Link></Button>
        </div>
      </div>
    </div>
  );
}
