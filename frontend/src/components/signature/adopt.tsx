// Adopting a signature (or initials): type it in one of three handwriting styles, draw it, or upload an image. Each becomes a
// trimmed PNG drawn in the browser, which is what the signed PDF shows. Adopted once, it's reused for every field of its kind.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Loader2, Upload } from "lucide-react";
import "@fontsource/mrs-saint-delafield";
import "@fontsource/homemade-apple";
import "@fontsource-variable/caveat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/kit";
import { cn } from "@/components/kit/cn";

export type Adopted = { method: "typed" | "drawn" | "uploaded"; pngB64: string; style?: number };

export const STYLES = [
  { family: "'Mrs Saint Delafield'", size: 64, label: "Flowing" },
  { family: "'Homemade Apple'", size: 34, label: "Handwritten" },
  { family: "'Caveat Variable'", size: 52, label: "Neat" },
] as const;
/** Signatures are drawn in ink blue, whatever the theme: they print on paper. */
const INK = "rgb(29 42 92)";
const MOST_BYTES = 200 * 1024;

/** The initials of a name: "Maya Chen" → "MC". */
export const initialsOf = (name: string) => name.trim().split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 3).toUpperCase();

/** Draws `text` in a style onto a canvas sized to fit it, at twice the size for a sharp print, and answers base64 PNG. */
export async function typedPng(text: string, style: number): Promise<string> {
  const s = STYLES[style] ?? STYLES[0];
  await document.fonts.load(`${s.size}px ${s.family}`).catch(() => undefined);
  const scale = 2;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = `${s.size}px ${s.family}`;
  const width = Math.ceil(probe.measureText(text).width + s.size * 0.6);
  const height = Math.ceil(s.size * 1.6);
  const c = document.createElement("canvas");
  c.width = width * scale; c.height = height * scale;
  const g = c.getContext("2d")!;
  g.scale(scale, scale);
  g.font = `${s.size}px ${s.family}`;
  g.fillStyle = INK;
  g.textBaseline = "middle";
  g.fillText(text, s.size * 0.3, height / 2);
  return trimmed(c);
}

/** A canvas cropped to what's drawn on it, with a little room around, as base64 PNG. */
function trimmed(c: HTMLCanvasElement): string {
  const g = c.getContext("2d")!;
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  let top = height, left = width, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 8) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
  }
  if (right < 0) return "";
  const pad = 8;
  const out = document.createElement("canvas");
  out.width = Math.min(width, right - left + pad * 2); out.height = Math.min(height, bottom - top + pad * 2);
  out.getContext("2d")!.drawImage(c, Math.max(0, left - pad), Math.max(0, top - pad), out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png").split(",")[1];
}

type Props = {
  open: boolean; kind: "signature" | "initials"; name: string; onClose: () => void;
  onAdopt: (a: Adopted) => Promise<void>; dark?: boolean;
};

