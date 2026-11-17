// Reading a PDF in the app: every page at a comfortable width, which page you're on, zoom, and download. The page sizes come
// from the file itself, so a signed copy's certificate pages show at their own size. Used for a document's signed copy or its
// original, inside the app and on a party's download page.
import { useEffect, useState } from "react";
import { Download, Loader2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/kit/cn";
import { openPdf, pagesOf } from "@/lib/pdf/inspect";
import { DocumentView, type PageMeta } from "./document-view";

/** Zoom steps, as a share of the width that fits; 1 fits the page to the window. */
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const FIT = 2;

export function PdfReader({ file, name, label, onDownload, className }: {
  file: Blob; name: string; label: string; onDownload?: () => void; className?: string;
}) {
  const [pages, setPages] = useState<PageMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(FIT);

  useEffect(() => {
    let live = true;
    setPages(null); setError(null); setPage(1);
    file.arrayBuffer()
      .then((b) => openPdf(name, new Uint8Array(b)))
      .then((doc) => { if (live) setPages(pagesOf(name, doc).map((p) => ({ w: p.w, h: p.h, rotation: p.rotation }))); })
      .catch(() => { if (live) setError("This file couldn't be read."); });
    return () => { live = false; };
  }, [file, name]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur sm:px-4">
        <p className="text-caption text-muted-foreground tabular-nums" aria-live="polite">{pages ? `Page ${page} of ${pages.length}` : "Loading…"}</p>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-8" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}><Minus aria-hidden /></Button>
          <button type="button" className="focus-ring w-12 rounded text-center text-caption tabular-nums text-muted-foreground hover:text-foreground" onClick={() => setZoom(FIT)} aria-label="Fit to the window" title="Fit to the window">{zoom === FIT ? "Fit" : `${Math.round(ZOOMS[zoom] * 100)}%`}</button>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}><Plus aria-hidden /></Button>
          {onDownload ? <Button size="sm" variant="outline" className="ml-2" onClick={onDownload}><Download aria-hidden />Download</Button> : null}
        </div>
      </div>
      <div data-reader-scroll className="min-h-0 flex-1 overflow-auto bg-paper px-3 py-6 sm:px-6">
        {error ? <p role="alert" className="mx-auto max-w-md rounded-lg border bg-card p-4 text-sm">{error}</p>
          : !pages ? <div className="grid min-h-[40vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading the document" className="animate-spin" /></div>
          : <DocumentView file={file} pageCount={pages.length} pages={pages} zoom={ZOOMS[zoom]} label={label} onPageInView={setPage} />}
      </div>
    </div>
  );
}
