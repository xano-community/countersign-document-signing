import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { addDays, dayKey, fromDayKey, isToday, startOfMonth, startOfWeek, useWeekStart } from "./dates";
import { DateLabel } from "./time";

/**
 * Click (or Enter) to edit a text value in place; Enter or blur saves, Escape cancels. `onSave` gets the
 * trimmed text; reject it (throw) to keep the editor open with the message under it.
 */
export function InlineText({ value, onSave, label, multiline = false, required = false, placeholder = "Add…", className }: {
  value: string; onSave: (next: string) => Promise<unknown>; label: string; multiline?: boolean;
  /** Refuse an empty value with a message, before anything is sent. */
  required?: boolean; placeholder?: string; className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // After Enter or Escape, focus goes back to the value; after a blur it stays where the person went.
  const back = useRef(false);
  const noteId = useId();
  useEffect(() => { if (!editing) setText(value); }, [value, editing]);
  useEffect(() => {
    if (editing) { ref.current?.focus(); ref.current?.select(); }
    else if (back.current) { back.current = false; trigger.current?.focus(); }
  }, [editing]);

  async function save(refocus = false) {
    const next = text.trim();
    if (next === value.trim()) { back.current = refocus; setEditing(false); setError(null); return; }
    if (required && !next) { setError(`${label} can't be empty.`); return; }
    setBusy(true);
    try { await onSave(next); back.current = refocus; setEditing(false); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't save."); }
    finally { setBusy(false); }
  }

  if (!editing) {
    return (
      <button ref={trigger} type="button" data-kit="inline-edit" aria-label={`Edit ${label}`} onClick={() => setEditing(true)}
        className={cn("group -mx-1 flex min-w-0 items-start gap-1.5 rounded px-1 text-left transition-colors hover:bg-muted/50 focus-ring", className)}>
        <span className={cn("min-w-0 whitespace-pre-wrap wrap-anywhere", !value && "text-muted-foreground")}>{value || placeholder}</span>
        <Pencil aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    );
  }
  const common = {
    ref, value: text, disabled: busy, "aria-label": label, "aria-invalid": !!error || undefined, "aria-describedby": noteId,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: () => void save(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); back.current = true; setText(value); setEditing(false); setError(null); }
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(true); }
    },
  };
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {multiline ? <Textarea {...common} rows={4} /> : <Input {...common} className="h-8" />}
      <span id={noteId} className={cn("text-caption", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? (multiline ? "⌘ Enter to save · Esc to cancel" : "Enter to save · Esc to cancel")}
      </span>
    </div>
  );
}

/**
 * Pick a value from a short list in place (status, priority, owner). Saves on pick, with no success toast
 * (the new value is right there); if that fails, the old value comes back and the reason is toasted.
 */
