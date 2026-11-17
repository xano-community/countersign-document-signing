// Who's here (BASELINE.md "Live"): avatars of the people looking at the same record or board right now, and a dot
// that says whether this tab is live.
import { AvatarStack } from "@/components/kit";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useLiveState, useOnline, useRoom } from "./live";
import { useWorkspace } from "./workspace";
import { useMe } from "./session";

function Faces({ ids, label }: { ids: number[]; label: string }) {
  const { nameOf } = useWorkspace();
  if (!ids.length) return null;
  const names = ids.map(nameOf);
  return (
    <span data-kit="presence" className="inline-flex" aria-label={`${label}: ${names.join(", ")}`}>
      <AvatarStack names={names} max={4} size="sm" />
    </span>
  );
}

/** "Also here": who else has this record or board open. `<PresenceAvatars room={`job-${id}`} />` */
export function PresenceAvatars({ room, label = "Also here" }: { room: string; label?: string }) {
  return <Faces ids={useRoom(room)} label={label} />;
}

/** The header's: everyone else with the app open, and whether this tab is getting live updates. */
export function OnlineNow() {
  const me = useMe();
  const state = useLiveState();
  const others = useOnline().filter((id) => id !== me.id);
  return (
    <span className="hidden items-center gap-2 sm:flex">
      <Faces ids={others} label="Online now" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={state === "live" ? "Live: changes appear as they happen" : "Reconnecting: changes appear within 30 seconds"} data-kit="live-dot"
            className={cn("size-2 rounded-full focus-ring-inset", state === "live" ? "bg-success" : "bg-muted-foreground/40")} />
        </TooltipTrigger>
        <TooltipContent>{state === "live" ? "Live: changes appear as they happen" : "Reconnecting: changes appear within 30 seconds"}</TooltipContent>
      </Tooltip>
    </span>
  );
}
