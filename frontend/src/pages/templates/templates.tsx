// Templates: documents prepared once and sent again and again. Each card shows its roles and what it's been used for. Use one
// to fill in the people and send (or check it first in Prepare), send it to a spreadsheet of people, or give it a public link
// anyone can sign from.
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Check, Copy, FilePlus2, Globe, LayoutTemplate, Loader2, MoreHorizontal, PenLine, Send, Trash2, TriangleAlert, Users } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@xano-sdk/rbac/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, LoadError, PageHeader, StatusBadge, useLoad } from "@/components/kit";
import { relative } from "@/components/kit/time";
import { recipientColor, ROLE_LABEL } from "@/lib/envelopes";
import { useLive } from "@/base/live";
import { EMAIL, openRoles, publicUrl, templatesApi, type PersonIn, type Template } from "@/lib/templates";

export function TemplatesPage() {
  const list = useLoad(() => templatesApi.list(), []);
  useLive("envelope", list.reload);
  const canSend = useCan("envelope.send");
  const canManage = useCan("template.manage");
  const [using, setUsing] = useState<Template | null>(null);
  const [sharing, setSharing] = useState<Template | null>(null);
  const [removing, setRemoving] = useState<Template | null>(null);
  const items = list.data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
      <PageHeader title="Templates" description="Prepare a document once, with roles where the people go, then send it whenever you need it."
        actions={canManage ? <Button asChild><Link to="/documents/new?template=1"><FilePlus2 aria-hidden />New template</Link></Button> : null} />
      {list.error ? <LoadError title="Templates didn't load" error={list.error} onRetry={list.reload} />
        : !list.data ? <Skeletons />
        : items.length === 0 ? (
          <EmptyState icon={LayoutTemplate} title="No templates yet"
            description={canManage ? "Start one from a PDF, or open any document and choose “Save as a template” from its menu." : "When an admin makes a template, it appears here for you to use."}
            action={canManage ? <Button asChild><Link to="/documents/new?template=1"><FilePlus2 aria-hidden />New template</Link></Button> : undefined} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {items.map((t) => (
              <TemplateCard key={t.id} t={t} canSend={canSend} canManage={canManage} onUse={() => setUsing(t)} onShare={() => setSharing(t)} onRemove={() => setRemoving(t)} />
            ))}
          </ul>
        )}
      {using ? <UseDialog t={using} onClose={() => setUsing(null)} /> : null}
      {sharing ? <PublicLinkDialog t={sharing} onClose={() => setSharing(null)} onChanged={list.reload} /> : null}
      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{removing?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Documents already sent from it aren't affected.{removing?.public_link?.enabled ? " Its public link stops working." : ""} This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={async () => {
              const t = removing; if (!t) return;
              try { await templatesApi.remove(t.id); toast.success("Template deleted"); list.reload(); }
              catch (e) { toast.error(e instanceof Error ? e.message : "It wasn't deleted. Try again."); }
            }}>Delete template</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Skeletons() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label="Loading templates">
      {[0, 1, 2, 3].map((i) => <li key={i} className="h-44 animate-pulse rounded-xl border bg-card" />)}
    </ul>
  );
}

function TemplateCard({ t, canSend, canManage, onUse, onShare, onRemove }: {
  t: Template; canSend: boolean; canManage: boolean; onUse: () => void; onShare: () => void; onRemove: () => void;
}) {
  const live = !!t.public_link?.enabled;
  return (
    <li className="flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><LayoutTemplate className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 font-medium">{t.title}</h2>
          <p className="text-caption text-muted-foreground">
            {t.page_count} {t.page_count === 1 ? "page" : "pages"} · {t.field_count} {t.field_count === 1 ? "field" : "fields"} · used {t.uses === 0 ? "never" : t.uses === 1 ? "once" : `${t.uses} times`}
          </p>
        </div>
        {live ? <StatusBadge tone="success" dot>Public link on</StatusBadge> : null}
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Roles">
        {t.roles.length === 0 ? <li className="text-caption text-muted-foreground">No roles yet. Edit it to add who signs.</li> : t.roles.map((r, i) => (
          <li key={r.id} className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption">
            <span aria-hidden className="size-2 rounded-full" style={{ background: recipientColor(i + 1) }} />
            {r.role_name || ROLE_LABEL[r.role]}
            {r.email ? <span className="text-muted-foreground">· {r.name || r.email}</span> : null}
          </li>
        ))}
      </ul>
      <div className="mt-auto flex items-center gap-2">
        {canSend ? <Button size="sm" onClick={onUse} disabled={t.roles.length === 0}><Send aria-hidden />Use</Button> : null}
        {canSend ? <Button size="sm" variant="outline" asChild><Link to={`/templates/${t.id}/bulk`}><Users aria-hidden />Send to many</Link></Button> : null}
        <span className="ml-auto hidden text-caption text-muted-foreground sm:inline">{t.updated_at ? `Edited ${relative(t.updated_at)}` : null}</span>
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8" aria-label={`More for ${t.title}`}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild><Link to={`/documents/${t.id}/prepare`}><PenLine aria-hidden />Edit</Link></DropdownMenuItem>
              <DropdownMenuItem onSelect={onShare}><Globe aria-hidden />Public link…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onRemove} className="text-destructive"><Trash2 aria-hidden />Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}

