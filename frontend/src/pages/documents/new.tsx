// New document: drop one or more PDFs, put them in order, name it, and continue to Prepare. Each file is read in the browser
// first, so a password-protected or damaged file is refused by name before anything uploads, and the deployment's size limit is
// named up front. Several files are combined here, in the order shown; a retried upload answers the same draft.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, FileText, Loader2, Lock, Upload, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError, PageHeader, Segmented, useLoad } from "@/components/kit";
import { cn } from "@/components/kit/cn";
import { inspectPdf, type Inspected } from "@/lib/pdf/inspect";
import { combinePdfs } from "@/lib/pdf/combine";
import { envelopesApi } from "@/lib/envelopes";

type Picked = { key: string; file: File; check: Inspected | null };

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
const titleFrom = (name: string) => name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

export function NewDocumentPage() {
  const navigate = useNavigate();
  // `?template=1`: the same upload, starting a template instead of a document.
  const asTemplate = useSearchParams()[0].get("template") === "1";
  const storage = useLoad(() => envelopesApi.storage(), []);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [visibility, setVisibility] = useState<"private" | "team">("team");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<"" | "combining" | "uploading">("");
  const [error, setError] = useState<string | null>(null);
  // One id per set of files: a retry after a dropped connection answers the draft the first try made.
  const clientId = useRef(crypto.randomUUID());
  const input = useRef<HTMLInputElement>(null);
  const limit = storage.data?.max_upload_bytes ?? 0;

  const add = useCallback(async (files: FileList | File[]) => {
    setError(null);
    clientId.current = crypto.randomUUID();
    const next = Array.from(files).map((file) => ({ key: crypto.randomUUID(), file, check: null as Inspected | null }));
    setPicked((p) => [...p, ...next]);
    for (const n of next) {
      const check = await inspectPdf(n.file);
      setPicked((p) => p.map((x) => (x.key === n.key ? { ...x, check } : x)));
    }
  }, []);

  useEffect(() => {
    if (!titleTouched && picked[0]) setTitle(titleFrom(picked[0].file.name));
    if (!picked.length && !titleTouched) setTitle("");
  }, [picked, titleTouched]);

  const move = (i: number, d: -1 | 1) => setPicked((p) => {
    const n = [...p];
    const j = i + d;
    if (j < 0 || j >= n.length) return p;
    [n[i], n[j]] = [n[j], n[i]];
    clientId.current = crypto.randomUUID();
    return n;
  });
  const remove = (key: string) => { clientId.current = crypto.randomUUID(); setPicked((p) => p.filter((x) => x.key !== key)); };

  const total = picked.reduce((n, p) => n + p.file.size, 0);
  const refused = picked.filter((p) => p.check && !p.check.ok);
  const checking = picked.some((p) => !p.check);
  const pages = picked.reduce((n, p) => n + (p.check?.ok ? p.check.pages.length : 0), 0);
  const tooBig = limit > 0 && total > limit;
  const ready = picked.length > 0 && !checking && refused.length === 0 && !tooBig && title.trim().length > 0 && !busy;

  const blocker = useMemo(() => {
    if (!picked.length) return "";
    if (checking) return "Reading your files…";
    if (refused.length) return refused.length === 1 ? "Remove the file that can't be used, then continue." : "Remove the files that can't be used, then continue.";
    if (tooBig) return `Together these are ${mb(total)}. This deployment takes documents up to ${mb(limit)}.`;
    if (!title.trim()) return "Give the document a title.";
    return "";
  }, [picked.length, checking, refused.length, tooBig, total, limit, title]);

  const submit = async () => {
    if (!ready) return;
    setError(null);
    try {
      setBusy("combining");
      const combined = await combinePdfs(picked.map((p) => p.file));
      if (limit && combined.bytes.length > limit) { setBusy(""); setError(`Combined, this is ${mb(combined.bytes.length)}. This deployment takes documents up to ${mb(limit)}.`); return; }
      setBusy("uploading");
      const made = await envelopesApi.create(new Blob([combined.bytes.slice()], { type: "application/pdf" }), {
        clientId: clientId.current, title: title.trim(), visibility, sources: combined.sources, asTemplate,
      });
      if (!made.ok || !made.envelope) { setBusy(""); setError(made.message || "This document couldn't be added. Try again."); return; }
      navigate(`/documents/${made.envelope.id}/prepare`, { replace: true });
    } catch (e) {
      setBusy("");
      setError(e instanceof Error ? e.message : "This document couldn't be added. Try again.");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-8">
      {asTemplate
        ? <PageHeader title="New template" description="Add the PDF you send again and again. Next, you'll name the roles who sign it, like Client or Manager." back={{ href: "/templates", label: "Templates" }} />
        : <PageHeader title="New document" description="Add the PDF people will sign. Next, you'll choose who signs and where." back={{ href: "/", label: "Documents" }} />}

      {storage.error ? <LoadError title="We couldn't check this deployment's limits" error={storage.error} onRetry={storage.reload} /> : null}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void add(e.dataTransfer.files); }}
        className={cn("flex flex-col items-center gap-3 rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center transition-colors", dragging ? "border-primary bg-[var(--selected)]" : "border-input")}
      >
        <span className="grid size-11 place-items-center rounded-full bg-paper text-primary-text"><Upload aria-hidden className="size-5" /></span>
        <div>
          <p className="font-medium">Drop PDFs here, or choose them</p>
          <p className="mt-1 text-caption text-muted-foreground">
            {limit ? `Up to ${mb(limit)} in total. ` : ""}Several files become one document, in the order you set.
          </p>
        </div>
        <Button variant="outline" onClick={() => input.current?.click()}>Choose PDFs</Button>
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple className="sr-only" aria-label="Choose PDFs"
          onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ""; }} />
      </div>

      {picked.length > 0 && (
        <ol className="divide-y rounded-lg border bg-card" aria-label="Files, in order">
          {picked.map((p, i) => {
            const bad = p.check && !p.check.ok;
            return (
              <li key={p.key} className="flex items-center gap-3 px-4 py-3">
                <span className="w-5 text-right text-caption tabular-nums text-muted-foreground">{i + 1}</span>
                {bad && p.check && !p.check.ok && p.check.code === "encrypted" ? <Lock aria-hidden className="size-4 text-destructive" /> : <FileText aria-hidden className={cn("size-4", bad ? "text-destructive" : "text-muted-foreground")} />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{p.file.name}</p>
                  <p className={cn("text-caption", bad ? "text-destructive" : "text-muted-foreground")}>
                    {!p.check ? "Reading…" : p.check.ok ? `${p.check.pages.length} ${p.check.pages.length === 1 ? "page" : "pages"} · ${mb(p.file.size)}` : p.check.message}
                  </p>
                </div>
                {picked.length > 1 && (
                  <div className="flex">
                    <Button size="icon" variant="ghost" aria-label={`Move ${p.file.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp aria-hidden /></Button>
                    <Button size="icon" variant="ghost" aria-label={`Move ${p.file.name} down`} disabled={i === picked.length - 1} onClick={() => move(i, 1)}><ArrowDown aria-hidden /></Button>
                  </div>
                )}
                <Button size="icon" variant="ghost" aria-label={`Remove ${p.file.name}`} onClick={() => remove(p.key)}><X aria-hidden /></Button>
              </li>
            );
          })}
        </ol>
      )}

      {picked.length > 0 && (
        <div className="grid gap-5 rounded-lg border bg-card p-4 sm:p-5">
          <div className="grid gap-2">
            <Label htmlFor="doc-title">Title</Label>
            <Input id="doc-title" value={title} maxLength={200} onChange={(e) => { setTitleTouched(true); setTitle(e.target.value); }} placeholder="Residential lease — 14 Alder St" />
            <p className="text-caption text-muted-foreground">{asTemplate ? "Each document made from it starts with this title, and you can change it each time." : "Signers see this in their email and at the top of the page."}</p>
          </div>
          <div className="grid gap-2">
            <span id="vis-label" className="text-sm font-medium">Who on your team can see it</span>
            <Segmented label="Who on your team can see it" value={visibility} onChange={setVisibility} options={[
              { value: "team", label: "The team" },
              { value: "private", label: "Only me and admins" },
            ]} />
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><Users aria-hidden className="size-3.5" />
              {visibility === "team" ? "Anyone on the team who reads documents can follow it." : "Admins can still see it, for the record."}</p>
          </div>
        </div>
      )}

      {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <p aria-live="polite" className="mr-auto text-caption text-muted-foreground">
          {busy === "combining" ? "Putting the files together…" : busy === "uploading" ? "Uploading…" : blocker || (picked.length ? `${pages} ${pages === 1 ? "page" : "pages"} ready` : "")}
        </p>
        <Button onClick={submit} disabled={!ready}>
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {asTemplate ? "Continue to roles" : "Continue to recipients"}
        </Button>
      </div>
    </div>
  );
}
