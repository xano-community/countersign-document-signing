import { useSyncExternalStore } from "react";
import { ACCENTS, DEFAULT_ACCENT, type Accent } from "./accents";

/** The person's theme: light, dark, or the system's. Remembered, and applied before paint by index.html. */
export type ThemeMode = "light" | "dark" | "system";
export { ACCENTS, type Accent };
const KEY = "kit.theme";
const ACCENT_KEY = "kit.accent";
const listeners = new Set<() => void>();
const media = () => (typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null);
const notify = () => listeners.forEach((l) => l());

function read(): ThemeMode {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
function apply(mode: ThemeMode) {
  const dark = mode === "dark" || (mode === "system" && !!media()?.matches);
  document.documentElement.classList.toggle("dark", dark);
}
export function setThemeMode(mode: ThemeMode) {
  try { if (mode === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch { /* storage off */ }
  apply(mode);
  notify();
}

// The accent: the app's own (index.html's <html data-accent-default>) unless the person picked another.
const isAccent = (v: string | null | undefined): v is Accent => ACCENTS.some((a) => a.name === v);
export function appAccent(): Accent {
  const v = typeof document !== "undefined" ? document.documentElement.dataset.accentDefault : undefined;
  return isAccent(v) ? v : DEFAULT_ACCENT;
}
function readAccent(): Accent {
  try { const v = localStorage.getItem(ACCENT_KEY); if (isAccent(v)) return v; } catch { /* storage off */ }
  return appAccent();
}
/** Pick an accent for this device; the app's own accent clears the choice so a later default change reaches them. */
export function setAccent(accent: Accent) {
  try { if (accent === appAccent()) localStorage.removeItem(ACCENT_KEY); else localStorage.setItem(ACCENT_KEY, accent); } catch { /* storage off */ }
  document.documentElement.dataset.accent = accent;
  notify();
}

let watching = false;
function subscribe(l: () => void) {
  listeners.add(l);
  if (!watching && media()) {
    watching = true;
    media()!.addEventListener("change", () => { if (read() === "system") { apply("system"); notify(); } });
    // Another tab changed it: follow.
    window.addEventListener("storage", (e) => {
      if (e.key === KEY) { apply(read()); notify(); }
      if (e.key === ACCENT_KEY) { document.documentElement.dataset.accent = readAccent(); notify(); }
    });
  }
  return () => listeners.delete(l);
}
const snapshot = () => `${read()}|${typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? 1 : 0}|${readAccent()}`;

/** `{ mode, dark, setMode, toggle, accent, setAccent }`: one source of truth for every control that changes the look. */
export function useTheme() {
  const [mode, dark, accent] = useSyncExternalStore(subscribe, snapshot, () => `system|0|${DEFAULT_ACCENT}`).split("|") as [ThemeMode, string, Accent];
  return {
    mode,
    dark: dark === "1",
    setMode: setThemeMode,
    toggle: () => setThemeMode(dark === "1" ? "light" : "dark"),
    accent,
    setAccent,
  };
}