/** Fill in the people for each open role, then send now or check it first in Prepare. */
function UseDialog({ t, onClose }: { t: Template; onClose: () => void }) {
  const navigate = useNavigate();
  const open = openRoles(t);
  const fixed = t.roles.filter((r) => r.email);
  const [title, setTitle] = useState(t.title);
  const [people, setPeople] = useState<Record<number, { name: string; email: string }>>(() => Object.fromEntries(open.map((r) => [r.id, { name: "", email: "" }])));
  const [busy, setBusy] = useState<"" | "draft" | "send">("");
  const [tried, setTried] = useState(false);
  const problems = open.map((r) => {
    const p = people[r.id];
    if (!p?.name.trim()) return `Add a name for ${r.role_name}.`;
    if (!EMAIL.test(p.email.trim())) return `Check the email for ${r.role_name}.`;
    return "";
  });
  const ok = problems.every((x) => !x);
  const go = async (send: boolean) => {
    setTried(true);
    if (!ok && send) return;
    setBusy(send ? "send" : "draft");
    try {
      const list: PersonIn[] = open.map((r) => ({ role_id: r.id, name: people[r.id].name.trim(), email: people[r.id].email.trim() })).filter((p) => p.name || p.email);
      const made = await templatesApi.use(t.id, list, { title: title.trim(), send });
      if (send) {
        const shared = made.sent?.links.length ?? 0;
        toast.success(shared ? "Sent. Email isn't set up, so copy each person's link from this page." : "Sent");
        navigate(`/documents/${made.envelope_id}`);
      } else navigate(`/documents/${made.envelope_id}/prepare`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
      setBusy("");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Use “{t.title}”</DialogTitle>
          <DialogDescription>Fill in who's signing. Everything else comes from the template.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); void go(true); }}>
          <div className="grid gap-1.5">
            <Label htmlFor="use-title">Title</Label>
            <Input id="use-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </div>
          {open.map((r, i) => (
            <fieldset key={r.id} className="grid gap-2 rounded-lg border p-3" style={{ borderLeft: `4px solid ${recipientColor(t.roles.indexOf(r) + 1)}` }}>
              <legend className="px-1 text-sm font-medium">{r.role_name}{r.role_name.toLowerCase().startsWith(ROLE_LABEL[r.role].toLowerCase().split(" ")[0]) ? null : <span className="font-normal text-muted-foreground"> · {ROLE_LABEL[r.role].toLowerCase()}</span>}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-1">
                  <Label htmlFor={`use-name-${r.id}`} className="text-caption">Name</Label>
                  <Input id={`use-name-${r.id}`} value={people[r.id].name} maxLength={120} autoComplete="off" autoFocus={i === 0}
                    onChange={(e) => setPeople((p) => ({ ...p, [r.id]: { ...p[r.id], name: e.target.value } }))} />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`use-email-${r.id}`} className="text-caption">Email</Label>
                  <Input id={`use-email-${r.id}`} type="email" value={people[r.id].email} autoComplete="off"
                    onChange={(e) => setPeople((p) => ({ ...p, [r.id]: { ...p[r.id], email: e.target.value } }))} />
                </div>
              </div>
              {tried && problems[i] ? <p className="flex items-center gap-1.5 text-caption text-[var(--warning)]"><TriangleAlert aria-hidden className="size-3.5" />{problems[i]}</p> : null}
            </fieldset>
          ))}
          {fixed.length ? (
            <p className="text-caption text-muted-foreground">
              Always on it: {fixed.map((r) => `${r.name || r.email} (${r.role_name})`).join(", ")}.
            </p>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="outline" onClick={() => void go(false)} disabled={!!busy}>
              {busy === "draft" ? <Loader2 aria-hidden className="animate-spin" /> : <PenLine aria-hidden />}Check it first
            </Button>
            <Button type="submit" disabled={!!busy}>{busy === "send" ? <Loader2 aria-hidden className="animate-spin" /> : <Send aria-hidden />}Send now</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A template's public link: turn it on or off, copy it, and see what's stopping it if it can't be turned on. */
function PublicLinkDialog({ t, onClose, onChanged }: { t: Template; onClose: () => void; onChanged: () => void }) {
  const problems = useLoad(() => templatesApi.publicProblems(t.id), [t.id]);
  const [link, setLink] = useState(t.public_link);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blockers = problems.data ?? [];
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError(null);
    try { setLink(await templatesApi.setPublicLink(t.id, enabled)); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  };
  const url = link ? publicUrl(link.slug) : "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Public link</DialogTitle>
          <DialogDescription>
            Anyone with the link can sign their own copy of “{t.title}” as {t.roles[0]?.role_name ?? "the first role"}, after confirming their email with a code.
          </DialogDescription>
        </DialogHeader>
        {link?.enabled ? (
          <div className="grid gap-3">
            <div className="flex gap-2">
              <Input readOnly value={url} aria-label="Public link" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
              <Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(url).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">Signed {link.uses === 0 ? "by nobody yet" : link.uses === 1 ? "once" : `${link.uses} times`}. Each copy appears in Documents, sent by you.</p>
          </div>
        ) : problems.loading && !problems.data ? (
          <div className="grid place-items-center py-6 text-muted-foreground"><Loader2 aria-label="Checking the template" className="animate-spin" /></div>
        ) : blockers.length ? (
          <div className="grid gap-2 rounded-lg border bg-paper p-3">
            <p className="text-sm font-medium">Before it can have a public link</p>
            <ul className="grid gap-1.5 text-sm">
              {blockers.map((b) => <li key={b} className="flex items-start gap-2"><TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />{b}</li>)}
            </ul>
            <Button variant="outline" size="sm" className="w-fit" asChild><Link to={`/documents/${t.id}/prepare`}><PenLine aria-hidden />Edit the template</Link></Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{link ? "The link is off. Turn it on and the same address works again." : "Turn it on to get a link you can put on your website or in an email."}</p>
        )}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2">
          {link?.enabled
            ? <Button variant="outline" onClick={() => void toggle(false)} disabled={busy}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Turn off</Button>
            : <Button onClick={() => void toggle(true)} disabled={busy || blockers.length > 0 || (problems.loading && !problems.data)}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : <Globe aria-hidden />}Turn on</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
