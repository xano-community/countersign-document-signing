// Once a day: erase ended documents older than the organisation's retention period (Settings → Data). Off when it's 0.
import { s, task as scheduledTask } from "@xano/sdk";
import { purgeDueFn } from "../function/settings/org.js";

export const purgeDaily = scheduledTask({
  name: "purge/daily",
  description: "Erase ended documents older than the retention period, leaving a verify tombstone for completed ones.",
  schedule: [{ startsOn: "2026-01-01 03:00:00+0000", freq: 86_400 }],
  stack: [s.try_catch({ try: [s.function.run({ fn: purgeDueFn, as: "purged" })] })],
});
