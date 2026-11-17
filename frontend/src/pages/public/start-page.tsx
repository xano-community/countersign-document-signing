// A public link's page: anyone can sign their own copy of a template from here. They give their name and email, enter the code
// emailed to them, and land on the signing page for their copy. Nothing is made until the code is right.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { FileSignature, Loader2, Mail, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { publicApi, type PublicBrief } from "@/lib/templates";
import { waitWords } from "@/lib/signing";
import { PublicFrame } from "./public-pages";

export function PublicStartPage() {
  const slug = useParams().slug ?? "";
  const navigate = useNavigate();
  const [brief, setBrief] = useState<PublicBrief | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<"details" | "code">("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { publicApi.brief(slug).then(setBrief, (e) => setLoadError(e.message)); }, [slug]);
  const brand = brief ? { org_name: brief.org_name || "Countersign", logo: brief.logo ?? null } : null;

  const start = async (): Promise<boolean> => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await publicApi.start(slug, name.trim(), email.trim());
      if (r.state === "code_sent") { setStep("code"); setCode(""); return true; }
      else if (r.state === "rate_limited") setError(`Too many codes asked for. Wait ${waitWords(r.retry_after)} and try again.`);
      else if (r.state === "email_off") setError("We can't email you a code right now, so this link can't be used at the moment. Contact the sender.");
      else setBrief({ state: r.state === "off" ? "off" : "not_found" });
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
    return false;
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try {
      const r = await publicApi.verify(slug, name.trim(), email.trim(), code.trim());
      if (r.state === "ok" && r.url) { navigate(new URL(r.url).pathname, { replace: true }); return; }
      if (r.state === "wrong_code") setError(r.tries_left && r.tries_left > 0 ? `That code isn't right. ${r.tries_left} ${r.tries_left === 1 ? "try" : "tries"} left.` : "That code isn't right. Ask for a new one.");
      else if (r.state === "rate_limited") setError(`Too many tries. Wait ${waitWords(r.retry_after)} and try again.`);
      else if (r.state === "unavailable") setError("This link can't be used right now. Contact the sender.");
      else setBrief({ state: r.state === "off" ? "off" : "not_found" });
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  };

  if (loadError) return <PublicFrame brand={null}><Ended title="This page didn't load" body={loadError} /></PublicFrame>;
  if (!brief) return <PublicFrame brand={null}><div className="grid min-h-[40vh] place-items-center"><Loader2 aria-label="Loading" className="animate-spin text-muted-foreground" /></div></PublicFrame>;
  if (brief.state !== "ok") {
    return (
      <PublicFrame brand={brand}>
        <Ended title={brief.state === "off" ? "This link is turned off" : "This link doesn't exist"}
          body={brief.state === "off" ? "Whoever shared it has turned it off for now. Contact them if you still need to sign." : "Check you have the whole address, or ask whoever shared it for the link again."} />
      </PublicFrame>
    );
  }

  return (
    <PublicFrame brand={brand}>
      <div className="rounded-2xl border bg-card p-6 sm:p-8">
        <span aria-hidden className="grid size-12 place-items-center rounded-full bg-[color-mix(in_oklch,var(--sign)_30%,transparent)] text-sign-text"><FileSignature className="size-6" /></span>
        <p className="mt-4 text-caption text-muted-foreground">{brief.org_name} asks you to sign</p>
        <h1 className="text-xl font-semibold">{brief.title}</h1>
        {brief.message ? <p className="mt-3 whitespace-pre-line border-l-2 border-primary pl-3 text-sm">{brief.message}</p> : null}
        <p className="mt-2 text-caption text-muted-foreground">{brief.page_count} {brief.page_count === 1 ? "page" : "pages"}{brief.role_name ? ` · you sign as ${brief.role_name}` : ""}</p>

        {step === "details" ? (
          <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); void start(); }}>
            <div className="grid gap-1.5">
              <Label htmlFor="pub-name">Your full name</Label>
              <Input id="pub-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pub-email">Your email</Label>
              <Input id="pub-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              <p className="text-caption text-muted-foreground">We'll email you a code to confirm it's yours, and send your signed copy there.</p>
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-fit" disabled={busy || !name.trim() || !email.trim()}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : <Mail aria-hidden />}Email me a code</Button>
          </form>
        ) : (
          <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <div className="grid gap-1.5">
              <Label htmlFor="pub-code">Code</Label>
              <Input id="pub-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" inputMode="numeric" maxLength={6} autoFocus
                className="max-w-48 text-center font-mono text-lg tracking-[0.4em]" />
              <p className="text-caption text-muted-foreground">We sent a 6-digit code to {email.trim()}. It works for 10 minutes.</p>
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || code.trim().length !== 6}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Continue to sign</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={async () => { if (await start()) setNote("A new code is on its way. Only the newest one works."); }}>Send a new code</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => { setStep("details"); setError(null); setNote(null); }}>Change email</Button>
            </div>
          </form>
        )}
      </div>
    </PublicFrame>
  );
}

function Ended({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
      <span aria-hidden className="grid size-12 place-items-center rounded-full bg-muted"><ShieldOff className="size-6 text-muted-foreground" /></span>
      <h1 className="mt-4 text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-muted-foreground">{body}</p>
    </div>
  );
}
