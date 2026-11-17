import { Children, useId, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { LoadError } from "./states";

/**
 * A card with a title and, optionally, a link to everything behind it: the overview's "Due soon", "Recent
 * activity", a record's related list. Its body is usually a <PanelList> of <PanelRow>s.
 *
 *   <Panel title="Due soon" action={{ href: "/schedule", label: "Schedule" }}>
 *     <PanelList loading={!rows} empty="Nothing due this week.">{rows?.map((r) => <PanelRow key={r.id} href={…}>…</PanelRow>)}</PanelList>
 *   </Panel>
 */
export function Panel({ title, action, children, className, "data-kit": kit = "panel" }: {
  title: string; action?: { href: string; label: string }; children: ReactNode; className?: string; "data-kit"?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-kit={kit} className={cn("flex min-w-0 flex-col rounded-lg border bg-card", className)}>
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 id={id} className="truncate text-heading" title={title}>{title}</h2>
        {action && (
          <Link to={action.href} aria-describedby={id}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm text-caption text-muted-foreground transition-colors hover:text-foreground focus-ring">
            {action.label}<ArrowRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * A panel's divided list, with its three states (CRAFT.md §6): skeleton rows while `loading`, `error` with
 * Try again, `empty` when there are no children.
 */
export function PanelList({ loading, error, onRetry, empty = "Nothing here yet.", rows = 3, children }: {
  loading?: boolean; error?: unknown; onRetry?: () => void; empty?: ReactNode; rows?: number; children?: ReactNode;
}) {
  if (error) return <LoadError error={error} onRetry={onRetry} className="m-3" />;
  if (loading) return <ul aria-hidden className="divide-y">{Array.from({ length: rows }, (_, i) => <li key={`skeleton-${i}`} className="px-4 py-2"><Skeleton className="h-5 w-full" /></li>)}</ul>;
  if (Children.toArray(children).length === 0) return <p className="p-4 text-body text-muted-foreground">{empty}</p>;
  return <ul className="divide-y">{children}</ul>;
}

/** One row: a link (`href`), a button (`onClick`) or plain. Lay out its children in a line; it's flex, gap-3. */
export function PanelRow({ href, onClick, children, className, "data-kit": kit = "panel-row" }: {
  href?: string; onClick?: () => void; children: ReactNode; className?: string; "data-kit"?: string;
}) {
  const cls = cn("flex min-h-9 w-full min-w-0 items-center gap-3 px-4 py-2 text-left text-body", (href || onClick) && "transition-colors hover:bg-muted/50 active:bg-muted focus-ring-inset", className);
  return (
    <li data-kit={kit}>
      {href ? <Link to={href} className={cls}>{children}</Link>
        : onClick ? <button type="button" onClick={onClick} className={cls}>{children}</button>
        : <div className={cls}>{children}</div>}
    </li>
  );
}
