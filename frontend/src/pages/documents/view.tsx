// Reading a document in the app: the signed copy once it's complete (with its certificate pages), the original before that, and
// a switch between the two on a completed document. `?copy=original` opens the original.
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LoadError, Segmented, StatusBadge, useLoad } from "@/components/kit";
import { PdfReader } from "@/components/pdf/pdf-reader";
import { envelopesApi, fetchDocument, saveBlob, STATUS_LABEL, STATUS_TONE } from "@/lib/envelopes";
import { routePath } from "../../../../xano/routes.gen";

type Copy = "signed" | "original";

export function DocumentViewPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const detail = useLoad(() => envelopesApi.detail(id), [id]);
  const done = detail.data?.envelope.status === "completed";
  const copy: Copy = done && params.get("copy") !== "original" ? "signed" : "original";
  const file = useLoad(async () => {
    if (!detail.data) return null;
    const got = copy === "signed"
      ? await fetchDocument(routePath("GET envelopes/{id}/final", { id }), routePath("GET envelopes/{id}/final/raw", { id }))
      : await fetchDocument(routePath("GET envelopes/{id}/original", { id }), routePath("GET envelopes/{id}/original/raw", { id }));
    if ("error" in got) throw new Error(got.error);
    return got;
  }, [id, copy, !!detail.data]);
  const [saving, setSaving] = useState(false);

  if (detail.error) return <div className="mx-auto max-w-3xl p-8"><LoadError title="This document didn't open" error={detail.error} onRetry={detail.reload} /></div>;
  if (!detail.data) return <div className="grid min-h-[60vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading" className="animate-spin" /></div>;
  const e = detail.data.envelope;
  const setCopy = (c: Copy) => setParams((p) => { if (c === "original") p.set("copy", "original"); else p.delete("copy"); return p; }, { replace: true });
  const download = () => {
    if (!file.data) return;
    setSaving(true);
    try { saveBlob(file.data.blob, file.data.name); } catch { toast.error("The download didn't start. Try again."); } finally { setSaving(false); }
  };

  return (
    <div className="flex h-[calc(100dvh-var(--header-h,3.5rem))] min-h-[28rem] flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-3 py-2 sm:px-4">
        <Button variant="ghost" size="sm" asChild><Link to={`/documents/${e.id}`}><ArrowLeft aria-hidden />Back</Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{e.title}</h1>
          <p className="flex items-center gap-2 text-caption text-muted-foreground">
            <StatusBadge tone={STATUS_TONE[e.status]} dot>{STATUS_LABEL[e.status]}</StatusBadge>
            <span className="truncate">{copy === "signed" ? "Signed copy, with its certificate" : done ? "The original, as it was sent" : "The document as it was sent; the signed copy is made when everyone has signed"}</span>
          </p>
        </div>
        {done ? (
          <div className="order-last w-full sm:order-none sm:w-auto">
            <Segmented label="Which copy" value={copy} onChange={setCopy} className="w-full sm:w-auto [&>button]:flex-1" options={[{ value: "signed", label: "Signed copy" }, { value: "original", label: "Original" }]} />
          </div>
        ) : null}
      </div>
      {file.error ? <div className="p-6"><LoadError title="The file didn't load" error={file.error} onRetry={file.reload} /></div>
        : !file.data ? <div className="grid flex-1 place-items-center text-muted-foreground"><Loader2 aria-label="Loading the document" className="animate-spin" /></div>
        : <PdfReader className="flex-1" file={file.data.blob} name={file.data.name} label={`${e.title}, ${copy === "signed" ? "signed copy" : "original"}`} onDownload={saving ? undefined : download} />}
    </div>
  );
}
