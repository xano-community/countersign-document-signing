import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Avatar, AvatarStack } from "./avatar";
import { DueLabel, PriorityMark } from "./marks";
import { LoadError } from "./states";
import { StatusBadge, type Tone } from "./status-badge";

export interface KanbanColumn { id: string; title: string; tone?: Tone; hint?: string; /** Warn when a column holds more than this. */ limit?: number }

type Key = string | number;

// The column's colour: a step off the page in light, a shade under the cards in dark (opaque, so the list's fade
// reads as cards going under it).
const COLUMN_BG = "[--kanban-col:color-mix(in_oklch,var(--muted)_60%,var(--background))] dark:[--kanban-col:color-mix(in_oklch,var(--muted)_25%,var(--background))]";
const cards = (n: number) => `${n} ${n === 1 ? "card" : "cards"}`;

/**
 * A board of cards in columns: a pipeline's stages, a ticket's states (a signature view, CRAFT.md §17).
 * Move a card by dragging it (mouse), with its Move menu (touch, keyboard), or with Shift + ← / → when
 * it has focus. `onMove` should be optimistic (`optimistic()`): the board shows the move at once.
 * Lay a card out with `<KanbanCard>` (`renderCard` is the escape hatch for anything else). `onAdd` puts a +
 * in each column's header; `overdueOf` adds "2 overdue" (in warning) beside a column's count. On a wide screen each column
 * scrolls on its own under its header (the board itself only sideways), its list fading out where more is below;
 * on a phone the columns scroll sideways, one screen-width each, and the chip strip marks the one in view.
 */
