// On the sign-in page, under the demo people: open the demo signer's page, to see what a recipient sees from their email link.
import { useState } from "react";
import { useNavigate } from "react-router";
import { FileSignature, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { XANO_HOST } from "@/base/request";
import { routePath } from "../../../../xano/routes.gen";

export function DemoSignerButton() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(XANO_HOST + routePath("POST sign/demo"), { method: "POST", referrerPolicy: "no-referrer" });
      const j = (await r.json()) as { state: string; path: string };
      if (j.state === "ok" && j.path) { navigate(j.path); return; }
      setError(j.state === "gone" ? "The demo signer's document isn't here any more." : "The signer demo is off.");
    } catch { setError("We can't reach the server. Try again."); }
    setBusy(false);
  };
  return (
    <div className="grid gap-1">
      <Button variant="outline" className="h-auto justify-start gap-3 border-dashed py-2 text-left" disabled={busy} onClick={open}>
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-sign text-sign-ink">{busy ? <Loader2 className="size-4 animate-spin" /> : <FileSignature className="size-4" />}</span>
        <span className="min-w-0"><span className="block font-medium">See what a signer sees</span><span className="block truncate text-xs font-normal text-muted-foreground">Open Maya's lease from her email link, no account needed</span></span>
      </Button>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