export function AdoptDialog({ open, kind, name, onClose, onAdopt }: Props) {
  const [tab, setTab] = useState<"type" | "draw" | "upload">("type");
  const [text, setText] = useState(kind === "initials" ? initialsOf(name) : name);
  const [style, setStyle] = useState(0);
  const [drawn, setDrawn] = useState(false);
  const [upload, setUpload] = useState<{ b64: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pad = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (open) { setText(kind === "initials" ? initialsOf(name) : name); setError(null); } }, [open, kind, name]);

  const adopt = async () => {
    setError(null);
    setBusy(true);
    try {
      if (tab === "type") {
        if (!text.trim()) { setError("Type your name to use it as your signature."); return; }
        await onAdopt({ method: "typed", pngB64: await typedPng(text.trim(), style), style });
      } else if (tab === "draw") {
        const b64 = pad.current ? trimmed(pad.current) : "";
        if (!b64) { setError("Draw your signature in the box first."); return; }
        await onAdopt({ method: "drawn", pngB64: b64 });
      } else {
        if (!upload) { setError("Choose an image first."); return; }
        await onAdopt({ method: "uploaded", pngB64: upload.b64 });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File) => {
    setError(null);
    if (!/^image\/(png|jpeg)$/.test(file.type)) { setError("Use a PNG or JPEG image."); return; }
    if (file.size > MOST_BYTES) { setError("That image is too large. Use one under 200 KB."); return; }
    const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
    setUpload({ b64: url.split(",")[1], preview: url });
  };

  const what = kind === "initials" ? "initials" : "signature";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-sm:top-auto max-sm:bottom-0 max-sm:translate-y-0 max-sm:rounded-b-none">
        <DialogHeader>
          <DialogTitle>Adopt your {what}</DialogTitle>
          <DialogDescription>It's used for every {what} on this document.</DialogDescription>
        </DialogHeader>
        <Segmented label={`How to make your ${what}`} value={tab} onChange={setTab} className="w-full [&>button]:flex-1" options={[
          { value: "type", label: "Type" }, { value: "draw", label: "Draw" }, { value: "upload", label: "Upload" },
        ]} />
        {tab === "type" ? (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="adopt-text">{kind === "initials" ? "Your initials" : "Your name"}</Label>
              <Input id="adopt-text" value={text} maxLength={kind === "initials" ? 4 : 80} onChange={(e) => setText(e.target.value)} autoComplete="name" />
            </div>
            <div role="radiogroup" aria-label="Style" className="grid gap-2">
              {STYLES.map((s, i) => (
                <button key={s.label} type="button" role="radio" aria-checked={style === i} aria-label={`${s.label} style`} onClick={() => setStyle(i)}
                  className={cn("focus-ring flex min-h-14 items-center justify-between rounded-lg border bg-card px-4 text-left", style === i ? "border-primary ring-2 ring-[var(--selected)]" : "hover:border-input")}>
                  <span className="truncate text-[var(--signature-ink)]" style={{ fontFamily: s.family, fontSize: Math.min(36, s.size * 0.55) }}>{text || name || "Your name"}</span>
                  <span aria-hidden className={cn("size-4 shrink-0 rounded-full border", style === i ? "border-[5px] border-primary" : "border-input")} />
                </button>
              ))}
            </div>
          </div>
        ) : tab === "draw" ? (
          <DrawPad canvas={pad} onChange={setDrawn} drawn={drawn} />
        ) : (
          <div className="grid gap-2">
            <label className="focus-within:ring-ring flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-card p-4 text-center text-sm text-muted-foreground focus-within:ring-2">
              {upload ? <img src={upload.preview} alt="Your uploaded signature" className="max-h-24 object-contain" /> : <><Upload aria-hidden className="size-5 text-primary-text" />Choose a PNG or JPEG under 200 KB</>}
              <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ""; }} />
            </label>
            <p className="text-caption text-muted-foreground">A photo of your signature on white paper works best.</p>
          </div>
        )}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={adopt} disabled={busy}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Adopt and sign</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A drawing pad: pointer, touch or pen, smoothed into curves. */
function DrawPad({ canvas, onChange, drawn }: { canvas: React.RefObject<HTMLCanvasElement | null>; onChange: (v: boolean) => void; drawn: boolean }) {
  const last = useRef<{ x: number; y: number; mx: number; my: number } | null>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = 2;
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * ratio); c.height = Math.round(rect.height * ratio);
    const g = c.getContext("2d")!;
    g.scale(ratio, ratio); g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = 2.4; g.strokeStyle = INK;
  }, [canvas]);
  const point = (e: RPointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: RPointerEvent<HTMLCanvasElement>) => { e.currentTarget.setPointerCapture(e.pointerId); const p = point(e); last.current = { ...p, mx: p.x, my: p.y }; };
  const move = (e: RPointerEvent<HTMLCanvasElement>) => {
    const l = last.current; if (!l) return;
    const p = point(e); const g = e.currentTarget.getContext("2d")!;
    const mx = (l.x + p.x) / 2, my = (l.y + p.y) / 2;
    g.beginPath(); g.moveTo(l.mx, l.my); g.quadraticCurveTo(l.x, l.y, mx, my); g.stroke();
    last.current = { ...p, mx, my };
    if (!drawn) onChange(true);
  };
  const up = () => { last.current = null; };
  const clear = () => { const c = canvas.current; if (!c) return; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); onChange(false); };
  return (
    <div className="grid gap-2">
      <div className="on-sheet relative h-40 rounded-lg border-2 border-dashed border-input bg-white sm:h-44">
        <canvas ref={canvas} aria-label="Draw your signature here with your finger, pen or mouse" role="img"
          className="absolute inset-0 size-full touch-none" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        <div aria-hidden className="pointer-events-none absolute inset-x-6 bottom-10 border-b border-input" />
        {!drawn ? <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">Sign here</span> : null}
        <button type="button" onClick={clear} className="focus-ring absolute right-2 top-2 rounded-md px-2 py-1 text-caption text-muted-foreground hover:bg-muted">Clear</button>
      </div>
      <p className="text-caption text-muted-foreground">Use your finger, a pen or the mouse.</p>
    </div>
  );
}
