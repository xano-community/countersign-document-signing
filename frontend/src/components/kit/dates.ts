/** Local-calendar date helpers. A "day key" is the local date as YYYY-MM-DD. */
import { createContext, useContext } from "react";

export const startOfDay = (d: Date) => { const n = new Date(d); n.setHours(0, 0, 0, 0); return n; };
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/**
 * Any date value to a Date. A bare day ("2026-10-06", a Xano `date` field) is that day in the person's own
 * calendar, not UTC midnight (which is the day before west of Greenwich).
 */
export const toDate = (v: Date | number | string): Date => {
  if (v instanceof Date) return v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fromDayKey(v);
  return new Date(v);
};
export const dayKey = (d: Date | number | string) => {
  const x = toDate(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
export type WeekStart = "monday" | "sunday";
/** The first day of d's week: Monday unless told Sunday. */
export const startOfWeek = (d: Date, weekStart: WeekStart = "monday") => {
  const s = startOfDay(d);
  return addDays(s, -(weekStart === "sunday" ? s.getDay() : (s.getDay() + 6) % 7));
};
/**
 * The workspace's week start, for every calendar and schedule under it (the base app provides it from Settings). A
 * `weekStartsOn` prop still wins.
 */
const WeekStartContext = createContext<WeekStart>("monday");
export const WeekStartProvider = WeekStartContext.Provider;
export const useWeekStart = () => useContext(WeekStartContext);
export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const isToday = (d: Date) => dayKey(d) === dayKey(new Date());
export const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
/** A day key back to a local Date at midnight. */
export function fromDayKey(k: string) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
