import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isTyping } from "./shortcuts";
import { LoadError } from "./states";

export interface Column<T> {
  id: string;
  /** Sentence case: "Due date", never "DUE DATE". */
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Classes for the cell and its header, usually a width: "w-32". A column with no width hugs its content. */
  className?: string;
  /** Hide this column below a breakpoint on the wide layout. */
  hideBelow?: "xl" | "2xl";
  /** Makes the header a sort button; this is the key `onSortChange` gets ("created", or "-created" descending). */
  sort?: string;
  /** The column that names the record (default: the first). It takes the spare width, truncates, and links to `rowHref`. */
  primary?: boolean;
  /** Numbers and money: right-aligned with tabular figures, header and cells together. */
  align?: "right";
  /** The full text behind a truncated primary cell, shown on hover (default: the cell, when it is a string). */
  title?: (row: T) => string;
}

type Key = string | number;
const same = (a: Key | null | undefined, b: Key | null | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

// Radix shows its check for "indeterminate" too; draw a dash instead, filled like a checked box.
const MIXED = "relative data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground data-[state=indeterminate]:[&_svg]:hidden data-[state=indeterminate]:after:absolute data-[state=indeterminate]:after:inset-x-[3px] data-[state=indeterminate]:after:top-1/2 data-[state=indeterminate]:after:h-0.5 data-[state=indeterminate]:after:-translate-y-1/2 data-[state=indeterminate]:after:rounded-full data-[state=indeterminate]:after:bg-current";
// A click on these inside a row is theirs, not the row's.
const OWN_CLICK = "button, a, input, textarea, select, label, [role=checkbox], [role=menuitem], [role=option]";

/**
 * A list of records that is right at every width (CRAFT.md §11, §15): a dense table with a sticky header
 * from `lg`, one tappable row per record below it, with its status in view.
 *
 * - Rows are links when `rowHref` is given: ⌘/Ctrl/middle-click opens a new tab, a plain click runs `onOpen`
 *   (a sheet beside the list) or follows the link.
 * - One Tab stop for the table: ↑ ↓ (or j k), Home / End, Enter opens, x selects, Esc clears the selection;
 *   Shift-click a checkbox to select a range.
 * - Sortable headers (`Column.sort` + `sort` / `onSortChange`), the three states (skeleton rows shaped like
 *   the page, an error with Try again, `empty`), "nothing matches" with Clear filters (`filtered`), and
 *   `busy` while a refetch runs.
 */
export function DataList<T>({
  label, rows, error, onRetry, columns, rowKey, mobileRow, onOpen, rowHref, activeKey, empty, filtered = false,
  onClearFilters, sort, onSortChange, busy = false, pageSize = 10, selection, rowActions, footer, className,
}: {
  /** What the list is, plural, for screen readers and "No notes match these filters": "Notes". */
  label: string;
  rows: T[] | null | undefined;
  error?: unknown;
  onRetry?: () => void;
  columns: Column<T>[];
  rowKey: (row: T) => Key;
  /** The phone row: the title, one line of context, and the status badge. */
  mobileRow: (row: T) => ReactNode;
  /** A plain click or Enter on a row (open it in a sheet). Without it, the row follows `rowHref`. */
  onOpen?: (row: T) => void;
  /** The record's own page. The primary cell becomes a real link, so it opens in a new tab like any link. */
  rowHref?: (row: T) => string;
  /** The record open in a sheet beside the list. */
  activeKey?: Key | null;
  /** The true zero state: nothing exists yet. */
  empty: ReactNode;
  /** A filter or search is on: an empty page then says so, keeps the header, and offers `onClearFilters`. */
  filtered?: boolean;
  onClearFilters?: () => void;
  /** The current sort: a column's `sort` key, "-" first for descending. "" or undefined: the list's own order. */
  sort?: string;
  onSortChange?: (next: string) => void;
  /** A refetch is running: the rows dim and the list is aria-busy. */
  busy?: boolean;
  pageSize?: number;
  selection?: { selected: Set<Key>; onChange: (next: Set<Key>) => void; actions: (keys: Key[]) => ReactNode };
  /** A row's own menu (a DropdownMenu on an icon button), in a trailing cell shown on hover and focus. */
  rowActions?: (row: T) => ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const anchor = useRef<Key | null>(null);
  const [focusKey, setFocusKey] = useState<Key | null>(null);
  const navigate = useNavigate();
  const sel = selection?.selected ?? new Set<Key>();
  const selCount = sel.size;
  const clearSelection = selection ? () => selection.onChange(new Set()) : undefined;

  // Esc clears the selection from anywhere, unless something else (a menu, a dialog) took it first.
  const clearRef = useRef(clearSelection);
  clearRef.current = clearSelection;
  useEffect(() => {
    if (!selCount) return;
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isTyping(e.target)) return;
      e.preventDefault();
      clearRef.current?.();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [selCount]);

  // Row actions are reachable by Tab only in the row that holds the table's Tab stop.
  useEffect(() => {
    body.current?.querySelectorAll<HTMLElement>("[data-kit-row-actions]").forEach((cell) => {
      const current = (cell.closest("tr") as HTMLElement | null)?.tabIndex === 0;
      cell.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]").forEach((el) => {
        if (current) el.removeAttribute("tabindex"); else el.tabIndex = -1;
      });
    });
  });

  if (error) return <LoadError error={error} onRetry={onRetry} className={className} />;
  if (rows && rows.length === 0 && !filtered) return <div className={className}>{empty}</div>;

  const hide = (c: Column<T>) => (c.hideBelow === "xl" ? "hidden xl:table-cell" : c.hideBelow === "2xl" ? "hidden 2xl:table-cell" : "");
  const primaryId = (columns.find((c) => c.primary) ?? columns[0])?.id;
  const sizing = (c: Column<T>) => c.id === primaryId
    ? "w-full max-w-0"
    : cn("whitespace-nowrap", !/(^|\s)w-/.test(c.className ?? "") && "w-px", c.align === "right" && "text-right tabular-nums");
  const allKeys = (rows ?? []).map(rowKey);
  const onPage = allKeys.filter((k) => sel.has(k)).length;
  const headState = onPage === 0 ? false : onPage === allKeys.length ? true : "indeterminate";
  const clickable = !!(onOpen || rowHref);
  const tabKey = rows?.length
    ? (allKeys.find((k) => same(k, focusKey)) ?? allKeys.find((k) => same(k, activeKey)) ?? allKeys[0])
    : null;
  const sortKey = sort?.replace(/^-/, "") ?? "";
  const desc = !!sort?.startsWith("-");
  const span = columns.length + (selection ? 1 : 0) + (rowActions ? 1 : 0);
  const nothing = !!rows && rows.length === 0;

  function activate(row: T, newTab = false) {
    const href = rowHref?.(row);
    if (newTab && href) window.open(href, "_blank", "noopener");
    else if (onOpen) onOpen(row);
    else if (href) navigate(href);
  }
  // A plain click on the link runs onOpen; a modified or middle click is the browser's (a new tab).
  const linkClick = (e: MouseEvent, row: T) => {
    if (!onOpen || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(row);
  };
  const toggle = (k: Key, range: boolean) => {
    if (!selection) return;
    const on = !sel.has(k);
    const next = new Set(sel);
    const a = allKeys.findIndex((x) => same(x, anchor.current));
    const b = allKeys.findIndex((x) => same(x, k));
    const keys = range && a >= 0 && b >= 0 ? allKeys.slice(Math.min(a, b), Math.max(a, b) + 1) : [k];
    for (const x of keys) { if (on) next.add(x); else next.delete(x); }
    anchor.current = k;
    selection.onChange(next);
  };
  const toggleAll = () => {
    if (!selection) return;
    const next = new Set(sel);
    for (const k of allKeys) { if (headState === true) next.delete(k); else next.add(k); }
    selection.onChange(next);
  };
  const focusAt = (i: number) => {
    const trs = body.current?.querySelectorAll<HTMLElement>("tr[data-kit-row]");
    if (trs?.length) trs[Math.max(0, Math.min(trs.length - 1, i))].focus();
  };
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T, i: number) => {
    if (e.target !== e.currentTarget) return; // a control inside the cell has it
    const mod = e.metaKey || e.ctrlKey || e.altKey;
    const k = e.key;
    if (k === "ArrowDown" || (k === "j" && !mod)) focusAt(i + 1);
    else if (k === "ArrowUp" || (k === "k" && !mod)) focusAt(i - 1);
    else if (k === "Home") focusAt(0);
    else if (k === "End") focusAt(allKeys.length - 1);
    else if (k === "Enter" && clickable) activate(row, e.metaKey || e.ctrlKey);
    else if (k === "x" && !mod && selection) toggle(rowKey(row), false);
    else return;
    e.preventDefault();
  };
  const primaryCell = (c: Column<T>, row: T) => {
    const content = c.cell(row);
    const title = c.title?.(row) ?? (typeof content === "string" ? content : undefined);
    const href = rowHref?.(row);
    return href
      ? <Link to={href} tabIndex={-1} title={title} onClick={(e) => linkClick(e, row)} className="block truncate focus-ring-inset">{content}</Link>
      : <span className="block truncate" title={title}>{content}</span>;
  };
  const noMatch = (
    <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
      <span>No {label.toLowerCase()} match these filters</span>
      {onClearFilters && <Button variant="outline" size="sm" onClick={onClearFilters}>Clear filters</Button>}
    </div>
  );

  return (
    <div data-kit="data-list" className={cn("flex flex-col gap-3", className)}>
      {/* Wide: a table. overflow-clip (never auto/hidden) keeps the header sticky to the page's scroll pane. */}
      <div className="hidden overflow-clip rounded-lg border bg-card lg:block">
        <table aria-label={label} className="w-full text-body">
          <thead>
            <tr className="border-b">
              {selection && (
                <th className="sticky top-0 z-10 h-9 w-10 bg-card px-3 align-middle">
                  <Checkbox aria-label="Select all on this page" checked={headState} disabled={!rows?.length}
                    onClick={(e) => { e.preventDefault(); toggleAll(); }} className={cn("flex", MIXED)} />
                </th>
              )}
              {columns.map((c) => {
                const on = !!c.sort && c.sort === sortKey;
                return (
                  <th key={c.id} scope="col"
                    aria-sort={c.sort && onSortChange ? (on ? (desc ? "descending" : "ascending") : "none") : undefined}
                    className={cn("sticky top-0 z-10 h-9 bg-card px-3 text-left align-middle text-caption font-medium whitespace-nowrap text-muted-foreground", hide(c), sizing(c), c.className)}>
                    {c.sort && onSortChange ? (
                      <button type="button" onClick={() => onSortChange(on ? (desc ? "" : `-${c.sort}`) : c.sort!)}
                        className={cn("-mx-1.5 inline-flex h-6 items-center gap-1 rounded px-1.5 transition-colors hover:text-foreground focus-ring", on && "text-foreground")}>
                        {c.header}
                        {on && (desc ? <ArrowDown aria-hidden className="size-3" /> : <ArrowUp aria-hidden className="size-3" />)}
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
              {rowActions && <th className="sticky top-0 z-10 h-9 w-10 bg-card"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody ref={body} aria-busy={busy || undefined} className={cn("transition-opacity", busy && "opacity-60")}>
            {!rows
              ? Array.from({ length: pageSize }, (_, i) => (
                <tr key={`skeleton-${i}`} className="h-10 border-b last:border-0">
                  {selection && <td className="w-10 px-3"><Skeleton className="size-4" /></td>}
                  {columns.map((c) => <td key={c.id} className={cn("px-3", hide(c), sizing(c), c.className)}><Skeleton className={cn("h-4", c.id === primaryId ? "w-3/4" : "w-16", c.align === "right" && "ml-auto")} /></td>)}
                  {rowActions && <td className="w-10" />}
                </tr>
              ))
              : nothing
                ? <tr><td colSpan={span}>{noMatch}</td></tr>
                : rows.map((row, i) => {
                  const k = rowKey(row);
                  const active = same(activeKey, k);
                  const picked = sel.has(k);
                  const isTab = same(tabKey, k);
                  return (
                    <tr key={k} data-kit-row={k} tabIndex={isTab ? 0 : -1} aria-current={active || undefined}
                      onFocus={(e) => { if (e.target === e.currentTarget) setFocusKey(k); }}
                      onClick={(e) => {
                        const t = e.target as HTMLElement;
                        if (!clickable || !e.currentTarget.contains(t) || t.closest(OWN_CLICK)) return;
                        if (window.getSelection()?.toString()) return; // they were selecting text
                        activate(row, e.metaKey || e.ctrlKey);
                      }}
                      onKeyDown={(e) => onRowKey(e, row, i)}
                      className={cn("group/row h-10 border-b transition-colors last:border-0 focus-ring-inset",
                        clickable && "cursor-pointer",
                        active ? "bg-selected shadow-[inset_2px_0_0_var(--primary-text)]" : picked ? "bg-selected" : clickable && "hover:bg-muted/50 active:bg-muted")}>
                      {selection && (
                        <td className="w-10 px-3 align-middle">
                          <Checkbox aria-label="Select row" checked={picked} tabIndex={-1} className="flex"
                            onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
                            onClick={(e) => { e.preventDefault(); toggle(k, e.shiftKey); }} />
                        </td>
                      )}
                      {columns.map((c) => (
                        <td key={c.id} className={cn("px-3 align-middle", hide(c), sizing(c), c.className)}>
                          {c.id === primaryId ? primaryCell(c, row) : c.cell(row)}
                        </td>
                      ))}
                      {rowActions && (
                        <td data-kit-row-actions className="w-10 pr-2 text-right align-middle">
                          <div className="opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
                            {rowActions(row)}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      {/* Narrow: one tappable row per record, with its checkbox when the list can select. */}
      <ul aria-label={label} aria-busy={busy || undefined} className={cn("divide-y overflow-clip rounded-lg border bg-card transition-opacity lg:hidden", busy && "opacity-60")}>
        {!rows
          ? Array.from({ length: Math.min(pageSize, 8) }, (_, i) => (
            <li key={`skeleton-${i}`} className="flex flex-col gap-2 p-3"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></li>
          ))
          : nothing
            ? <li>{noMatch}</li>
            : rows.map((row) => {
              const k = rowKey(row);
              const href = rowHref?.(row);
              const inner = "flex w-full min-w-0 flex-1 flex-col gap-1 p-3 text-left text-body transition-colors focus-ring-inset";
              return (
                <li key={k} className={cn("flex items-stretch", (sel.has(k) || same(activeKey, k)) && "bg-selected")}>
                  {selection && (
                    <label className="flex shrink-0 items-center pr-1 pl-3">
                      <Checkbox aria-label="Select row" checked={sel.has(k)} onClick={(e) => { e.preventDefault(); toggle(k, e.shiftKey); }} />
                    </label>
                  )}
                  {href
                    ? <Link to={href} onClick={(e) => linkClick(e, row)} className={cn(inner, "hover:bg-muted/50 active:bg-muted")}>{mobileRow(row)}</Link>
                    : onOpen
                      ? <button type="button" onClick={() => onOpen(row)} className={cn(inner, "hover:bg-muted/50 active:bg-muted")}>{mobileRow(row)}</button>
                      : <div className={inner}>{mobileRow(row)}</div>}
                  {rowActions && <div className="flex shrink-0 items-center pr-2">{rowActions(row)}</div>}
                </li>
              );
            })}
      </ul>

      {selection && <div aria-live="polite" className="sr-only">{selCount ? `${selCount} selected` : ""}</div>}
      {/* Sticks to the bottom of the scroll pane, which ends above the phone's tab bar. */}
      {selection && selCount > 0 && (
        <div role="region" aria-label="Bulk actions" data-kit="bulk-bar"
          className="sticky bottom-3 z-20 mx-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-popover px-3 py-2 text-body shadow-lg">
          <span className="font-medium tabular-nums">{selCount} selected</span>
          <div className="flex flex-wrap items-center gap-2">{selection.actions([...sel])}</div>
          <Button variant="ghost" size="sm" onClick={clearSelection} className="text-muted-foreground">
            <X />Clear<kbd className="rounded border px-1 font-mono text-micro">Esc</kbd>
          </Button>
        </div>
      )}
      {footer}
    </div>
  );
}

/** "1–20 of 126 notes" and previous / next. With one page, just the count. */
export function Pager({ page, pageTotal, itemsTotal, perPage, onPage, noun = "results" }: {
  page: number; pageTotal: number; itemsTotal?: number;
  /** The page size, for the "1–20 of 126" range. */
  perPage?: number;
  onPage: (p: number) => void;
  /** Plural: "notes". */
  noun?: string;
}) {
  if (!itemsTotal && itemsTotal !== undefined) return null;
  if (pageTotal <= 1) return itemsTotal !== undefined ? <p data-kit="pager" className="text-caption text-muted-foreground tabular-nums">{itemsTotal} {noun}</p> : null;
  const range = itemsTotal !== undefined && perPage
    ? `${(page - 1) * perPage + 1}–${Math.min(page * perPage, itemsTotal)} of ${itemsTotal} ${noun}`
    : `Page ${page} of ${pageTotal}`;
  const step = (label: string, to: number, disabled: boolean, icon: ReactNode) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={label} disabled={disabled} onClick={() => onPage(to)}>{icon}</Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
  return (
    <nav aria-label="Pagination" data-kit="pager" className="flex items-center justify-between gap-3 text-caption text-muted-foreground">
      <span className="tabular-nums" aria-live="polite">{range}</span>
      <div className="flex gap-1">
        {step("Previous page", page - 1, page <= 1, <ChevronLeft />)}
        {step("Next page", page + 1, page >= pageTotal, <ChevronRight />)}
      </div>
    </nav>
  );
}
