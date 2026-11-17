// The two pages anyone can open without signing in: checking a PDF against completed documents, and a party's personal link
// to their signed copy. The file being checked never leaves the visitor's device: only its fingerprint is sent.
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { CheckCircle2, Clock, Download, Eye, FileQuestion, Loader2, ShieldCheck, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/components/kit/cn";
import { XANO_HOST } from "@/base/request";
import { sha256Hex } from "@/lib/pdf/combine";
import { routePath } from "../../../../xano/routes.gen";
import { PdfReader } from "@/components/pdf/pdf-reader";

export type Brand = { org_name: string; logo: string | null };

async function get<T>(path: string): Promise<T> {
  const r = await fetch(XANO_HOST + path, { referrerPolicy: "no-referrer" });
  if (!r.ok) throw new Error("We can't reach the server. Check your connection, then try again.");
  return r.json() as Promise<T>;
}

function useBrand() {
  const [brand, setBrand] = useState<Brand | null>(null);
  useEffect(() => { get<Brand>(routePath("GET brand")).then(setBrand, () => setBrand({ org_name: "Countersign", logo: null })); }, []);
  return brand;
}

export function PublicFrame({ brand, children }: { brand: Brand | null; children: React.ReactNode }) {
  const name = brand?.org_name ?? "Countersign";
  return (
    <div className="min-h-dvh bg-paper text-foreground">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          {brand?.logo ? <img src={brand.logo} alt="" className="size-8 rounded-md object-contain" /> : <span aria-hidden className="grid size-8 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">{name[0]}</span>}
          <span className="font-medium">{name}</span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8 sm:py-14">{children}</main>
    </div>
  );
}

type Verdict = { state: "match" | "no_match" | "purged" | "invalid" | "rate_limited"; completed_at: number | null; signer_count: number; signers: { name: string; role: string; role_name: string }[] | null; retry_after: number };

/** The verify page anyone can open, in the organisation's public frame. */
export function VerifyPage() {
  const brand = useBrand();
  return <PublicFrame brand={brand}><VerifyForm orgName={brand?.org_name} /></PublicFrame>;
}

/** The same check inside the app, for the team: in the app's own layout, with a link to share the public one. */
export function VerifyInAppPage() {
  const brand = useBrand();
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-8 sm:py-10">
      <VerifyForm orgName={brand?.org_name} />
      <p className="mt-6 text-caption text-muted-foreground">Anyone can check a file without signing in at <Link to="/verify" className="underline">{window.location.origin}/verify</Link>. Share that address with the people you sign with.</p>
    </div>
  );
}

