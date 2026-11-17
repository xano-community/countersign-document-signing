import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { addDays, dayKey, isToday, isWeekend, startOfMonth, startOfWeek, useWeekStart, type WeekStart } from "./dates";
import { LoadError } from "./states";
import { TONE_DOT, TONE_EDGE, type ItemStatus, type Tone } from "./status-badge";

type Key = string | number;
/** One entry of the calendar's colour key: a status's words and its tone. */
export type CalendarLegendItem = ItemStatus;
const longDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });

/**
 * A month of things on days: bookings, deadlines, posts (a signature view, CRAFT.md §17). Up to `perDay`
 * items show in a day; the rest open in a popover. Drag an item to another day when `onMove` is given.
 * Each chip carries its status as a coloured left edge plus the status's words for a screen reader
 * (`statusOf`), and its full text and status on hover. A key of the colours sits beside the month (`legend`, or
 * the statuses this month's items have). Weeks with nothing in them are shorter. On a phone it reads as an
 * agenda of the month's days that have something on them.
 */
export function MonthCalendar<T>({ label, items, error, onRetry, dayOf, itemKey, renderItem, statusOf, toneOf, titleOf, legend, onOpen, onMove, month, onMonthChange, perDay = 3, weekStartsOn: weekStartProp }: {
  label: string;
  items: T[] | null | undefined;
  error?: unknown;
  onRetry?: () => void;
  dayOf: (item: T) => string | null;
  itemKey: (item: T) => Key;
  /** "chip" in a day cell (one line: keep it to the title), "agenda" on a phone (room for a status and an owner). */
  renderItem: (item: T, where: "chip" | "agenda") => ReactNode;
  /** The item's status, its words and tone: the chip gets that colour's left edge, and the words for a screen reader. */
  statusOf?: (item: T) => ItemStatus;
  /** The tone only (no words): prefer `statusOf`. */
  toneOf?: (item: T) => Tone;
  /** The full text shown on hover over a (truncated) chip. Default: the chip's text (when renderItem gives a string) · the status. */
  titleOf?: (item: T) => string;
  /** The colours' key beside the month: every status, in order (`STAGES`). Default: the statuses of the items shown; `false` hides it. */
  legend?: CalendarLegendItem[] | false;
  onOpen?: (item: T) => void;
  onMove?: (item: T, day: string) => void;
  month?: Date;
  onMonthChange?: (m: Date) => void;
  perDay?: number;
  /** The first column of each week. */
  weekStartsOn?: WeekStart;
}) {
  const workspaceStart = useWeekStart();
  const weekStartsOn = weekStartProp ?? workspaceStart;
  const [own, setOwn] = useState(() => startOfMonth(new Date()));
  const m = month ?? own;
  const setM = onMonthChange ?? setOwn;
  const [drag, setDrag] = useState<Key | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // Only the weeks the month touches (4 to 6), so no rows of empty next-month days.
  const grid = useMemo(() => {
    const s = startOfWeek(startOfMonth(m), weekStartsOn);
    const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    const weeks = Math.ceil((Math.round((last.getTime() - s.getTime()) / 86_400_000) + 1) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(s, i));
  }, [m, weekStartsOn]);
  if (error) return <LoadError error={error} onRetry={onRetry} />;
  const all = items ?? [];
  const on = (k: string) => all.filter((i) => dayOf(i) === k);
  const byKey = new Map(all.map((i) => [String(itemKey(i)), i]));
  const dragged = drag !== null ? byKey.get(String(drag)) : undefined;
  const status = (i: T): ItemStatus | null => statusOf?.(i) ?? (toneOf ? { label: "", tone: toneOf(i) } : null);
  const chip = (i: T) => {
    const st = status(i);
    const content = renderItem(i, "chip");
    // A chip is one line and often cut: its whole text, and its status, are always on hover.
    const tip = titleOf?.(i) ?? ([typeof content === "string" || typeof content === "number" ? String(content) : "", st?.label].filter(Boolean).join(" · ") || undefined);
    return (
      <button key={itemKey(i)} type="button" draggable={!!onMove} data-calendar-item={itemKey(i)} title={tip}
        onDragStart={(e) => { setDrag(itemKey(i)); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(itemKey(i))); }}
        onDragEnd={() => { setDrag(null); setOver(null); }}
        onClick={() => onOpen?.(i)}
        className={cn("flex w-full min-w-0 items-center rounded-sm bg-muted/60 px-1.5 py-0.5 text-left text-caption text-foreground transition-colors hover:bg-muted focus-ring-inset",
          st && cn("border-l-[3px]", TONE_EDGE[st.tone]), onMove && "cursor-grab active:cursor-grabbing", drag === itemKey(i) && "opacity-50")}>
        <span className="min-w-0 truncate">{content}</span>
        {st?.label && <span className="sr-only">, {st.label}</span>}
      </button>
    );
  };
  const title = m.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const key = legend === false ? [] : legend ?? (statusOf && items
    ? [...new Map(all.filter((i) => dayOf(i) && grid.some((d) => dayKey(d) === dayOf(i))).map((i) => statusOf(i)).map((st) => [st.label, st])).values()]
    : []);
  // A week with nothing on it (and not this week) is shorter, so the month's busy weeks get the room.
  const busy = Array.from({ length: grid.length / 7 }, (_, w) => !items || grid.slice(w * 7, w * 7 + 7).some((d) => isToday(d) || on(dayKey(d)).length > 0));

  return (
    <div data-kit="calendar" data-signature-view="calendar" role="group" aria-label={label} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => setM(new Date(m.getFullYear(), m.getMonth() - 1, 1))}><ChevronLeft /></Button>
        <Button variant="outline" size="icon" aria-label="Next month" onClick={() => setM(new Date(m.getFullYear(), m.getMonth() + 1, 1))}><ChevronRight /></Button>
        <Button variant="ghost" size="sm" onClick={() => setM(startOfMonth(new Date()))}>Today</Button>
        <h2 className="text-heading">{title}</h2>
        {key.length > 0 && (
          <ul aria-label="Colour key" className="ml-auto hidden flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground md:flex">
            {key.map((k) => (
              <li key={k.label} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2 rounded-full", TONE_DOT[k.tone])} />{k.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* overflow-clip (not hidden/auto), so the weekday row sticks to the page as it scrolls. */}
      <div className="hidden overflow-clip rounded-lg border md:block">
        <div className="sticky top-0 z-10 grid grid-cols-7 border-b bg-[color-mix(in_oklch,var(--muted)_60%,var(--card))] text-caption text-muted-foreground">
          {grid.slice(0, 7).map((d) => <div key={d.getDay()} className="px-2 py-1.5">{d.toLocaleDateString(undefined, { weekday: "short" })}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((d, di) => {
            const k = dayKey(d);
            const list = items ? on(k) : [];
            const outside = d.getMonth() !== m.getMonth();
            const today = isToday(d);
            const accepts = !!onMove && dragged !== undefined && dayOf(dragged) !== k;
            return (
              <div key={k} data-calendar-day={k} data-today={today || undefined}
                onDragOver={(e) => { if (accepts) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(k); } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
                onDrop={(e) => { e.preventDefault(); setDrag(null); setOver(null); if (dragged && onMove && accepts) onMove(dragged, k); }}
                className={cn("flex min-w-0 flex-col", busy[Math.floor(di / 7)] ? "min-h-24" : "min-h-12", "gap-0.5 border-b p-1 transition-colors [&:not(:nth-child(7n))]:border-r",
                  outside ? "bg-muted/60" : isWeekend(d) && "bg-muted/20", over === k && accepts && "bg-selected ring-1 ring-primary-text ring-inset")}>
                <span aria-label={today ? `Today, ${longDay(d)}` : undefined}
                  className={cn("mb-0.5 grid h-6 min-w-6 place-items-center self-start rounded-md px-1 text-caption tabular-nums",
                    today ? "bg-selected font-medium text-primary-text" : "text-muted-foreground")}>{d.getDate()}</span>
                {!items ? (d.getDate() % 4 === 0 && <Skeleton className="h-5 w-full" />) : (
                  <>
                    {list.slice(0, perDay).map(chip)}
                    {list.length > perDay && (
                      <Popover>
                        <PopoverTrigger className="self-start rounded-sm px-1.5 text-left text-caption text-muted-foreground transition-colors hover:text-foreground focus-ring-inset">+{list.length - perDay} more</PopoverTrigger>
                        <PopoverContent className="flex w-60 flex-col gap-0.5 p-2">
                          <div className="px-1 pb-1 text-caption font-medium">{longDay(d)}</div>
                          {list.map(chip)}
                        </PopoverContent>
                      </Popover>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-3 md:hidden">
        {!items ? <Skeleton className="h-24 w-full" /> : (() => {
          const days = grid.filter((d) => d.getMonth() === m.getMonth() && on(dayKey(d)).length);
          if (!days.length) return <p className="text-body text-muted-foreground">Nothing in {title}.</p>;
          return days.map((d) => (
            <section key={dayKey(d)} aria-label={d.toDateString()}>
              <h3 className="pb-1 text-caption font-medium">
                <span className={cn(isToday(d) ? "rounded-md bg-selected px-1.5 py-0.5 text-primary-text" : "text-muted-foreground")}>{isToday(d) ? `Today, ${longDay(d)}` : longDay(d)}</span>
              </h3>
              <ul className="divide-y rounded-lg border bg-card">
                {/* The agenda row has room to show its status in words: renderItem's "agenda" does. */}
                {on(dayKey(d)).map((i) => (
                  <li key={itemKey(i)}>
                    <button type="button" onClick={() => onOpen?.(i)}
                      className="flex w-full min-w-0 flex-col gap-1 p-3 text-left text-body transition-colors hover:bg-muted/50 active:bg-muted focus-ring-inset">
                      {renderItem(i, "agenda")}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ));
        })()}
      </div>
    </div>
  );
}
