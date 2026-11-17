// Send to many: one template, a spreadsheet of people. The CSV is read here in the browser, its columns matched to the template's
// roles, and every row checked before anything is sent. Rows that won't work are shown by line, with why; the rest go out in the
// background, and this page follows along.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CheckCircle2, FileSpreadsheet, Loader2, Send, TriangleAlert, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError, PageHeader, StatusBadge, useLoad } from "@/components/kit";
import { cn } from "@/components/kit/cn";
import { EMAIL, guessColumns, openRoles, parseCsv, templatesApi, type BulkRowIn, type Template } from "@/lib/templates";

const MOST_ROWS = 500;
const MOST_BYTES = 2 * 1024 * 1024;

export function BulkSendPage() {
  const id = Number(useParams().id);
  const list = useLoad(() => templatesApi.list(), []);
  const t = list.data?.items.find((x) => x.id === id);
  if (list.error) return <div className="mx-auto max-w-3xl p-8"><LoadError title="This template didn't load" error={list.error} onRetry={list.reload} /></div>;
  if (!list.data) return <div className="grid min-h-[50vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading" className="animate-spin" /></div>;
  if (!t) return <div className="mx-auto max-w-3xl p-8"><LoadError title="This template doesn't exist, or you can't see it" /></div>;
  return <BulkSetup t={t} />;
}

type Sheet = { name: string; header: string[]; rows: string[][] };

