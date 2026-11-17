import { Check, Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { Segmented, SettingRow } from "./segmented";
import { ACCENTS, useTheme, type ThemeMode } from "./theme";

const MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }, { value: "system", label: "System", icon: Monitor },
];

/** Light, dark or the system's: remembered on this device. */
export function ThemeChoice() {
  const { mode, setMode } = useTheme();
  return <Segmented label="Theme" value={mode} onChange={setMode} options={MODES} data-kit="profile-theme" />;
}

/**
 * The accent swatches (kit/accents.ts, generated with theme.css): every one is contrast-checked in both themes, so
 * any pick stays readable. Buttons, links, focus and the selected row follow it; status colours never do.
 */
export function AccentChoice() {
  const { accent, setAccent, dark } = useTheme();
  return (
    <div role="radiogroup" aria-label="Accent colour" data-testid="accent-picker" className="flex flex-wrap gap-1.5">
      {ACCENTS.map((a) => {
        const on = accent === a.name;
        return (
          <button key={a.name} type="button" role="radio" aria-checked={on} aria-label={a.label} title={a.label}
            onClick={() => setAccent(a.name)}
            className={cn("focus-ring grid size-8 place-items-center rounded-full border-2 transition-colors", on ? "border-foreground/60" : "border-transparent hover:border-border")}>
            <span aria-hidden className="grid size-6 place-items-center rounded-full shadow-[inset_0_0_0_1px_oklch(0_0_0/0.12)]" style={{ background: dark ? a.dark : a.light }}>
              {on && <Check className="size-3.5" strokeWidth={3} style={{ color: dark ? a.darkInk : a.lightInk }} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Theme + accent, as Settings and Profile show them. */
export function AppearanceSettings() {
  return (
    <div className="grid gap-5" data-kit="appearance">
      <SettingRow id="kit-theme-label" label="Theme"><ThemeChoice /></SettingRow>
      <SettingRow id="kit-accent-label" label="Accent colour" hint="Buttons, links, focus and the selected row. Status colours stay the same.">
        <AccentChoice />
      </SettingRow>
    </div>
  );
}
