// Placing fields: a palette of field types for the person you're placing for, the document with every field in its owner's
// colour, and the selected field's properties. A field goes down by dragging it onto a page, or by picking it and then tapping
// (or pressing Enter on) the page. Fields move by dragging or with the arrow keys, resize from the corner, and duplicate or delete
// from the properties panel or with ⌘D and Delete.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { Calendar, CheckSquare, ChevronDown, CircleDot, Copy, Hash, Mail, PenLine, Trash2, Type, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/components/kit/cn";
import { DocumentView, displayedRatio, type PageSize } from "@/components/pdf/document-view";
import { FIELD_LABEL, recipientColor, type FieldType, type PageMeta } from "@/lib/envelopes";
import { clampBox, duplicateBox, fractionOf, nudge, placeAt, resize } from "@/lib/prepare/geometry";
import { CAN_HAVE_FIELDS, PALETTE, newKey, whoIs, type DraftField, type DraftPerson } from "./model";

const ICON: Record<FieldType, typeof PenLine> = {
  signature: PenLine, initials: PenLine, date: Calendar, name: User, email: Mail, text: Type, number: Hash, checkbox: CheckSquare, radio: CircleDot, dropdown: ChevronDown,
};
const DRAG_TYPE = "application/x-countersign-field";

type Props = {
  file: Blob; pageCount: number; pages: PageMeta[];
  people: DraftPerson[]; fields: DraftField[]; setFields: (fn: (f: DraftField[]) => DraftField[]) => void;
  editable: boolean; narrow: boolean;
};

