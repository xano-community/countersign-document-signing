import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The status vocabulary (CRAFT.md §9): neutral, info, success (good), warning (needs a human), danger. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  info: "bg-info/12 text-info",
  success: "bg-success/12 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/12 text-destructive",
};

/** One status, as a small tinted pill. A status never paints a row or a card. */
export function StatusBadge({ tone = "neutral", dot = false, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span data-slot="status-badge" data-tone={tone}
      className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-caption font-medium whitespace-nowrap", TONES[tone], className)}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/**
 * A status as an item's 3 px left edge (a calendar chip, a schedule card): colour with the status's words beside
 * it for a screen reader, never colour alone. `border-l-[3px]` plus this.
 */
export const TONE_EDGE: Record<Tone, string> = {
  neutral: "border-l-muted-foreground",
  info: "border-l-info",
  success: "border-l-success",
  warning: "border-l-warning",
  danger: "border-l-destructive",
};

/** A tone as a solid dot: a legend's key, beside its words. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

/** What a calendar chip or schedule card says its status is: the words and their tone. */
export interface ItemStatus { label: string; tone: Tone }