export function InlineSelect<V extends string>({ value, options, onSave, label, render, disabled }: {
  value: V; options: { value: V; label: string }[]; onSave: (next: V) => Promise<unknown> | void; label: string;
  /** How the current value shows (a StatusBadge, say). Default: its label. */
  render?: (v: V) => ReactNode; disabled?: boolean;
}) {
  // The pick shows at once; it gives way to `value` when that changes, or to the old value on failure.
  const [picked, setPicked] = useState<V | null>(null);
  useEffect(() => setPicked(null), [value]);
  const shown = picked ?? value;
  const current = options.find((o) => o.value === shown);
  async function pick(v: V) {
    setPicked(v);
    // Once the save settles, `value` is the truth again: the new value, or the old one if the caller rolled back.
    try { await onSave(v); setPicked(null); }
    catch (e) { setPicked(null); toast.error(e instanceof Error ? e.message : "That didn't save."); }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} aria-label={`${label}: ${current?.label ?? shown}. Change`} data-kit="inline-select"
        className="-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:bg-muted/50 focus-ring disabled:pointer-events-none">
        {render ? render(shown) : current?.label ?? shown}
        {!disabled && <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={shown} onValueChange={(v) => { if (v !== shown) void pick(v as V); }}>
          {options.map((o) => <DropdownMenuRadioItem key={o.value} value={o.value}>{o.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


/** A day key ("2026-10-06") from whatever the API sent: a date, an ISO timestamp, or nothing. */
const toKey = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null);

/**
 * Pick a date in place: shows "Tue 6 Oct", opens a month to pick from, saves on pick (never per keystroke),
 * and has Clear. `onSave` gets "YYYY-MM-DD", or null when cleared. Read-only (`disabled`) shows the date.
 * If the save fails the old date comes back and the reason is toasted.
 */
export function InlineDate({ value, onSave, label, disabled, placeholder = "No date" }: {
  value: string | null | undefined; onSave: (next: string | null) => Promise<unknown> | void; label: string;
  disabled?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  // The pick shows at once (undefined: nothing picked); it gives way to `value` when that changes.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const key = toKey(value);
  useEffect(() => setPicked(undefined), [key]);
  const shown = picked === undefined ? key : picked;
  const text = shown ? <DateLabel value={fromDayKey(shown)} /> : <span className="text-muted-foreground">{placeholder}</span>;
  if (disabled) return <span data-kit="inline-date">{text}</span>;

  async function pick(next: string | null) {
    setOpen(false);
    if (next === shown) return;
    setPicked(next);
    try { await onSave(next); setPicked(undefined); }
    catch (e) { setPicked(undefined); toast.error(e instanceof Error ? e.message : "That didn't save."); }
  }
  const spoken = shown ? fromDayKey(shown).toLocaleDateString(undefined, { dateStyle: "full" }) : "none";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger data-kit="inline-date" aria-label={`${label}: ${spoken}. Change`}
        className="-mx-1 inline-flex items-center gap-1.5 rounded px-1 transition-colors hover:bg-muted/50 focus-ring">
        {text}
        <CalendarDays aria-hidden className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
        <MonthGrid selected={shown} onPick={(k) => void pick(k)} label={label} />
        <div className="mt-2 flex justify-between gap-2 border-t pt-2">
          <Button variant="ghost" size="sm" onClick={() => void pick(dayKey(new Date()))}>Today</Button>
          {shown && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void pick(null)}>Clear</Button>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A compact month to pick a day from: arrows move a day / a week, PageUp / PageDown a month, Enter picks. */
function MonthGrid({ selected, onPick, label }: { selected: string | null; onPick: (key: string) => void; label: string }) {
  const weekStart = useWeekStart();
  const [focus, setFocus] = useState(() => selected ?? dayKey(new Date()));
  const month = startOfMonth(fromDayKey(focus));
  const grid = useMemo(() => {
    const s = startOfWeek(month, weekStart);
    return Array.from({ length: 42 }, (_, i) => addDays(s, i)); // six weeks always, so the popover never jumps
  }, [month.getTime(), weekStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const root = useRef<HTMLDivElement>(null);
  // Focus follows the focused day: on open, and after every arrow key or month step.
  useEffect(() => { root.current?.querySelector<HTMLElement>(`[data-day="${focus}"]`)?.focus(); }, [focus]);

  const move = (days: number) => setFocus((f) => dayKey(addDays(fromDayKey(f), days)));
  const moveMonth = (n: number) => setFocus((f) => {
    const d = fromDayKey(f);
    const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
    return dayKey(new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)));
  });
  const onKey = (e: KeyboardEvent) => {
    const steps: Record<string, () => void> = {
      ArrowLeft: () => move(-1), ArrowRight: () => move(1), ArrowUp: () => move(-7), ArrowDown: () => move(7),
      PageUp: () => moveMonth(-1), PageDown: () => moveMonth(1),
    };
    const step = steps[e.key];
    if (step) { e.preventDefault(); step(); }
  };
  const title = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return (
    <div ref={root} role="group" aria-label={`${label}: pick a day`} data-kit="month-grid" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 pl-2">
        <span className="text-body font-medium" aria-live="polite">{title}</span>
        <div className="flex">
          <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight /></Button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-caption text-muted-foreground" aria-hidden>
        {grid.slice(0, 7).map((d) => <span key={d.getDay()} className="py-1">{d.toLocaleDateString(undefined, { weekday: "narrow" })}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-px" onKeyDown={onKey}>
        {grid.map((d) => {
          const k = dayKey(d);
          const on = k === selected;
          const outside = d.getMonth() !== month.getMonth();
          return (
            <button key={k} type="button" data-day={k} tabIndex={k === focus ? 0 : -1} aria-pressed={on}
              aria-label={d.toLocaleDateString(undefined, { dateStyle: "full" })} aria-current={isToday(d) ? "date" : undefined}
              onClick={() => onPick(k)} onFocus={() => setFocus(k)}
              className={cn("grid size-8 place-items-center rounded-md text-body tabular-nums transition-colors focus-ring-inset",
                on ? "bg-primary font-medium text-primary-foreground"
                  : cn("hover:bg-muted/50 active:bg-muted", isToday(d) ? "font-medium text-primary-text" : outside ? "text-muted-foreground/60" : "text-foreground"))}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