function VerifyForm({ orgName }: { orgName?: string }) {
  const [file, setFile] = useState<{ name: string; sha: string } | null>(null);
  const [publicId, setPublicId] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const check = useCallback(async (sha: string, id: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(XANO_HOST + routePath("POST verify"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256: sha, public_id: id.trim() || undefined }) });
      if (!r.ok) throw new Error("The check didn't run. Try again.");
      setVerdict(await r.json());
    } catch (e) { setError(e instanceof Error ? e.message : "The check didn't run. Try again."); }
    finally { setBusy(false); }
  }, []);
  const pick = async (f: File) => {
    setVerdict(null); setError(null); setBusy(true);
    try { const sha = await sha256Hex(new Uint8Array(await f.arrayBuffer())); setFile({ name: f.name, sha }); await check(sha, publicId); }
    catch { setBusy(false); setError("That file couldn't be read."); }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold">Check a signed document</h1>
      <p className="mt-2 text-muted-foreground">Drop a PDF to see whether it matches a document signed through {orgName ?? "us"}. Your file stays on your device: only its fingerprint is checked.</p>
      <label
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void pick(f); }}
        className={cn("focus-within:ring-ring mt-6 flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center focus-within:ring-2", dragging ? "border-primary" : "border-input")}>
        {busy ? <Loader2 aria-hidden className="size-6 animate-spin text-primary-text" /> : <Upload aria-hidden className="size-6 text-primary-text" />}
        <span className="font-medium">{file ? file.name : "Drop a PDF, or choose a file"}</span>
        <span className="text-caption text-muted-foreground">{file ? "Checked. Drop another to check it." : "Any PDF you were sent after signing."}</span>
        <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ""; }} />
      </label>

      <div aria-live="polite">
        {error ? <p role="alert" className="mt-4 text-sm text-destructive">{error}</p> : null}
        {verdict?.state === "match" && (
          <div className="mt-5 flex gap-3 rounded-xl bg-[color-mix(in_oklch,var(--success)_12%,transparent)] p-4">
            <CheckCircle2 aria-hidden className="size-6 shrink-0 text-[var(--success)]" />
            <div>
              <p className="font-semibold">Matches a completed document</p>
              <p className="text-sm text-muted-foreground">
                Completed {verdict.completed_at ? new Date(verdict.completed_at).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }) : ""} · {verdict.signer_count} {verdict.signer_count === 1 ? "signer" : "signers"}.
                {verdict.signers ? null : " Add the document ID from the PDF's footer to see who signed."}
              </p>
              {verdict.signers ? <ul className="mt-2 text-sm">{verdict.signers.map((s, i) => <li key={i}>{s.name}{s.role_name ? ` · ${s.role_name}` : ""}</li>)}</ul> : null}
            </div>
          </div>
        )}
        {verdict?.state === "no_match" && (
          <div className="mt-5 flex gap-3 rounded-xl border bg-card p-4">
            <FileQuestion aria-hidden className="size-6 shrink-0 text-[var(--warning)]" />
            <div><p className="font-semibold">No match</p><p className="text-sm text-muted-foreground">This file doesn't match any completed document. Any change to a signed PDF, even re-saving it in another app, changes its fingerprint. Check the copy you were sent by email.</p></div>
          </div>
        )}
        {verdict?.state === "purged" && (
          <div className="mt-5 flex gap-3 rounded-xl border bg-card p-4">
            <Clock aria-hidden className="size-6 shrink-0 text-muted-foreground" />
            <div><p className="font-semibold">This document was deleted under the retention policy</p><p className="text-sm text-muted-foreground">It matched a completed document that has since been deleted, so its details are no longer kept.</p></div>
          </div>
        )}
        {verdict?.state === "rate_limited" && <p role="alert" className="mt-4 text-sm text-destructive">Too many checks. Wait a minute and try again.</p>}
      </div>

      <form className="mt-6 grid gap-1.5" onSubmit={(e) => { e.preventDefault(); if (file) void check(file.sha, publicId); }}>
        <Label htmlFor="public-id">Document ID (optional)</Label>
        <div className="flex gap-2">
          <Input id="public-id" value={publicId} onChange={(e) => setPublicId(e.target.value.toUpperCase())} placeholder="CS-XXXX-XXXX-XXXX" className="font-mono" />
          <Button type="submit" variant="outline" disabled={!file || busy}>Check</Button>
        </div>
        <p className="text-caption text-muted-foreground">It's printed at the bottom of every page of the signed PDF.</p>
      </form>
    </>
  );
}

type Final = { state: "ready" | "expired" | "rate_limited" | "unavailable"; how: "signed" | "table" | null; url: string | null; name: string | null; envelope: { title: string; public_id: string; final_sha256: string; completed_at: number } | null };

