import type { ReactNode } from "react";
import { Link } from "react-router";
import { AlertCircle, ChevronLeft, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";

/**
 * The top of every screen: title, one line of what it's for, and the screen's main actions (the primary one last,
 * so it sits at the right edge). `back` is the way up from a detail page: "← Notes".
 */
export function PageHeader({ title, description, actions, back, children, className }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { href: string; label: string }; children?: ReactNode; className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {back && (
            <Link to={back.href} data-kit="back" className="focus-ring -ml-1 mb-1 inline-flex items-center gap-0.5 rounded-sm px-1 text-caption text-muted-foreground transition-colors hover:text-foreground">
              <ChevronLeft aria-hidden className="size-3.5" />{back.label}
            </Link>
          )}
          <h1 className="text-title text-pretty wrap-anywhere">{title}</h1>
          {description && <p className="mt-0.5 text-body text-pretty text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** A section that failed to load: what failed, in plain words, and Try again. Nothing else of the section. */
export function LoadError({ title = "This didn't load", error, onRetry, className }: {
  title?: string; error?: unknown; onRetry?: () => void; className?: string;
}) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong on our side.";
  return (
    <div role="alert" data-kit="load-error" className={cn("flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-body", className)}>
      <AlertCircle aria-hidden className="size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-muted-foreground">{message}</div>
      </div>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/** Nothing here yet (or nothing matches): an icon, one sentence, and the action that fixes it. */
export function EmptyState({ icon: Icon, title, description, action, className }: {
  icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <Empty data-kit="empty" className={cn("border border-dashed", className)}>
      <EmptyHeader>
        {Icon && <EmptyMedia variant="icon"><Icon /></EmptyMedia>}
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
