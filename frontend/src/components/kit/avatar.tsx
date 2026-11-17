import { cn } from "@/lib/utils";

/** "Ada Admin" → "AA": the avatar when there's no picture. */
export const initialsOf = (name: string) => name.trim().split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";

export type AvatarSize = "xs" | "sm" | "md" | "lg";

// 20 / 24 / 32 / 48 px. Initials are 11 px up to 24 px, 12 px at 32 px, 14 px at 48 px (a profile's header).
const SIZE: Record<AvatarSize, string> = { xs: "size-5 text-micro", sm: "size-6 text-micro", md: "size-8 text-caption", lg: "size-12 text-heading" };
const FACE = "inline-grid shrink-0 place-items-center rounded-full bg-muted font-medium text-foreground/80 select-none";

/**
 * Who's on it: a person's initials in a neutral circle, their name on hover and to a screen reader. `decorative`
 * when the name is already written beside it (a user menu, a "Continue as Ada" button), so it isn't read twice.
 */
export function Avatar({ name, size = "sm", decorative = false, className }: { name: string; size?: AvatarSize; decorative?: boolean; className?: string }) {
  return (
    <span {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name, title: name })} data-slot="avatar" className={cn(FACE, SIZE[size], className)}>
      <span aria-hidden>{initialsOf(name)}</span>
    </span>
  );
}

/** Several people, overlapped: the first `max`, then "+N". The whole list is the hover and the label. */
export function AvatarStack({ names, max = 3, size = "sm", className }: { names: string[]; max?: number; size?: AvatarSize; className?: string }) {
  if (!names.length) return null;
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const all = names.join(", ");
  return (
    <span role="img" aria-label={all} title={all} data-slot="avatar-stack" className={cn("inline-flex items-center -space-x-1.5", className)}>
      {shown.map((n, i) => <span key={`${n}-${i}`} aria-hidden className={cn(FACE, SIZE[size], "ring-2 ring-card")}>{initialsOf(n)}</span>)}
      {rest > 0 && <span aria-hidden className={cn(FACE, SIZE[size], "text-micro text-muted-foreground tabular-nums ring-2 ring-card")}>+{rest}</span>}
    </span>
  );
}
