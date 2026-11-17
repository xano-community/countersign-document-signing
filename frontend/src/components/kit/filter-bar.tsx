import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useHotkey } from "./shortcuts";

/**
 * The row of controls above a list: search and filters, then "Clear filters" while any is on, and the
 * result count on the right.
 *
 *   <Toolbar active={[q.q, q.owner].filter(Boolean).length} onClear={() => setQ({ q: "", owner: "" })} count="126 notes">
 */
export function Toolbar({ children, className, active = 0, onClear, count }: {
  children: ReactNode; className?: string;
  /** How many filters are on: above 0, a "Clear filters" button shows. */
  active?: number;
  onClear?: () => void;
  /** The result count ("126 notes"), right-aligned. */
  count?: ReactNode;
}) {
  return (
    <div data-kit="toolbar" className={cn("flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center", className)}>
      {children}
      {active > 0 && onClear && (
        <Button variant="ghost" size="sm" onClick={onClear} className="self-start text-muted-foreground sm:self-auto">Clear filters</Button>
      )}
      {count !== undefined && count !== null && <span className="text-caption text-muted-foreground tabular-nums sm:ml-auto">{count}</span>}
    </div>
  );
}

export interface TabOption { value: string; label: string; count?: number }

const FADE = "1.5rem";
const fadeMask = (left: boolean, right: boolean) => {
  if (!left && !right) return undefined;
  const g = `linear-gradient(to right, ${left ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${right ? "transparent" : "black"})`;
  return { maskImage: g, WebkitMaskImage: g };
};

/**
 * Status tabs: one line that scrolls sideways on a phone and never wraps, its overflowing edge fading out
 * so a cut-off tab reads as "more this way"; the active tab is a 2 px underline (CRAFT.md §15) and is
 * scrolled into view. Arrow keys move between tabs.
 */
export function StatusTabs({ value, onChange, options, label = "Filter by status", className }: {
  value: string; onChange: (v: string) => void; options: TabOption[]; label?: string; className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((p) => (p.left === left && p.right === right ? p : { left, right }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  }, [options.length]);
  // Keep the active tab in view (sideways only: never scroll the page).
  const activeIndex = options.findIndex((o) => o.value === value);
  useEffect(() => {
    const el = strip.current;
    const tab = refs.current[activeIndex];
    if (!el || !tab) return;
    const pad = 24;
    if (tab.offsetLeft - pad < el.scrollLeft) el.scrollTo({ left: tab.offsetLeft - pad });
    else if (tab.offsetLeft + tab.offsetWidth + pad > el.scrollLeft + el.clientWidth) el.scrollTo({ left: tab.offsetLeft + tab.offsetWidth + pad - el.clientWidth });
  }, [activeIndex]);
  return (
    <div ref={strip} role="tablist" aria-label={label} data-kit="status-tabs" style={fadeMask(edges.left, edges.right)}
      className={cn("kit-scroll-x -mx-1 flex gap-1 border-b px-1", className)}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const n = (i + d + options.length) % options.length;
              onChange(options[n].value);
              refs.current[n]?.focus();
            }}
            // The underline is --primary-text, not --primary: a bright accent's fill is too faint as a 2 px line.
            className={cn("relative -mb-px flex h-9 shrink-0 items-center gap-1.5 rounded-t border-b-2 px-3 text-body whitespace-nowrap transition-colors focus-ring-inset",
              active ? "border-primary-text font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {o.label}
            {o.count !== undefined && <span className="rounded-full bg-muted px-1.5 text-micro font-normal text-muted-foreground tabular-nums">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Search that waits for a pause in typing, with "/" to focus it and Escape to clear it. */
export function SearchInput({ value, onChange, placeholder = "Search", className, delay = 250 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; delay?: number;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onChange(text.trim()), delay);
    return () => clearTimeout(t);
  }, [text, value, onChange, delay]);
  useHotkey("/", () => ref.current?.focus());
  return (
    <div className={cn("relative min-w-0 flex-1 sm:max-w-xs", className)}>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input ref={ref} type="search" value={text} placeholder={placeholder} aria-label={placeholder} data-kit="search"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { setText(""); onChange(""); e.currentTarget.blur(); } }}
        className="h-8 pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden" />
      {text ? (
        <button type="button" aria-label="Clear search" onClick={() => { setText(""); onChange(""); ref.current?.focus(); }}
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground focus-ring">
          <X className="size-3.5" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border px-1.5 font-mono text-micro text-muted-foreground sm:block">/</kbd>
      )}
    </div>
  );
}

const ALL = "__all";
/** Above this many options a filter becomes searchable. */
const SEARCHABLE_FROM = 9;
const ON = "border-primary/40 bg-primary/5 font-medium text-foreground dark:bg-primary/10 dark:hover:bg-primary/15";

/**
 * A filter dropdown. "" means no filter, shown as `allLabel`. While a value is picked it looks on (an accent
 * edge) and has its own ✕. Past 8 options it becomes a searchable list.
 */
export function FilterSelect({ value, onChange, options, allLabel, label, className }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; allLabel: string;
  /** What it filters, for screen readers and the search box: "Assignee". */
  label?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const name = label ?? allLabel;
  const on = !!value;
  const current = options.find((o) => o.value === value);
  const clear = on && (
    <button type="button" aria-label={`Clear ${name.toLowerCase()} filter`} onClick={() => onChange("")}
      className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring">
      <X className="size-3.5" />
    </button>
  );
  const width = cn("relative w-full sm:w-44", className);

  if (options.length < SEARCHABLE_FROM) {
    return (
      <div className={width}>
        <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
          <SelectTrigger size="sm" aria-label={name} data-active={on || undefined}
            className={cn("w-full transition-colors", on && cn(ON, "pr-8 [&>svg:last-child]:invisible"))}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{allLabel}</SelectItem>
            {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {clear}
      </div>
    );
  }

  const pick = (v: string) => { onChange(v); setOpen(false); };
  return (
    <div className={width}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" role="combobox" aria-expanded={open} aria-label={name} data-active={on || undefined}
            className={cn("w-full justify-between px-3 font-normal transition-colors", on && cn(ON, "pr-8"))}>
            <span className="truncate">{current?.label ?? allLabel}</span>
            <ChevronDown aria-hidden className={cn("size-4 text-muted-foreground", on && "invisible")} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-56 p-0">
          <Command>
            <CommandInput placeholder={`Search ${name.toLowerCase()}…`} />
            <CommandList>
              <CommandEmpty>No matches</CommandEmpty>
              <CommandGroup>
                <CommandItem value={allLabel} onSelect={() => pick("")}>
                  <Check aria-hidden className={cn("size-4", on && "invisible")} />{allLabel}
                </CommandItem>
                {options.map((o) => (
                  <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => pick(o.value)}>
                    <Check aria-hidden className={cn("size-4", o.value !== value && "invisible")} />
                    <span className="truncate">{o.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {clear}
    </div>
  );
}
