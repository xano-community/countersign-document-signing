// Activity (BASELINE.md): what people and their agents did, from the rows app/changed writes. The overview's feed,
// /activity, and a record's timeline (`<RecordTimeline entity="job" id={12} />`). All three update live.
import { Bot, History } from "lucide-react";
import { Ago, Avatar, EmptyState, PageHeader, Pager, Panel, PanelList, PanelRow, useLoad, useUrlState } from "@/components/kit";
import { baseApi, type Activity } from "./api";
import { useLive } from "./live";
import { useWorkspace } from "./workspace";

function Item({ a }: { a: Activity }) {
  const { nameOf } = useWorkspace();
  const who = a.actor_name || nameOf(a.actor_id);
  const body = (
    <>
      {a.via
        ? <span aria-hidden className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-muted text-foreground/80"><Bot className="size-3.5" /></span>
        : <Avatar name={who} size="sm" className="mt-0.5" />}
      <span className="min-w-0 flex-1">
        <span className="block text-body" title={`${who} ${a.title}`}><span className="font-medium">{who}</span>{a.via && <span className="text-muted-foreground"> via {a.via}</span>} {a.title}</span>
        <Ago value={a.created_at} className="text-caption text-muted-foreground" />
      </span>
    </>
  );
  return <PanelRow href={a.link || undefined} className="items-start" data-kit="activity-item">{body}</PanelRow>;
}

function useActivity(q: { entity?: string; entity_id?: number; page?: number; per_page?: number }, liveOn: string[]) {
  const list = useLoad(() => baseApi.activity(q), [q.entity, q.entity_id, q.page, q.per_page]);
  useLive(liveOn, list.reload);
  return list;
}

function Rows({ list, empty }: { list: ReturnType<typeof useActivity>; empty: string }) {
  return (
    <PanelList loading={!list.data && !list.error} error={list.error} onRetry={list.reload} empty={empty}>
      {list.data?.items.map((a) => <Item key={a.id} a={a} />)}
    </PanelList>
  );
}

/**
 * The overview's "what happened" card: people's and agents' latest actions. `entities` are what it listens to
 * live (the domain's tables); it always listens to the base's own.
 */
export function ActivityFeed({ limit = 6, entities = [], title = "Recent activity" }: { limit?: number; entities?: string[]; title?: string }) {
  const list = useActivity({ per_page: limit }, ["user", "settings", "invite", ...entities, "*"]);
  return (
    <Panel title={title} action={{ href: "/activity", label: "All activity" }} data-kit="activity-feed">
      <Rows list={list} empty="Nothing yet. What people and their agents do shows up here, as it happens." />
    </Panel>
  );
}

/** A record's history, on its detail page or sheet: `<RecordTimeline entity="job" id={job.id} />`. */
export function RecordTimeline({ entity, id, title = "History" }: { entity: string; id: number; title?: string }) {
  const list = useActivity({ entity, entity_id: id, per_page: 20 }, [entity]);
  return (
    <section aria-label={title} data-kit="record-timeline">
      <h3 className="mb-1 text-caption font-medium text-muted-foreground">{title}</h3>
      <div className="-mx-4"><Rows list={list} empty="No changes recorded yet." /></div>
    </section>
  );
}

/** /activity: everything people and their agents did, newest first, paged. */
export function ActivityPage() {
  const [q, setQ] = useUrlState({ page: "1" });
  const list = useActivity({ page: Number(q.page) || 1, per_page: 30 }, ["*"]);
  return (
    <div className="flex flex-col gap-4" data-testid="activity-page">
      <PageHeader title="Activity" description="What people and their agents did, newest first. It updates as it happens." />
      {list.data && list.data.items.length === 0 ? (
        <EmptyState icon={History} title="No activity yet" description="Changes to records, invites and settings show up here as they happen." />
      ) : (
        <div className="rounded-lg border bg-card">
          <Rows list={list} empty="" />
          {list.data && list.data.pageTotal > 1 && <div className="border-t px-4 py-2"><Pager page={list.data.curPage} pageTotal={list.data.pageTotal} onPage={(p) => setQ({ page: String(p) })} /></div>}
        </div>
      )}
    </div>
  );
}