export function KanbanBoard<T>({ label, columns, items, error, onRetry, columnOf, itemKey, renderCard, onMove, onOpen, onAdd, overdueOf, canMove = () => true, emptyColumn = "Nothing here" }: {
  label: string;
  columns: KanbanColumn[];
  items: T[] | null | undefined;
  error?: unknown;
  onRetry?: () => void;
  columnOf: (item: T) => string;
  itemKey: (item: T) => Key;
  renderCard: (item: T) => ReactNode;
  onMove: (item: T, to: string) => void;
  onOpen?: (item: T) => void;
  /** A "+" in each column's header: add a card there. */
  onAdd?: (columnId: string) => void;
  /** Whether a card is overdue: its column's header says how many, in warning ("2 overdue"). */
  overdueOf?: (item: T) => boolean;
  canMove?: (item: T, to: string) => boolean;
  emptyColumn?: string;
}) {
  const [drag, setDrag] = useState<Key | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [edges, setEdges] = useState({ left: false, right: false });
  // The column in view on a phone (its jump chip shows selected).
  const [inView, setInView] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const jumps = useRef<HTMLElement>(null);
  const hint = useId();
  // A keyboard move remounts the card in its new column, which drops focus: give it back to the card
  // (only when focus fell to the page, so it never steals it from somewhere else).
  const refocus = useRef<{ key: Key; to: string } | null>(null);
  useEffect(() => {
    const r = refocus.current;
    const el = r && root.current?.querySelector<HTMLElement>(`[data-kanban-card="${CSS.escape(String(r.key))}"] > [tabindex]`);
    if (!r || !el) return;
    if (el.closest("[data-kanban-column]")?.getAttribute("data-kanban-column") === r.to) refocus.current = null;
    if (!document.activeElement || document.activeElement === document.body) el.focus();
  });
  // Fade the edge the board continues past, so a column cut off at the side reads as "there's more".
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 1, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
      // The column whose left edge is nearest the strip's own (its padding is where a snapped column starts).
      const start = el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft);
      let best: Element | null = null, dist = Infinity;
      for (const sec of el.querySelectorAll("[data-kanban-column]")) {
        const d = Math.abs(sec.getBoundingClientRect().left - start);
        if (d < dist) { dist = d; best = sec; }
      }
      setInView(best?.getAttribute("data-kanban-column") ?? null);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.lastElementChild) ro.observe(el.lastElementChild);
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  }, [columns.length, items]);
  // Keep the in-view column's chip in view in its own strip (sideways only: never scrolls the page).
  useEffect(() => {
    const nav = jumps.current, chip = inView && nav?.querySelector<HTMLElement>(`[data-kanban-jump="${CSS.escape(inView)}"]`);
    if (!nav || !chip || nav.scrollWidth <= nav.clientWidth) return;
    const left = chip.offsetLeft - nav.offsetLeft, right = left + chip.offsetWidth;
    if (left < nav.scrollLeft + 16) nav.scrollTo({ left: left - 16, behavior: "smooth" });
    else if (right > nav.scrollLeft + nav.clientWidth - 16) nav.scrollTo({ left: right - nav.clientWidth + 16, behavior: "smooth" });
  }, [inView]);
  // Each column's list fades at the end it continues past (wide screens, where it scrolls on its own).
  useLayoutEffect(() => {
    const lists = [...(root.current?.querySelectorAll<HTMLElement>("[data-kanban-list]") ?? [])];
    const measure = (ul: HTMLElement) => {
      const up = ul.scrollTop > 1, down = ul.scrollTop + ul.clientHeight < ul.scrollHeight - 1;
      const fade = up && down ? "both" : up ? "top" : down ? "bottom" : "";
      if ((ul.dataset.fade ?? "") !== fade) { if (fade) ul.dataset.fade = fade; else delete ul.dataset.fade; }
    };
    const offs = lists.map((ul) => { const f = () => measure(ul); f(); ul.addEventListener("scroll", f, { passive: true }); return () => ul.removeEventListener("scroll", f); });
    const ro = new ResizeObserver(() => lists.forEach(measure));
    lists.forEach((ul) => ro.observe(ul));
    return () => { offs.forEach((off) => off()); ro.disconnect(); };
  }, [columns.length, items]);
  if (error) return <LoadError error={error} onRetry={onRetry} />;
  const byKey = new Map((items ?? []).map((i) => [String(itemKey(i)), i]));
  const dragged = drag !== null ? byKey.get(String(drag)) : undefined;
  const move = (item: T, to: string) => {
    if (columnOf(item) === to || !canMove(item, to)) return;
    onMove(item, to);
    setSaid(`Moved to ${columns.find((c) => c.id === to)?.title ?? to}.`);
  };
  const fade = edges.left || edges.right
    ? `linear-gradient(to right, ${edges.left ? "transparent, black 2rem" : "black"}, ${edges.right ? "black calc(100% - 2rem), transparent" : "black"})`
    : undefined;

  return (
    <div ref={root} className={cn("flex flex-col gap-2", COLUMN_BG)}>
    {/* Phone: the columns as a strip of chips; tapping one scrolls the board to it. */}
    <nav ref={jumps} aria-label="Jump to a column" className="kit-scroll-x -mx-4 flex gap-2 px-4 md:hidden">
      {columns.map((col) => {
        const current = inView === col.id;
        return (
          <button key={col.id} type="button" data-kanban-jump={col.id} aria-current={current || undefined}
            onClick={() => root.current?.querySelector(`[data-kanban-column="${CSS.escape(col.id)}"]`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" })}
            className={cn("shrink-0 rounded-full border px-3 py-1 text-caption whitespace-nowrap transition-colors focus-ring-inset",
              current ? "border-primary-text/40 bg-selected font-medium text-primary-text" : "bg-card hover:bg-muted/50")}>
            {col.title} <span className={cn("tabular-nums", !current && "text-muted-foreground")}>{items ? items.filter((i) => columnOf(i) === col.id).length : ""}</span>
          </button>
        );
      })}
    </nav>
    <p id={hint} hidden>Press Shift and the left or right arrow to move it to the next column{onOpen ? ", or Enter to open it" : ""}.</p>
    <div ref={strip} data-kit="kanban" data-signature-view="kanban" aria-label={label} role="group"
      style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      className={cn("-mx-4 snap-x snap-mandatory overflow-x-auto overscroll-x-contain px-4 pb-2 [scrollbar-width:thin]",
        "pointer-coarse:[scrollbar-width:none] pointer-coarse:[&::-webkit-scrollbar]:hidden",
        // Wide: the board only scrolls sideways; each column scrolls on its own (below).
        "md:mx-0 md:snap-none md:overflow-y-hidden md:px-0")}>
      <p aria-live="polite" className="sr-only">{said}</p>
      {/* The row of columns, as tall as the tallest (up to a screen): every column's colour (and drop target) runs to the end. */}
      <div className="flex w-max min-w-full gap-3 md:w-auto">
      {columns.map((col, ci) => {
        const list = (items ?? []).filter((i) => columnOf(i) === col.id);
        const tooMany = col.limit !== undefined && list.length > col.limit;
        // A drop target only for a card that can go there: never the column it came from.
        const accepts = dragged !== undefined && columnOf(dragged) !== col.id && canMove(dragged, col.id);
        const lit = over === col.id && accepts;
        const late = items && overdueOf ? list.filter(overdueOf).length : 0;
        return (
          <section key={col.id} aria-label={col.title} data-kanban-column={col.id}
            onDragOver={(e) => { if (accepts) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(col.id); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
            onDrop={(e) => { e.preventDefault(); setOver(null); setDrag(null); if (dragged && accepts) move(dragged, col.id); }}
            // Wide: a card of its own, at most a screen tall: the header stays put and the list scrolls under it.
            className={cn("flex w-[85vw] shrink-0 snap-start flex-col gap-2 rounded-lg border bg-(--kanban-col) pb-1 transition-colors sm:w-72 md:max-h-[calc(100dvh-12rem)] md:w-auto md:min-w-56 md:flex-1",
              lit && "border-primary-text bg-selected")}>
            <header className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <StatusBadge tone={col.tone ?? "neutral"} dot className="min-w-0"><span className="truncate" title={col.title}>{col.title}</span></StatusBadge>
                <span data-kanban-count title={col.limit !== undefined ? `${list.length} of a limit of ${col.limit}${tooMany ? ": over the limit" : ""}` : undefined}
                  className={cn("shrink-0 rounded-full px-1.5 text-micro whitespace-nowrap tabular-nums", tooMany ? "bg-warning/15 font-medium text-warning" : "bg-muted text-muted-foreground")}>
                  <span aria-hidden>{items ? list.length : "–"}{col.limit !== undefined && ` / ${col.limit}`}</span>
                  <span className="sr-only">{items ? cards(list.length) : "Loading"}{col.limit !== undefined && `, limit ${col.limit}`}{tooMany && ", over the limit"}</span>
                </span>
              </div>
              {onAdd && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label={`Add to ${col.title}`} data-kit="kanban-add" onClick={() => onAdd(col.id)}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring">
                      <Plus className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Add to {col.title}</TooltipContent>
                </Tooltip>
              )}
            </header>
            {/* The hint and the overdue count share the line under the header, so every column's header is one line. */}
            {(col.hint || late > 0) && (
              <p className="flex min-w-0 items-baseline gap-1.5 px-3 text-caption text-muted-foreground">
                {col.hint && <span className="min-w-0 truncate" title={col.hint}>{col.hint}</span>}
                {late > 0 && <span data-kanban-overdue className="shrink-0 font-medium whitespace-nowrap text-warning">{col.hint && "· "}{late} overdue</span>}
              </p>
            )}
            <ul data-kanban-list className={cn("flex min-h-16 flex-col gap-2 px-2 pb-1 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-y-contain md:[scrollbar-width:thin]",
              "md:data-[fade=bottom]:[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
              "md:data-[fade=top]:[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]",
              "md:data-[fade=both]:[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem,black_calc(100%-2.5rem),transparent)]")}>
              {!items ? Array.from({ length: 3 }, (_, i) => <li key={`skeleton-${i}`}><Skeleton className="h-20 w-full rounded-lg" /></li>)
                : list.length === 0 ? <li className="rounded-lg border border-dashed p-3 text-center text-caption text-muted-foreground">{emptyColumn}</li>
                : list.map((item) => {
                  const k = itemKey(item);
                  const targets = columns.filter((c) => c.id !== col.id && canMove(item, c.id));
                  const movable = targets.length > 0;
                  return (
                    <li key={k} draggable={movable} data-kanban-card={k}
                      onDragStart={(e) => { setDrag(k); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(k)); }}
                      onDragEnd={() => { setDrag(null); setOver(null); }}
                      className={cn("group relative rounded-lg border bg-card text-body shadow-xs transition-colors hover:border-foreground/15", drag === k && "opacity-50")}>
                      <div role={onOpen ? "button" : undefined} tabIndex={0} aria-describedby={movable ? hint : undefined}
                        onClick={() => onOpen?.(item)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && onOpen) { e.preventDefault(); onOpen(item); }
                          if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
                            e.preventDefault();
                            const step = e.key === "ArrowRight" ? 1 : -1;
                            for (let n = ci + step; n >= 0 && n < columns.length; n += step) {
                              if (canMove(item, columns[n].id)) { refocus.current = { key: k, to: columns[n].id }; move(item, columns[n].id); break; }
                            }
                          }
                        }}
                        className={cn("flex min-w-0 flex-col gap-1 rounded-lg p-3 focus-ring-inset",
                          // The Move button sits top-right: a free-form card keeps clear of it; a KanbanCard clears it on its title only.
                          movable && "pr-9 has-[[data-kit=kanban-card]]:pr-3",
                          movable ? "cursor-grab active:cursor-grabbing" : onOpen && "cursor-pointer")}>
                        {renderCard(item)}
                      </div>
                      {movable && (
                        <DropdownMenu>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <DropdownMenuTrigger aria-label="Move" data-kit="kanban-move"
                                className="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-muted-foreground opacity-100 transition-colors hover:bg-muted hover:text-foreground focus-ring-inset data-[state=open]:opacity-100 md:opacity-50 md:group-hover:opacity-100 md:focus-visible:opacity-100">
                                <MoreHorizontal className="size-4" />
                              </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent>Move</TooltipContent>
                          </Tooltip>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel className="text-caption text-muted-foreground">Move to</DropdownMenuLabel>
                            {targets.map((c) => <DropdownMenuItem key={c.id} onSelect={() => move(item, c.id)}>{c.title}</DropdownMenuItem>)}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </li>
                  );
                })}
            </ul>
          </section>
        );
      })}
      </div>
    </div>
    </div>
  );
}

