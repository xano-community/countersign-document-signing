import { useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<V extends string> { value: V; label: string; icon?: LucideIcon; /** Show only the icon (the label becomes its name and tooltip). */ iconOnly?: boolean }

/**
 * A small set of exclusive choices side by side: a theme, a view (list / board / calendar), a period. A radio group
 * with arrow keys; the chosen one is a raised chip. More than ~4 options, or long labels: use a Select.
 */
export function Segmented<V extends string>({ value, onChange, options, label, size = "sm", className, "data-kit": kit = "segmented" }: {
  value: V; onChange: (v: V) => void; options: SegmentedOption<V>[]; label: string; size?: "sm" | "xs"; className?: string; "data-kit"?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="radiogroup" aria-label={label} data-kit={kit}
      className={cn("inline-flex w-fit items-center gap-0.5 rounded-md bg-muted p-0.5", className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
            aria-label={o.iconOnly ? o.label : undefined} title={o.iconOnly ? o.label : undefined}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const n = (i + d + options.length) % options.length;
              onChange(options[n].value);
              refs.current[n]?.focus();
            }}
            className={cn("focus-ring inline-flex items-center justify-center gap-1.5 rounded-sm font-medium whitespace-nowrap transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
              size === "sm" ? "h-7 px-2.5 text-body" : "h-6 px-2 text-caption",
              on ? "bg-background text-foreground shadow-xs dark:bg-input" : "text-muted-foreground hover:text-foreground")}>
            {o.icon && <o.icon aria-hidden />}
            {!o.iconOnly && o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled control in a settings card: the label, the control, and a line of help under it. */
export function SettingRow({ label, id, hint, children }: { label: string; id: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2" role="group" aria-labelledby={id}>
      <span id={id} className="text-body font-medium">{label}</span>
      {children}
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </div>
  );
}