function BulkSetup({ t }: { t: Template }) {
  const navigate = useNavigate();
  const roles = openRoles(t);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [map, setMap] = useState<Record<number, { name: number; email: number }>>({});
  const [title, setTitle] = useState(t.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const read = async (file: File) => {
    setError(null);
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") { setError("Use a .csv file. In Excel or Google Sheets, choose File → Download → CSV."); return; }
    if (file.size > MOST_BYTES) { setError("That file is over 2 MB. Split it into smaller files."); return; }
    const cells = parseCsv(await file.text());
    if (cells.length < 2) { setError("That file has no rows under its header."); return; }
    const [header, ...rows] = cells;
    if (rows.length > MOST_ROWS) { setError(`That file has ${rows.length} rows. Send to up to ${MOST_ROWS} at a time.`); return; }
    setSheet({ name: file.name, header, rows });
    setMap(guessColumns(header, roles));
  };

  // Each row checked as the server will: every open role needs a name and a valid email.
  const checked = useMemo(() => (sheet?.rows ?? []).map((cells, i) => {
    const people = roles.map((r) => ({ role_id: r.id, name: (cells[map[r.id]?.name ?? -1] ?? "").trim(), email: (cells[map[r.id]?.email ?? -1] ?? "").trim() }));
    const bad = roles.find((r, k) => !people[k].name) ? `No name for ${roles.find((r, k) => !people[k].name)!.role_name}.`
      : roles.find((r, k) => !EMAIL.test(people[k].email)) ? `Check the email for ${roles.find((r, k) => !EMAIL.test(people[k].email))!.role_name}.` : "";
    return { line: i + 2, people, bad };
  }), [sheet, map, roles]);
  const good = checked.filter((r) => !r.bad);
  const bad = checked.filter((r) => r.bad);
  const mapped = roles.every((r) => (map[r.id]?.name ?? -1) >= 0 && (map[r.id]?.email ?? -1) >= 0);

  const send = async () => {
    setBusy(true);
    try {
      const rows: BulkRowIn[] = checked.map((r) => ({ line: r.line, people: r.people }));
      const made = await templatesApi.bulk(t.id, rows, title.trim());
      navigate(`/bulk/${made.bulk_send_id}`, { replace: true });
    } catch (e) { toast.error(e instanceof Error ? e.message : "The bulk send didn't start. Try again."); setBusy(false); }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
      <PageHeader title="Send to many" description={<>Send “{t.title}” to everyone in a spreadsheet. Each row gets their own copy.</>} back={{ href: "/templates", label: "Templates" }} />

      {roles.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm">Every role on this template already has a fixed person, so there's nobody to fill in from a spreadsheet. <Link to={`/documents/${t.id}/prepare`} className="underline">Edit the template</Link> to leave a role open.</p>
      ) : (
        <>
          <section className="grid gap-3" aria-labelledby="bulk-file">
            <h2 id="bulk-file" className="font-medium">1. Your spreadsheet</h2>
            <p className="text-sm text-muted-foreground">
              A CSV with a header row and {roles.length === 1 ? "a name and an email column" : `a name and email column for each of ${roles.map((r) => r.role_name).join(", ")}`}.
              {" "}Like: <span className="font-mono text-caption">{roles.map((r) => roles.length === 1 ? "name,email" : `${r.role_name} name,${r.role_name} email`).join(",")}</span>
            </p>
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void read(f); }}
              className={cn("focus-within:ring-ring flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed bg-card px-4 py-5 focus-within:ring-2", dragging ? "border-primary" : "border-input")}>
              {sheet ? <FileSpreadsheet aria-hidden className="size-6 shrink-0 text-primary-text" /> : <Upload aria-hidden className="size-6 shrink-0 text-primary-text" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{sheet ? sheet.name : "Drop a CSV, or choose a file"}</span>
                <span className="block text-caption text-muted-foreground">{sheet ? `${sheet.rows.length} ${sheet.rows.length === 1 ? "row" : "rows"}. Drop another to replace it.` : `Up to ${MOST_ROWS} rows.`}</span>
              </span>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ""; }} />
            </label>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </section>

          {sheet ? (
            <section className="grid gap-3" aria-labelledby="bulk-map">
              <h2 id="bulk-map" className="font-medium">2. Match the columns</h2>
              <div className="grid gap-3">
                {roles.map((r) => (
                  <div key={r.id} className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-[8rem_1fr_1fr] sm:items-end">
                    <p className="text-sm font-medium sm:pb-2">{r.role_name}</p>
                    {(["name", "email"] as const).map((k) => (
                      <div key={k} className="grid gap-1">
                        <Label htmlFor={`col-${r.id}-${k}`} className="text-caption">{k === "name" ? "Name column" : "Email column"}</Label>
                        <select id={`col-${r.id}-${k}`} value={map[r.id]?.[k] ?? -1} onChange={(e) => setMap((m) => ({ ...m, [r.id]: { ...m[r.id], [k]: Number(e.target.value) } }))}
                          className="focus-ring h-9 rounded-md border border-input bg-card px-2 text-sm">
                          <option value={-1}>Choose a column…</option>
                          {sheet.header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {sheet && mapped ? (
            <section className="grid gap-3" aria-labelledby="bulk-check">
              <h2 id="bulk-check" className="font-medium">3. Check and send</h2>
              <div className="grid gap-1.5 sm:max-w-md">
                <Label htmlFor="bulk-title">Title for each copy</Label>
                <Input id="bulk-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusBadge tone="success" dot>{good.length} ready</StatusBadge>
                {bad.length ? <StatusBadge tone="warning" dot>{bad.length} won't send</StatusBadge> : null}
              </div>
              {bad.length ? (
                <div className="overflow-hidden rounded-lg border bg-card">
                  <p className="border-b px-3 py-2 text-sm font-medium">Rows that won't send</p>
                  <ul className="max-h-56 divide-y overflow-y-auto text-sm">
                    {bad.map((r) => (
                      <li key={r.line} className="flex items-start gap-2 px-3 py-2">
                        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
                        <span><span className="font-medium">Line {r.line}:</span> {r.bad}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <Preview rows={good.slice(0, 5)} roles={roles} more={Math.max(0, good.length - 5)} />
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={send} disabled={busy || good.length === 0}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : <Send aria-hidden />}Send {good.length} {good.length === 1 ? "copy" : "copies"}</Button>
                <p className="text-caption text-muted-foreground">They go out in batches over the next few minutes. You can leave this page.</p>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Preview({ rows, roles, more }: { rows: { line: number; people: { name: string; email: string }[] }[]; roles: Template["roles"]; more: number }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <caption className="sr-only">The first rows that will be sent</caption>
        <thead><tr className="border-b text-left text-caption text-muted-foreground"><th className="px-3 py-2 font-medium">Line</th>{roles.map((r) => <th key={r.id} className="px-3 py-2 font-medium">{r.role_name}</th>)}</tr></thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.line}><td className="px-3 py-2 text-muted-foreground">{r.line}</td>{r.people.map((p, i) => <td key={i} className="px-3 py-2"><span className="block">{p.name}</span><span className="block text-caption text-muted-foreground">{p.email}</span></td>)}</tr>
          ))}
        </tbody>
      </table>
      {more ? <p className="border-t px-3 py-2 text-caption text-muted-foreground">and {more} more</p> : null}
    </div>
  );
}

/** A bulk send under way, or done: how many went, which failed and why. Checks again every few seconds while it runs. */
export function BulkProgressPage() {
  const id = Number(useParams().id);
  const detail = useLoad(() => templatesApi.bulkDetail(id), [id]);
  const running = detail.data?.bulk.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(detail.reload, 3000);
    return () => window.clearInterval(t);
  }, [running, detail.reload]);
  const [stopping, setStopping] = useState(false);
  if (detail.error && !detail.data) return <div className="mx-auto max-w-3xl p-8"><LoadError title="This bulk send didn't load" error={detail.error} onRetry={detail.reload} /></div>;
  if (!detail.data) return <div className="grid min-h-[50vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading" className="animate-spin" /></div>;
  const { bulk: b, failed_rows } = detail.data;
  const doneCount = b.sent + b.failed;
  const pct = b.total ? Math.round((doneCount / b.total) * 100) : 100;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
      <PageHeader title={b.title} description="Sent to many from a spreadsheet." back={{ href: "/templates", label: "Templates" }}
        actions={running ? <Button variant="outline" disabled={stopping} onClick={async () => { setStopping(true); try { await templatesApi.bulkCancel(b.id); detail.reload(); } finally { setStopping(false); } }}><XCircle aria-hidden />Stop sending</Button> : null} />
      <section className="grid gap-3 rounded-xl border bg-card p-5" aria-live="polite">
        <div className="flex items-center gap-3">
          {running ? <Loader2 aria-hidden className="size-5 animate-spin text-primary-text" /> : b.status === "done" ? <CheckCircle2 aria-hidden className="size-5 text-[var(--success)]" /> : <XCircle aria-hidden className="size-5 text-muted-foreground" />}
          <p className="font-medium">
            {running ? `Sending… ${b.sent} of ${b.total - b.failed} sent` : b.status === "done" ? `Done. ${b.sent} ${b.sent === 1 ? "copy" : "copies"} sent.` : `Stopped. ${b.sent} ${b.sent === 1 ? "copy was" : "copies were"} sent before you stopped it.`}
          </p>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-caption text-muted-foreground">
          Each copy is in Documents under “Waiting on others”.{b.failed ? ` ${b.failed} ${b.failed === 1 ? "row" : "rows"} didn't send.` : ""}
        </p>
      </section>
      {failed_rows.length ? (
        <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="failed-rows">
          <h2 id="failed-rows" className="border-b px-4 py-3 font-medium">Rows that didn't send</h2>
          <ul className="divide-y text-sm">
            {failed_rows.map((r) => (
              <li key={r.line} className="flex items-start gap-2 px-4 py-2.5">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
                <span><span className="font-medium">Line {r.line}</span>{r.people?.[0]?.email ? <span className="text-muted-foreground"> · {r.people[0].email}</span> : null}: {r.error}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Button variant="outline" className="w-fit" asChild><Link to="/?view=waiting">See the documents</Link></Button>
    </div>
  );
}