/**
 * One card's anatomy, the same on every board: the title (two lines at most, the rest on hover), then a meta
 * line (the ID, priority, due date, and `extra` such as an agent-draft marker), with who's on it bottom-right.
 *
 *   renderCard={(d) => <KanbanCard title={d.name} id={`#${d.id}`} priority={d.priority} due={d.close_on} done={d.stage === "won"} assignee={owner?.name} />}
 */
export function KanbanCard({ title, id, priority, due, done, assignee, extra }: {
  title: string;
  /** Shown in mono: "#25", "INV-0042". */
  id?: ReactNode;
  /** "urgent" | "high" get a mark (PriorityMark); anything else shows nothing. */
  priority?: string | null;
  /** A due day ("2026-10-06") or time: "Overdue · Mon 5 Oct" in warning once it's passed and not `done`. */
  due?: string | number | Date | null;
  done?: boolean;
  /** A name, or several (stacked). */
  assignee?: string | string[] | null;
  extra?: ReactNode;
}) {
  const people = Array.isArray(assignee) ? assignee.filter(Boolean) : assignee ? [assignee] : [];
  return (
    <div data-kit="kanban-card" className="flex min-w-0 flex-col gap-1.5">
      <span className="line-clamp-2 pr-6 font-medium wrap-anywhere" title={title}>{title}</span>
      <div className="flex min-h-5 items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
          {id !== undefined && id !== null && <span className="font-mono tabular-nums">{id}</span>}
          <PriorityMark level={priority} />
          <DueLabel value={due} done={done} />
          {extra}
        </div>
        {people.length === 1 ? <Avatar name={people[0]} size="xs" /> : people.length > 1 ? <AvatarStack names={people} size="xs" /> : null}
      </div>
    </div>
  );
}
