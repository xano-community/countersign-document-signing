// Documents: the sender's home. What needs you comes first, and it's the only place signature yellow appears. Each row shows
// who's on the document and how far along it is; segments follow the envelope's real states.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { FilePlus2, FileSignature, FileText, Inbox, Loader2, Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AvatarStack, EmptyState, LoadError, PageHeader, SearchInput, Segmented, StatCard, StatusBadge, useLoad, useUrlState } from "@/components/kit";
import { relative } from "@/components/kit/time";
import { useCan } from "@xano-sdk/rbac/react";
import { useMe } from "@/base/session";
import { useLive } from "@/base/live";
import { envelopesApi, duration, STATUS_LABEL, STATUS_TONE, type EnvelopeRow, type PersonRow, type Segment } from "@/lib/envelopes";

const SEGMENTS: { value: Segment; label: string }[] = [
  { value: "action", label: "Action required" },
  { value: "waiting", label: "Waiting on others" },
  { value: "completed", label: "Completed" },
  { value: "drafts", label: "Drafts" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

const EMPTY: Record<Segment, { title: string; description: string }> = {
  action: { title: "Nothing needs you right now", description: "Documents waiting for your signature, and drafts you started, show up here." },
  waiting: { title: "Nothing is out for signature", description: "Send a document and you'll see who still has to sign it." },
  completed: { title: "No completed documents yet", description: "Once everyone signs, the sealed copy and its certificate land here." },
  drafts: { title: "No drafts", description: "Upload a PDF to start one." },
  ended: { title: "Nothing declined, cancelled or expired", description: "Documents that end without everyone signing show up here." },
  all: { title: "No documents yet", description: "Upload a PDF, add who signs, and send it." },
};

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/**
 * Once a session, tell the backend where the app is served (emails and signed copies need it). On a fresh demo that also writes
 * the demo's history and seals its signed documents, so the lists are fetched again a moment later.
 */
function useHello(refresh: () => void) {
  useEffect(() => {
    try { if (sessionStorage.getItem("app.hello")) return; sessionStorage.setItem("app.hello", "1"); } catch { /* storage off: say hello anyway */ }
    let timer = 0;
    envelopesApi.hello().then(() => { timer = window.setTimeout(refresh, 2500); }, () => undefined);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function DocumentsPage() {
  const me = useMe();
  const canSend = useCan("envelope.send");
  const [url, setUrl] = useUrlState({ view: "action", q: "" });
  const segment = (SEGMENTS.some((o) => o.value === url.view) ? url.view : "action") as Segment;
  const q = url.q;
  const setSegment = (v: Segment) => setUrl({ view: v });
  const setQ = (v: string) => setUrl({ q: v });
  const stats = useLoad(() => envelopesApi.stats(), []);
  const list = useLoad(() => envelopesApi.list({ segment, q }), [segment, q]);
  useLive("envelope", () => { stats.reload(); list.reload(); });
  useHello(() => { stats.reload(); list.reload(); });
  const firstName = (me.name ?? "").split(/\s+/)[0];

  const lead = useMemo(() => {
    const s = stats.data;
    if (!s) return "";
    const parts: string[] = [];
    parts.push(s.waiting_on_you === 0 ? "Nothing is waiting on you." : s.waiting_on_you === 1 ? "One document is waiting on you." : `${s.waiting_on_you} documents are waiting on you.`);
    if (s.out > 0) parts.push(s.out === 1 ? "One is out with others." : `${s.out} are out with others.`);
    return parts.join(" ");
  }, [stats.data]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-8">
      <PageHeader
        title={firstName ? `${greeting()}, ${firstName}` : "Documents"}
        description={lead || " "}
        actions={canSend ? (
          <>
            <Button variant="ghost" asChild className="hidden sm:inline-flex"><Link to="/templates">Use a template</Link></Button>
            <Button asChild><Link to="/documents/new"><FilePlus2 aria-hidden />New document</Link></Button>
          </>
        ) : null}
      />

      <section aria-label="At a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Waiting on you" loading={stats.loading && !stats.data} value={stats.data?.waiting_on_you ?? 0}
          className={stats.data?.waiting_on_you ? "border-[color-mix(in_oklch,var(--sign)_60%,transparent)] bg-sign-soft" : undefined}
          hint={stats.data?.waiting_on_you ? "Open Action required to sign" : "You're all caught up"}
        />
        <StatCard label="Out for signature" loading={stats.loading && !stats.data} value={stats.data?.out ?? 0} hint="Sent and not finished" />
        <StatCard label="Completed" loading={stats.loading && !stats.data} value={stats.data?.completed_this_month ?? 0} hint="This month" />
        <StatCard label="Time to complete" loading={stats.loading && !stats.data} value={duration(stats.data?.median_ms)}
          hint={stats.data?.completed_last_30 ? `Median, last 30 days` : "None in 30 days"} />
      </section>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="-mx-1 overflow-x-auto px-1">
          <Segmented label="Show documents" value={segment} onChange={setSegment} options={SEGMENTS} />
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="Search titles, names and emails" className="md:w-72" />
      </div>

      {list.error ? (
        <LoadError title="Your documents didn't load" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton />
      ) : list.data.items.length === 0 ? (
        q ? (
          <EmptyState icon={FileText} title={`Nothing matches "${q}"`} description="Try a person's name, their email, or part of the title." action={<Button variant="outline" onClick={() => setQ("")}>Clear search</Button>} />
        ) : (
          <EmptyState icon={segment === "action" ? Inbox : FileSignature} title={EMPTY[segment].title} description={EMPTY[segment].description}
            action={canSend && (segment === "all" || segment === "drafts") ? <Button asChild><Link to="/documents/new">New document</Link></Button> : undefined} />
        )
      ) : (
        <DocumentList rows={list.data.items} people={list.data.people} myTurn={list.data.my_turn} />
      )}
    </div>
  );
}

function DocumentList({ rows, people, myTurn }: { rows: EnvelopeRow[]; people: PersonRow[]; myTurn: number[] }) {
  const byEnvelope = useMemo(() => {
    const m = new Map<number, PersonRow[]>();
    for (const p of people) m.set(p.envelope_id, [...(m.get(p.envelope_id) ?? []), p]);
    return m;
  }, [people]);
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-card" aria-label="Documents">
      {rows.map((e) => <DocumentRow key={e.id} e={e} people={byEnvelope.get(e.id) ?? []} mine={myTurn.includes(e.id)} />)}
    </ul>
  );
}

function progressOf(e: EnvelopeRow, people: PersonRow[]) {
  const acting = people.filter((p) => p.role !== "cc");
  const done = acting.filter((p) => p.status === "completed").length;
  return { done, total: acting.length };
}

function rowNote(e: EnvelopeRow, people: PersonRow[], mine: boolean, meId?: number) {
  if (mine) return e.sender_id === meId ? "Ready for your signature" : `${e.sender_name ?? "Someone"} needs you to sign`;
  if (e.seal_failed) return "The signed copy couldn't be made. Open it to retry.";
  const bounced = people.find((p) => p.bounced && p.status !== "completed");
  if (bounced && e.status === "in_progress") return `Email bounced for ${bounced.email}. Correct the address.`;
  if (e.status === "draft") return "Draft. Finish preparing it, then send.";
  if (e.status === "sealing") return "Everyone has signed. Making the signed copy.";
  if (e.status === "in_progress") {
    const next = people.filter((p) => p.role !== "cc" && (p.status === "sent" || p.status === "opened"));
    if (next.length === 1) return `Waiting on ${next[0].name}${next[0].status === "opened" ? " (opened)" : ""}`;
    if (next.length > 1) return `Waiting on ${next.length} people`;
  }
  if (e.status === "completed") return `Sealed${e.completed_at ? ` ${relative(e.completed_at)}` : ""}`;
  return `Sent by ${e.sender_name ?? "someone"}`;
}

function DocumentRow({ e, people, mine }: { e: EnvelopeRow; people: PersonRow[]; mine: boolean }) {
  const meId = useMe().id;
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const { done, total } = progressOf(e, people);
  const href = e.status === "draft" ? `/documents/${e.id}/prepare` : `/documents/${e.id}`;
  const when = e.updated_at ?? e.created_at;
  const bounced = people.some((p) => p.bounced && p.status !== "completed") && e.status === "in_progress";
  const signNow = async () => {
    setOpening(true);
    try { const { url } = await envelopesApi.signAsMe(e.id); navigate(new URL(url).pathname); }
    catch (err) { toast.error(err instanceof Error ? err.message : "That didn't open. Try again."); setOpening(false); }
  };
  return (
    <li className="group relative grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-muted/50 sm:grid-cols-[auto_1fr_11rem_9rem_5rem]">
      <span aria-hidden className="relative h-9 w-7 shrink-0 rounded-[3px] border bg-paper">
        <span className="absolute inset-x-1.5 top-2 h-3.5 bg-[repeating-linear-gradient(var(--border)_0_1px,transparent_1px_4px)]" />
      </span>
      <div className="min-w-0">
        <Link to={href} className="focus-ring block line-clamp-2 rounded-sm font-medium after:absolute after:inset-0 sm:line-clamp-1">
          {e.title}
        </Link>
        <p className="truncate text-caption text-muted-foreground">{rowNote(e, people, mine, meId)}</p>
      </div>
      <div className="hidden items-center gap-2 sm:flex">
        <AvatarStack names={people.map((p) => p.name || p.email)} max={3} size="md" className="-space-x-1" />
        {e.status === "in_progress" && total > 0 ? (
          <div className="min-w-0 text-caption text-muted-foreground">
            {done} of {total} done
            <div className="mt-1 h-1 w-16 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full bg-primary" style={{ width: `${(done / total) * 100}%` }} /></div>
          </div>
        ) : null}
      </div>
      <div className="relative z-10 justify-self-end sm:justify-self-start">
        {mine ? (
          <Button size="sm" onClick={signNow} disabled={opening} className="bg-sign text-sign-ink hover:bg-[color-mix(in_oklch,var(--sign)_88%,black)]">
            {opening ? <Loader2 aria-hidden className="animate-spin" /> : null}Your turn: sign
          </Button>
        ) : e.seal_failed ? (
          <StatusBadge tone="danger" dot>Signed copy failed</StatusBadge>
        ) : bounced ? (
          <StatusBadge tone="warning" dot>Email bounced</StatusBadge>
        ) : e.status === "completed" ? (
          <span className="flex items-center gap-1">
            <StatusBadge tone={STATUS_TONE[e.status]} dot>{STATUS_LABEL[e.status]}</StatusBadge>
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" asChild>
              <Link to={`/documents/${e.id}/view`} aria-label={`View the signed copy of ${e.title}`} title="View the signed copy"><Eye aria-hidden /></Link>
            </Button>
          </span>
        ) : (
          <StatusBadge tone={STATUS_TONE[e.status]} dot>{STATUS_LABEL[e.status]}</StatusBadge>
        )}
      </div>
      <time className="hidden text-right text-caption text-muted-foreground sm:block" dateTime={new Date(when).toISOString()}>{relative(when)}</time>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y overflow-hidden rounded-lg border bg-card" aria-busy="true" aria-label="Loading documents">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-9 w-7 animate-pulse rounded-[3px] bg-muted" />
          <div className="flex-1 space-y-2"><div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" /><div className="h-3 w-1/3 animate-pulse rounded bg-muted" /></div>
          <div className="h-5 w-24 animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}
