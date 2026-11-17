import type { KeyboardEvent, ReactNode } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronUp, Link2, Maximize2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isTyping } from "./shortcuts";

/** An icon-only button with its name on hover (CRAFT.md §13). */
function IconAction({ label, onClick, disabled, children, asChild }: { label: string; onClick?: () => void; disabled?: boolean; children: ReactNode; asChild?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled} asChild={asChild} className="text-muted-foreground hover:text-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A record beside its list (CRAFT.md §7): the list stays put, Escape closes, and with useOpenParam the
 * URL carries `?open=<id>` so a link opens it and Back closes it.
 *
 * It's a PEEK, not a modal: no dimmed overlay, and the list (a DataList, board, schedule or calendar) stays live
 * behind it, so clicking another record swaps the sheet's record in place (Linear, Attio). A click anywhere else
 * closes it. `modal` brings back the overlay and focus trap (a flow that must finish first).
 *
 * The header: the record's ID (with Copy link), the title, then `meta` badges; on the right, previous /
 * next (also K / J while the sheet has focus), Open full page (`href`), and close.
 *
 *   const [openId, open, close] = useOpenParam();
 *   <DataList … onOpen={(r) => open(r.id)} activeKey={openId} />
 *   <RecordSheet open={!!openId} onClose={close} loading={!note} recordId={`#${note?.id}`} href={`/notes/${note?.id}`}
 *     title={note?.title} onPrev={…} onNext={…}>…</RecordSheet>
 */
// What a click may land on without closing the sheet: the lists that open records, and a toast's Undo.
const STAYS_OPEN = '[data-kit="data-list"], [data-kit="kanban"], [data-kit="schedule"], [data-kit="calendar"], [data-kit-peek], [data-sonner-toaster]';

export function RecordSheet({ open, onClose, title, description, recordId, href, loading = false, onPrev, onNext, meta, actions, children, wide = false, modal = false }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode;
  /** The record's ID ("#42", "INV-0042"), in mono above the title, with a Copy link button. */
  recordId?: ReactNode;
  /** The record's own page: an "Open full page" button, and what Copy link copies (else the current URL). */
  href?: string;
  /** The record is on its way: skeletons in the header and body, shaped like what's coming. */
  loading?: boolean;
  /** Step to the previous / next record in the list's order (K / J). Omit at the ends. */
  onPrev?: () => void;
  onNext?: () => void;
  /** Badges under the title (status, priority). */
  meta?: ReactNode;
  /** The record's actions, pinned to the bottom. */
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  /** Dim and lock the page behind it (focus trapped) instead of the default peek. */
  modal?: boolean;
}) {
  const copyLink = async () => {
    const url = href ? new URL(href, window.location.origin).toString() : window.location.href;
    try { await navigator.clipboard.writeText(url); toast.success("Link copied"); }
    catch { toast.error("Couldn't copy the link. Copy it from the address bar."); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    // Not from inside a menu or a picker the sheet holds.
    if ((e.target as HTMLElement).closest?.("[role=menu], [role=listbox], [data-kit=month-grid]")) return;
    if (e.key === "j" && onNext) { e.preventDefault(); onNext(); }
    else if (e.key === "k" && onPrev) { e.preventDefault(); onPrev(); }
  };
  const stepping = onPrev !== undefined || onNext !== undefined;

  return (
    <Sheet open={open} modal={modal} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" data-kit="record-sheet" showCloseButton={false} onKeyDown={onKey}
        // Focus the sheet itself, not its first button (that would pop the Copy link tooltip); J / K work at once.
        onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}
        className={cn("flex w-full flex-col gap-0 p-0 outline-none", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}
        // Picking another record in the list (or a toast's Undo) isn't "outside": the sheet stays and swaps.
        onInteractOutside={(e) => { if ((e.target as HTMLElement | null)?.closest?.(modal ? "[data-sonner-toaster]" : STAYS_OPEN)) e.preventDefault(); }}>
        <SheetHeader className="gap-2 border-b p-4">
          <div className="flex min-h-8 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {loading ? <Skeleton className="h-4 w-16" /> : recordId !== undefined && (
                <>
                  <span className="truncate font-mono text-caption text-muted-foreground">{recordId}</span>
                  <IconAction label="Copy link" onClick={() => void copyLink()}><Link2 /></IconAction>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center">
              {stepping && (
                <>
                  <IconAction label="Previous (K)" onClick={onPrev} disabled={!onPrev}><ChevronUp /></IconAction>
                  <IconAction label="Next (J)" onClick={onNext} disabled={!onNext}><ChevronDown /></IconAction>
                </>
              )}
              {href && !loading && <IconAction label="Open full page" asChild><Link to={href}><Maximize2 /></Link></IconAction>}
              <IconAction label="Close (Esc)" onClick={onClose}><X /></IconAction>
            </div>
          </div>
          {loading
            ? <><SheetTitle className="sr-only">Loading</SheetTitle><Skeleton className="h-6 w-2/3" /></>
            : <SheetTitle className="text-title wrap-anywhere">{title}</SheetTitle>}
          {meta && !loading && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
          {description ? <SheetDescription className="text-body">{description}</SheetDescription> : <SheetDescription className="sr-only">Details</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-body">
          {loading ? (
            <div className="flex flex-col gap-3" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => (
                <div key={`skeleton-${i}`} className="grid min-h-8 grid-cols-[minmax(6rem,auto)_1fr] items-center gap-x-4">
                  <Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-32" />
                </div>
              ))}
              <Skeleton className="mt-3 h-24 w-full" />
            </div>
          ) : children}
        </div>
        {actions && !loading && <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t p-4">{actions}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}

/** Label / value pairs for a record's details: every row is at least a control tall, so text and controls line up. */
export function Fields({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 text-body", className)}>{children}</dl>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex min-h-8 items-center text-muted-foreground">{label}</dt>
      <dd className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-1.5 wrap-anywhere">{children}</dd>
    </>
  );
}