export function SignedCopyPage() {
  const token = useParams().token ?? "";
  const brand = useBrand();
  const [final, setFinal] = useState<Final | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(XANO_HOST + routePath("POST sign/final"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), referrerPolicy: "no-referrer" })
      .then(async (r) => { if (!r.ok) throw new Error("We can't reach the server. Check your connection, then try again."); setFinal(await r.json()); }, () => { throw new Error("We can't reach the server. Check your connection, then try again."); })
      .catch((e) => setError(e instanceof Error ? e.message : "We can't reach the server."));
  }, [token]);

  const [file, setFile] = useState<Blob | null>(null);
  const [viewing, setViewing] = useState(false);
  /** The signed PDF's bytes, fetched once and kept for viewing and downloading. */
  const getFile = async (): Promise<Blob | null> => {
    if (file) return file;
    if (!final) return null;
    const r = final.how === "signed" && final.url
      ? await fetch(final.url, { referrerPolicy: "no-referrer" })
      : await fetch(XANO_HOST + routePath("POST sign/final/raw"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), referrerPolicy: "no-referrer" });
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("json")) throw new Error("The file didn't load. Try again.");
    const blob = await r.blob();
    setFile(blob);
    return blob;
  };
  const withFile = async (then: (b: Blob) => void) => {
    setBusy(true); setError(null);
    try { const b = await getFile(); if (b) then(b); }
    catch (e) { setError(e instanceof Error ? e.message : "The file didn't load. Try again."); }
    finally { setBusy(false); }
  };
  const save = (b: Blob) => {
    const url = URL.createObjectURL(b);
    const a = Object.assign(document.createElement("a"), { href: url, download: final?.name ?? "signed.pdf" });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const download = () => withFile(save);

  return (
    <PublicFrame brand={brand}>
      {!final && !error ? <div className="grid min-h-[40vh] place-items-center"><Loader2 aria-label="Loading" className="animate-spin text-muted-foreground" /></div>
        : final?.state === "ready" && final.envelope ? (
          <>
          <div className="rounded-2xl border bg-card p-6 sm:p-8">
            <span className="grid size-12 place-items-center rounded-full bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-[var(--success)]"><ShieldCheck aria-hidden className="size-6" /></span>
            <h1 className="mt-4 text-xl font-semibold">Your signed copy</h1>
            <p className="mt-1 text-muted-foreground">“{final.envelope.title}”, completed {new Date(final.envelope.completed_at).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}. It includes a certificate of who signed and when.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={download} disabled={busy}>{busy && !viewing ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}Download signed PDF</Button>
              {!viewing ? <Button variant="outline" disabled={busy} onClick={() => withFile(() => setViewing(true))}><Eye aria-hidden />View it here</Button> : null}
            </div>
            <dl className="mt-6 grid gap-1 border-t pt-4 text-caption">
              <dt className="text-muted-foreground">Document ID</dt><dd className="font-mono">{final.envelope.public_id}</dd>
              <dt className="mt-2 text-muted-foreground">Fingerprint (SHA-256)</dt><dd className="break-all font-mono">{final.envelope.final_sha256}</dd>
            </dl>
            <p className="mt-4 text-caption text-muted-foreground">Anyone can check this file on <Link to="/verify" className="underline">the verify page</Link>.</p>
            {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
          </div>
          {viewing && file ? (
            <div className="mt-4 h-[80dvh] overflow-hidden rounded-2xl border bg-card">
              <PdfReader className="h-full" file={file} name={final.name ?? "signed.pdf"} label={`${final.envelope.title}, signed copy`} onDownload={() => save(file)} />
            </div>
          ) : null}
          </>
        ) : (
          <div className="rounded-2xl border bg-card p-6 sm:p-8">
            <span className="grid size-12 place-items-center rounded-full bg-muted"><Clock aria-hidden className="size-6 text-muted-foreground" /></span>
            <h1 className="mt-4 text-xl font-semibold">{final?.state === "rate_limited" ? "Too many tries" : final?.state === "unavailable" ? "This file isn't available right now" : "This link has expired"}</h1>
            <p className="mt-1 text-muted-foreground">
              {final?.state === "rate_limited" ? "Wait a minute and try again." : final?.state === "unavailable" ? "Storage didn't answer just now. Try again in a moment." : error ?? "This download link no longer works. The document may have been deleted under the retention policy. Ask the sender for a copy."}
            </p>
          </div>
        )}
    </PublicFrame>
  );
}
