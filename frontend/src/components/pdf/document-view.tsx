// The one way a PDF is drawn in Countersign: every page at the container's width, in order, with a layer on top of each
// page for fields. Pages are drawn only near the viewport, and each keeps its real shape (from the page sizes the server read)
// before it loads, so a long document scrolls smoothly and nothing jumps. Field positions are fractions of the page as
// displayed, so the overlay is the same at any width.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Document, Page, pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/** A page as the server read it: size in points and its /Rotate. */
export type PageMeta = { w: number; h: number; rotation?: number };
/** A page's displayed size in CSS pixels. */
export type PageSize = { width: number; height: number };

/** The page's aspect ratio as displayed: a page turned 90° or 270° shows its height across. */
export const displayedRatio = (p?: PageMeta) => {
  if (!p || !p.w || !p.h) return 11 / 8.5;
  const turned = Math.abs(((p.rotation ?? 0) % 360) + 360) % 180 === 90;
  return turned ? p.w / p.h : p.h / p.w;
};

type Props = {
  /** The PDF: bytes, a Blob, or a URL the browser may fetch. */
  file: Uint8Array | Blob | string;
  pageCount: number;
  pages?: PageMeta[];
  /** Widest a page is drawn, in CSS pixels. */
  maxWidth?: number;
  /** Space between pages. */
  gap?: number;
  /** Drawn over each page, sized to it. `page` is 1-based. */
  renderOverlay?: (page: number, size: PageSize) => ReactNode;
  /** Called when a page becomes the one most in view. */
  onPageInView?: (page: number) => void;
  /** Called once the document has loaded, or failed to. */
  onLoad?: (ok: boolean, error?: string) => void;
  className?: string;
  /** For a screen reader: what this document is. */
  label: string;
  /** Scale on top of fitting the width: above 1 the pages grow past the container, which then scrolls sideways. */
  zoom?: number;
};

export function DocumentView({ file, pageCount, pages, maxWidth = 860, gap = 20, renderOverlay, onPageInView, onLoad, className, label, zoom = 1 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState<Set<number>>(() => new Set([1, 2]));
  const [failed, setFailed] = useState<string | null>(null);

  // The page width follows the container, up to maxWidth.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(maxWidth, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);

  // Pages draw when they come within a screen of the viewport; the one most in view is reported.
  const observed = useRef(new Map<number, HTMLElement>());
  const seen = useRef(new Map<number, number>());
  const io = useMemo(() => {
    if (typeof IntersectionObserver === "undefined") return null;
    return new IntersectionObserver((entries) => {
      setNear((prev) => {
        const next = new Set(prev);
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) next.add(n);
          seen.current.set(n, e.intersectionRatio);
        }
        return next;
      });
      if (onPageInView) {
        let best = 0, bestRatio = 0;
        for (const [n, r] of seen.current) if (r > bestRatio) { best = n; bestRatio = r; }
        if (best) onPageInView(best);
      }
    }, { rootMargin: "100% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] });
  }, [onPageInView]);
  useEffect(() => () => io?.disconnect(), [io]);
  const track = useCallback((n: number) => (el: HTMLElement | null) => {
    const map = observed.current;
    const old = map.get(n);
    if (old && io) io.unobserve(old);
    if (el) { map.set(n, el); io?.observe(el); } else map.delete(n);
  }, [io]);

  // react-pdf takes bytes it may transfer to its worker, so it gets its own copy.
  const source = useMemo(() => (file instanceof Uint8Array ? { data: file.slice() } : file), [file]);

  return (
    <div ref={box} className={className} aria-label={label} role="document">
      {failed ? (
        <div role="alert" className="mx-auto max-w-md rounded-lg border bg-card p-6 text-center text-sm">
          <p className="font-medium">This document couldn't be shown.</p>
          <p className="mt-1 text-muted-foreground">{failed}</p>
        </div>
      ) : (
        <Document
          file={source}
          loading={null}
          error={null}
          onLoadSuccess={() => onLoad?.(true)}
          onLoadError={(e) => { const m = "Check your connection, then reload the page."; setFailed(m); onLoad?.(false, e?.message ?? m); }}
        >
          <div className="flex w-max min-w-full flex-col items-center" style={{ gap }}>
            {Array.from({ length: pageCount }, (_, i) => {
              const n = i + 1;
              const ratio = displayedRatio(pages?.[i]);
              const w = Math.round((width || maxWidth) * zoom);
              const h = Math.round(w * ratio);
              return (
                <div
                  key={n}
                  ref={track(n)}
                  data-page={n}
                  className="relative bg-[var(--sheet)] shadow-[0_1px_2px_rgba(28,34,48,.06),0_8px_24px_rgba(28,34,48,.08)]"
                  style={{ width: w, height: h }}
                  aria-label={`Page ${n} of ${pageCount}`}
                >
                  {width > 0 && near.has(n) ? (
                    <Page pageNumber={n} width={w} renderTextLayer={false} renderAnnotationLayer={false} loading={<PagePlaceholder />} />
                  ) : (
                    <PagePlaceholder />
                  )}
                  {renderOverlay && width > 0 ? <div className="on-sheet absolute inset-0">{renderOverlay(n, { width: w, height: h })}</div> : null}
                </div>
              );
            })}
          </div>
        </Document>
      )}
    </div>
  );
}

function PagePlaceholder() {
  return <div className="absolute inset-0 animate-pulse bg-[var(--sheet)]" aria-hidden />;
}
