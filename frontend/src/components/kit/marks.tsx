import { SignalHigh, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { dayKey, toDate } from "./dates";
import { fullDate, shortDate } from "./time";

/**
 * Priority's own mark (CRAFT.md §9: other scales get their own mark, not a status pill). Only what's above
 * normal shows: "high" is bars in the muted foreground, "urgent" a warning triangle in destructive; anything
 * else renders nothing, so a mark always means "look at this". It takes the size of the text around it.
 *
 *   <PriorityMark level={deal.priority} />            // "urgent" | "high" | anything else
 *   <PriorityMark level="urgent" label="P1" />
 */
export function PriorityMark({ level, label, className }: { level: string | null | undefined; label?: string; className?: string }) {
  const l = level?.toLowerCase();
  if (l !== "urgent" && l !== "high") return null;
  const Icon = l === "urgent" ? TriangleAlert : SignalHigh;
  return (
    <span data-slot="priority-mark" data-priority={l}
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap", l === "urgent" ? "font-medium text-destructive" : "text-muted-foreground", className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} />
      {label ?? (l === "urgent" ? "Urgent" : "High")}
    </span>
  );
}

/**
 * A due date: "Tue 6 Oct", "Today", or, when it has passed and the thing isn't done, "Overdue · Mon 5 Oct" in
 * warning (CRAFT.md §17). A bare "2026-10-06" is that local day. The full date is on hover; empty → nothing.
 */
export function DueLabel({ value, done = false, className }: { value: string | number | Date | null | undefined; done?: boolean; className?: string }) {
  if (value === null || value === undefined || value === "") return null;
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return null;
  const day = dayKey(d), today = dayKey(new Date());
  const late = !done && day < today;
  return (
    <time dateTime={day} title={`Due ${fullDate(d)}`} data-slot="due-label" data-overdue={late || undefined}
      // The state's colour wins over a muted className from the row it sits in.
      className={cn("whitespace-nowrap tabular-nums", className, late && "font-medium text-warning", day === today && !done && "font-medium text-foreground")}>
      {!late && <span className="sr-only">Due </span>}
      {late ? `Overdue · ${shortDate(d)}` : day === today ? "Today" : shortDate(d)}
    </time>
  );
}