/** Whether the window is wide enough for a third column beside the document. */
function useRoomy() {
  const query = "(min-width: 1536px)";
  const [roomy, setRoomy] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setRoomy(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return roomy;
}

export function FieldsStep({ file, pageCount, pages, people, fields, setFields, editable, narrow }: Props) {
  const roomy = useRoomy();
  const placeable = people.filter((p) => CAN_HAVE_FIELDS(p.role));
  const [forKey, setForKey] = useState(placeable[0]?.key ?? "");
  const [armed, setArmed] = useState<FieldType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  useEffect(() => { if (!placeable.some((p) => p.key === forKey)) setForKey(placeable[0]?.key ?? ""); }, [placeable, forKey]);

  const color = (personKey: string) => recipientColor(people.findIndex((p) => p.key === personKey) + 1);
  const nameOf = (personKey: string) => (() => { const p = people.find((x) => x.key === personKey); return p ? whoIs(p) : "Someone"; })();
  const sel = fields.find((f) => f.key === selected) ?? null;

  const add = useCallback((type: FieldType, page: number, at: { x: number; y: number }) => {
    if (!forKey) return;
    const box = placeAt(type, at, displayedRatio(pages[page - 1]));
    const f: DraftField = {
      key: newKey("f"), person: forKey, type, page, ...box, required: type !== "checkbox", label: "",
      options: type === "radio" || type === "dropdown" ? ["Option 1", "Option 2"] : [], validation: {},
    };
    setFields((all) => [...all, f]);
    setSelected(f.key);
    setArmed(null);
    setAnnounce(`${FIELD_LABEL[type]} for ${nameOf(forKey)} added on page ${page}.`);
  }, [forKey, pages, setFields]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (key: string, patch: Partial<DraftField>) => setFields((all) => all.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const remove = (key: string) => { setFields((all) => all.filter((f) => f.key !== key)); setSelected(null); setAnnounce("Field removed."); };
  const duplicate = (key: string) => {
    const f = fields.find((x) => x.key === key);
    if (!f) return;
    const copy = { ...f, key: newKey("f"), ...duplicateBox(f) };
    setFields((all) => [...all, copy]);
    setSelected(copy.key);
  };

  const onFieldKey = (e: KeyboardEvent, f: DraftField) => {
    if (!editable) return;
    const moved = nudge(f, e.key, e.shiftKey);
    if (moved) { e.preventDefault(); update(f.key, moved); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(f.key); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(f.key); }
  };

  const palette = (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">Placing fields for</h3>
        {placeable.length === 0 ? (
          <p className="text-caption text-muted-foreground">Add someone who signs, approves or views first. People who only get a copy don't have fields.</p>
        ) : (
          <div role="radiogroup" aria-label="Placing fields for" className="flex flex-col gap-1">
            {placeable.map((p) => {
              const count = fields.filter((f) => f.person === p.key).length;
              return (
                <button key={p.key} type="button" role="radio" aria-checked={forKey === p.key} onClick={() => setForKey(p.key)}
                  className={cn("focus-ring flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm", forKey === p.key ? "border-border bg-card" : "border-transparent hover:bg-card/60")}>
                  <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color(p.key) }} />
                  <span className="min-w-0 flex-1 truncate">{whoIs(p)}</span>
                  <span className="text-caption text-muted-foreground">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">Fields</h3>
        <div className="grid grid-cols-2 gap-1.5">
          {PALETTE.map((t) => {
            const Icon = ICON[t];
            return (
              <button key={t} type="button" disabled={!editable || !forKey} draggable={editable && !!forKey}
                onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, t); e.dataTransfer.effectAllowed = "copy"; }}
                onClick={() => { setArmed((a) => (a === t ? null : t)); setSheetOpen(false); setAnnounce(`Tap the page where the ${FIELD_LABEL[t].toLowerCase()} goes.`); }}
                aria-pressed={armed === t}
                className={cn("focus-ring flex min-h-11 items-center gap-2 rounded-md border border-dashed bg-card px-2.5 py-2 text-left text-sm disabled:opacity-50",
                  armed === t ? "border-solid border-primary bg-[var(--selected)]" : "border-input hover:border-solid")}>
                <Icon aria-hidden className="size-3.5 shrink-0" style={{ color: forKey ? color(forKey) : undefined }} />
                {FIELD_LABEL[t]}
              </button>
            );
          })}
        </div>
        <p className="mt-3 rounded-md border bg-card px-2.5 py-2 text-caption text-muted-foreground">
          {narrow ? "Pick a field, then tap the page where it goes." : "Drag a field onto the page, or pick one and click where it goes. Arrow keys move the selected field."}
        </p>
      </div>
    </div>
  );

  const overlay = (page: number, size: PageSize) => (
    <PageLayer page={page} size={size} armed={armed} editable={editable} onPlace={add}
      onBackground={() => setSelected(null)}>
      {fields.filter((f) => f.page === page).map((f) => (
        <PlacedField key={f.key} f={f} size={size} color={color(f.person)} owner={nameOf(f.person)} selected={selected === f.key} editable={editable}
          onSelect={() => setSelected(f.key)} onChange={(b) => update(f.key, b)} onKeyDown={(e) => onFieldKey(e, f)} />
      ))}
    </PageLayer>
  );

  return (
    <div className="flex min-h-0 flex-1">
      {!narrow && (
        <aside className="w-60 shrink-0 overflow-y-auto border-r bg-paper p-4">
          {sel && !roomy ? <div className="mb-5 border-b pb-5"><Properties f={sel} people={placeable} editable={editable} onChange={(p) => update(sel.key, p)} onDuplicate={() => duplicate(sel.key)} onRemove={() => remove(sel.key)} /></div> : null}
          {palette}
        </aside>
      )}
      <div className="relative min-w-0 flex-1 overflow-y-auto bg-paper px-3 py-6 sm:px-6">
        <p className="sr-only" aria-live="polite">{announce}</p>
        {armed ? (
          <div className="sticky top-2 z-20 mx-auto mb-3 flex w-fit items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm">
            Tap the page to place a {FIELD_LABEL[armed].toLowerCase()} for {nameOf(forKey)}
            <Button size="sm" variant="ghost" onClick={() => setArmed(null)}>Cancel</Button>
          </div>
        ) : null}
        <DocumentView file={file} pageCount={pageCount} pages={pages} label="Document to prepare" renderOverlay={overlay} />
      </div>
      {!narrow && roomy && (
        <aside className="w-72 shrink-0 overflow-y-auto border-l bg-background p-4">
          {sel ? <Properties f={sel} people={placeable} editable={editable} onChange={(p) => update(sel.key, p)} onDuplicate={() => duplicate(sel.key)} onRemove={() => remove(sel.key)} />
            : <p className="text-sm text-muted-foreground">Select a field to set who fills it in, whether it's required, and its label or choices.</p>}
        </aside>
      )}
      {narrow && (
        <div className="fixed inset-x-0 bottom-16 z-30 border-t bg-background/95 p-3 backdrop-blur" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          {sel && !sheetOpen ? (
            <Properties compact f={sel} people={placeable} editable={editable} onChange={(p) => update(sel.key, p)} onDuplicate={() => duplicate(sel.key)} onRemove={() => remove(sel.key)} onDone={() => setSelected(null)} />
          ) : sheetOpen ? (
            <div className="max-h-[55vh] overflow-y-auto">{palette}<Button className="mt-3 w-full" variant="outline" onClick={() => setSheetOpen(false)}>Close</Button></div>
          ) : (
            <Button className="w-full" onClick={() => setSheetOpen(true)} disabled={!editable}>Add a field{forKey ? ` for ${nameOf(forKey)}` : ""}</Button>
          )}
        </div>
      )}
    </div>
  );
}

/** One page's layer: takes drops and taps that place a field, and clears the selection on an empty spot. */
function PageLayer({ page, size, armed, editable, onPlace, onBackground, children }: {
  page: number; size: PageSize; armed: FieldType | null; editable: boolean;
  onPlace: (t: FieldType, page: number, at: { x: number; y: number }) => void; onBackground: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const at = (clientX: number, clientY: number) => fractionOf(ref.current!.getBoundingClientRect(), clientX, clientY);
  return (
    <div ref={ref} className={cn("absolute inset-0", armed && "cursor-crosshair")}
      role={armed ? "button" : undefined} tabIndex={armed ? 0 : -1}
      aria-label={armed ? `Place the ${FIELD_LABEL[armed].toLowerCase()} on page ${page}` : undefined}
      onDragOver={(e) => { if (editable && e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDrop={(e) => { const t = e.dataTransfer.getData(DRAG_TYPE) as FieldType; if (!t || !editable) return; e.preventDefault(); onPlace(t, page, at(e.clientX, e.clientY)); }}
      onClick={(e) => { if (e.target !== e.currentTarget) return; if (armed && editable) onPlace(armed, page, at(e.clientX, e.clientY)); else onBackground(); }}
      onKeyDown={(e) => { if (armed && editable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPlace(armed, page, { x: 0.5, y: 0.5 }); } }}
      style={{ width: size.width, height: size.height }}
    >
      {children}
    </div>
  );
}

function PlacedField({ f, size, color, owner, selected, editable, onSelect, onChange, onKeyDown }: {
  f: DraftField; size: PageSize; color: string; owner: string; selected: boolean; editable: boolean;
  onSelect: () => void; onChange: (b: { x: number; y: number; w: number; h: number }) => void; onKeyDown: (e: KeyboardEvent) => void;
}) {
  const start = useRef<{ px: number; py: number; box: typeof f; mode: "move" | "resize" } | null>(null);
  const [live, setLive] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const box = live ?? f;
  const begin = (e: RPointerEvent, mode: "move" | "resize") => {
    if (!editable) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, box: f, mode };
    onSelect();
  };
  const moveTo = (e: RPointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = (e.clientX - s.px) / size.width, dy = (e.clientY - s.py) / size.height;
    setLive(s.mode === "move" ? clampBox({ ...s.box, x: s.box.x + dx, y: s.box.y + dy }) : resize(s.box, dx, dy));
  };
  const end = () => { if (start.current && live) onChange(live); start.current = null; setLive(null); };
  const Icon = ICON[f.type];
  const style: CSSProperties = {
    left: box.x * size.width, top: box.y * size.height, width: box.w * size.width, height: box.h * size.height,
    borderColor: color, color, background: `color-mix(in oklch, ${color} 10%, transparent)`,
    boxShadow: selected ? `0 0 0 3px color-mix(in oklch, ${color} 28%, transparent)` : undefined,
  };
  return (
    <div role="button" tabIndex={0} aria-pressed={selected}
      aria-label={`${FIELD_LABEL[f.type]} for ${owner}, page ${f.page}${f.required ? ", required" : ""}${f.label ? `, “${f.label}”` : ""}`}
      className={cn("focus-ring absolute flex touch-none select-none items-center gap-1 overflow-hidden rounded-[4px] border-[1.5px] px-1.5 text-[0.6875rem] font-medium leading-tight", editable && "cursor-move")}
      style={style}
      onPointerDown={(e) => begin(e, "move")} onPointerMove={moveTo} onPointerUp={end} onPointerCancel={end}
      onClick={(e) => { e.stopPropagation(); onSelect(); }} onKeyDown={onKeyDown} onFocus={onSelect}
    >
      {f.type === "checkbox" ? <span aria-hidden className="mx-auto size-[70%] rounded-[2px] border-[1.5px]" style={{ borderColor: color }} /> : (
        <><Icon aria-hidden className="size-3 shrink-0" /><span className="truncate">{f.label || FIELD_LABEL[f.type]}{f.type === "signature" || f.type === "initials" ? ` · ${owner.split(" ")[0]}` : ""}</span></>
      )}
      {selected && editable ? (
        <span aria-hidden onPointerDown={(e) => begin(e, "resize")} onPointerMove={moveTo} onPointerUp={end} onPointerCancel={end}
          className="absolute -bottom-2 -right-2 grid size-6 cursor-nwse-resize place-items-center pointer-coarse:size-11">
          <span className="size-2.5 rounded-[2px] border-[1.5px] bg-white" style={{ borderColor: color }} />
        </span>
      ) : null}
    </div>
  );
}

function Properties({ f, people, editable, onChange, onDuplicate, onRemove, onDone, compact }: {
  f: DraftField; people: DraftPerson[]; editable: boolean; onChange: (p: Partial<DraftField>) => void;
  onDuplicate: () => void; onRemove: () => void; onDone?: () => void; compact?: boolean;
}) {
  const choices = f.type === "radio" || f.type === "dropdown";
  const auto = f.type === "name" || f.type === "email" || f.type === "date";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{FIELD_LABEL[f.type]} field</h3>
        {onDone ? <Button size="sm" variant="ghost" onClick={onDone}>Done</Button> : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="prop-owner">Filled in by</Label>
        <select id="prop-owner" disabled={!editable} value={f.person} onChange={(e) => onChange({ person: e.target.value })}
          className="focus-ring h-9 rounded-md border border-input bg-card px-2 text-sm">
          {people.map((p) => <option key={p.key} value={p.key}>{whoIs(p)}</option>)}
        </select>
      </div>
      {!compact && !auto && (
        <label className="flex items-center justify-between gap-3 text-sm">
          Required
          <Checkbox checked={f.required} disabled={!editable} onCheckedChange={(v) => onChange({ required: v === true })} aria-label="Required" />
        </label>
      )}
      {auto ? <p className="text-caption text-muted-foreground">Fills itself in when they finish signing.</p> : null}
      {!compact && (f.type === "text" || f.type === "number" || choices || f.type === "checkbox") && (
        <div className="grid gap-1.5">
          <Label htmlFor="prop-label">Label they see</Label>
          <Input id="prop-label" disabled={!editable} maxLength={120} value={f.label} placeholder={f.type === "checkbox" ? "I have a pet" : "Unit number"} onChange={(e) => onChange({ label: e.target.value })} />
        </div>
      )}
      {!compact && f.type === "text" && (
        <div className="grid gap-1.5">
          <Label htmlFor="prop-max">Most characters</Label>
          <Input id="prop-max" type="number" min={1} max={500} disabled={!editable} value={f.validation.max_length ?? ""} placeholder="500"
            onChange={(e) => onChange({ validation: { ...f.validation, max_length: e.target.value ? Math.max(1, Math.min(500, Number(e.target.value))) : undefined } })} />
        </div>
      )}
      {!compact && f.type === "number" && (
        <div className="grid grid-cols-2 gap-2">
          {(["min", "max"] as const).map((k) => (
            <div key={k} className="grid gap-1.5">
              <Label htmlFor={`prop-${k}`}>{k === "min" ? "Lowest" : "Highest"}</Label>
              <Input id={`prop-${k}`} type="number" disabled={!editable} value={f.validation[k] ?? ""}
                onChange={(e) => onChange({ validation: { ...f.validation, [k]: e.target.value === "" ? undefined : Number(e.target.value) } })} />
            </div>
          ))}
        </div>
      )}
      {!compact && choices && (
        <div className="grid gap-1.5">
          <Label>Choices</Label>
          {f.options.map((o, i) => (
            <div key={i} className="flex gap-1.5">
              <Input aria-label={`Choice ${i + 1}`} disabled={!editable} value={o} maxLength={80} onChange={(e) => onChange({ options: f.options.map((x, j) => (j === i ? e.target.value : x)) })} />
              <Button size="icon" variant="ghost" aria-label={`Remove choice ${i + 1}`} disabled={!editable || f.options.length <= 2} onClick={() => onChange({ options: f.options.filter((_, j) => j !== i) })}><Trash2 aria-hidden /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" disabled={!editable || f.options.length >= 20} onClick={() => onChange({ options: [...f.options, `Option ${f.options.length + 1}`] })}>Add a choice</Button>
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!editable} onClick={onDuplicate}><Copy aria-hidden />Duplicate</Button>
        <Button size="sm" variant="ghost" disabled={!editable} onClick={onRemove} className="text-destructive"><Trash2 aria-hidden />Delete</Button>
      </div>
    </div>
  );
}
