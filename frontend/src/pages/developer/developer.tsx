// Developers: API keys for the REST API, webhook endpoints with their delivery log, and the few lines needed to start. Keys and
// webhook secrets are shown once, when made. AI clients (ChatGPT, Claude, any MCP client) connect from the Agents page instead.
import { useState } from "react";
import { Link } from "react-router";
import { Check, Copy, KeyRound, Loader2, Plus, RotateCw, Send, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { routePath } from "../../../../xano/routes.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, LoadError, PageHeader, StatusBadge, useLoad } from "@/components/kit";
import { relative } from "@/components/kit/time";
import { cn } from "@/components/kit/cn";
import { XANO_HOST, request } from "@/lib/api";
import { useConfirm } from "@/components/confirm";
import { useLive } from "@/base/live";

type Key = { id: number; name: string; prefix: string; user_id: number; owner_name: string | null; last_used_at: number | null; revoked_at: number | null; created_at: number };
type Delivery = { id: number; event: string; event_id: string; status: "pending" | "delivered" | "failed"; attempts: number; response_code: number; response_excerpt: string; created_at: number; delivered_at: number | null; next_attempt_at: number | null };
type Endpoint = { id: number; url: string; events: string[]; enabled: boolean; description: string; created_at: number; deliveries: Delivery[] };

const api = {
  keys: () => request<{ items: Key[] }>("GET", routePath("GET developer/keys")),
  makeKey: (name: string) => request<{ id: number; key: string; name: string }>("POST", routePath("POST developer/keys"), { name }),
  revoke: (id: number) => request<unknown>("POST", routePath("POST developer/keys/{id}/revoke", { id })),
  hooks: () => request<{ items: Endpoint[]; events: string[] }>("GET", routePath("GET developer/webhooks")),
  addHook: (url: string, events: string[], description: string) => request<{ id: number; secret: string }>("POST", routePath("POST developer/webhooks"), { url, events, description }),
  setHook: (id: number, patch: { enabled?: boolean; remove?: boolean }) => request<unknown>("PATCH", routePath("PATCH developer/webhooks/{id}", { id }), patch),
  ping: (id: number) => request<{ status: string; code: number }>("POST", routePath("POST developer/webhooks/{id}/ping", { id })),
  resend: (id: number) => request<{ status: string; code: number }>("POST", routePath("POST developer/deliveries/{id}/resend", { id })),
};

const EVENT_WORDS: Record<string, string> = {
  "envelope.sent": "A document is sent", "envelope.completed": "A document is completed", "envelope.declined": "A document is declined",
  "envelope.voided": "A document is cancelled", "envelope.expired": "A document expires", "recipient.opened": "Someone opens it",
  "recipient.signed": "Someone signs", "recipient.declined": "Someone declines",
};

export function DeveloperPage() {
  const [confirm, confirmDialog] = useConfirm();
  const keys = useLoad(() => api.keys(), []);
  const hooks = useLoad(() => api.hooks(), []);
  useLive(["api_key", "webhook"], () => { keys.reload(); hooks.reload(); });
  const [shown, setShown] = useState<{ title: string; label: string; value: string; note: string } | null>(null);
  const [adding, setAdding] = useState<"key" | "hook" | null>(null);
  const base = `${XANO_HOST}/api:api`;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-6 sm:px-8 sm:py-10">
      <PageHeader title="Developers" description={<>Send documents and follow them from your own systems. To connect ChatGPT, Claude or another AI client, use <Link to="/agents" className="underline">Agents</Link>.</>} />

      <section className="grid gap-3" aria-labelledby="keys-h">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="keys-h" className="font-semibold">API keys</h2>
            <p className="text-sm text-muted-foreground">A key acts as the person who made it, with their role as it is now.</p>
          </div>
          <Button variant="outline" onClick={() => setAdding("key")}><Plus aria-hidden />New key</Button>
        </div>
        {keys.error ? <LoadError title="Keys didn't load" error={keys.error} onRetry={keys.reload} />
          : !keys.data ? <div className="h-20 animate-pulse rounded-lg border bg-card" />
          : keys.data.items.length === 0 ? <EmptyState icon={KeyRound} title="No API keys yet" description="Make one for each system that calls the API, so you can revoke it on its own." />
          : (
            <ul className="divide-y rounded-lg border bg-card">
              {keys.data.items.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <KeyRound aria-hidden className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{k.name}</span>
                    <span className="block text-caption text-muted-foreground"><span className="font-mono">…{k.prefix}</span> · {k.owner_name ?? "someone"} · {k.last_used_at ? `used ${relative(k.last_used_at)}` : "never used"}</span>
                  </span>
                  {k.revoked_at ? <StatusBadge tone="neutral">Revoked</StatusBadge> : (
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => {
                      if (!(await confirm({ title: `Revoke “${k.name}”?`, body: "Anything using it stops working at once.", action: "Revoke key", destructive: true }))) return;
                      try { await api.revoke(k.id); toast.success("Key revoked"); keys.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "It wasn't revoked. Try again."); }
                    }}>Revoke</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="grid gap-3" aria-labelledby="hooks-h">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="hooks-h" className="font-semibold">Webhooks</h2>
            <p className="text-sm text-muted-foreground">We POST a signed event to your address when a document moves. A failed delivery is tried 5 times over about 3 hours.</p>
          </div>
          <Button variant="outline" onClick={() => setAdding("hook")}><Plus aria-hidden />Add endpoint</Button>
        </div>
        {hooks.error ? <LoadError title="Webhooks didn't load" error={hooks.error} onRetry={hooks.reload} />
          : !hooks.data ? <div className="h-20 animate-pulse rounded-lg border bg-card" />
          : hooks.data.items.length === 0 ? <EmptyState icon={Webhook} title="No webhook endpoints" description="Add your server's address to hear about documents as they move." />
          : hooks.data.items.map((h) => <EndpointCard key={h.id} h={h} reload={hooks.reload} confirm={confirm} />)}
      </section>

      <section className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="start-h">
        <h2 id="start-h" className="font-semibold">Getting started</h2>
        <p className="text-sm text-muted-foreground">Every call takes your key as a bearer token, and acts as you.</p>
        <Code>{`curl ${base}/v1/envelopes?segment=waiting \\\n  -H "Authorization: Bearer <your API key>"`}</Code>
        <ul className="grid gap-1 text-sm">
          {[
            ["GET", "/v1/envelopes", "your documents, by segment or search"], ["GET", "/v1/envelopes/{id}", "one document with its trail"],
            ["GET", "/v1/templates", "templates and their roles"], ["POST", "/v1/templates/{id}/send", "send a template to people"],
            ["POST", "/v1/envelopes/{id}/remind", "remind whoever's turn it is"], ["POST", "/v1/envelopes/{id}/void", "cancel, with a reason"],
            ["GET", "/v1/envelopes/{id}/signed_pdf", "the signed PDF"],
          ].map(([v, p, what]) => <li key={p + v} className="flex flex-wrap gap-x-2"><span className="w-12 font-mono text-caption font-semibold">{v}</span><span className="font-mono text-caption">{p}</span><span className="text-muted-foreground">· {what}</span></li>)}
        </ul>
        <p className="mt-2 text-sm text-muted-foreground">To check a webhook came from us, compute HMAC-SHA256 of <span className="font-mono text-caption">{"{t}.{body}"}</span> with your endpoint's secret, and compare it with <span className="font-mono text-caption">v1</span> in the <span className="font-mono text-caption">X-Countersign-Signature</span> header (<span className="font-mono text-caption">t=…,v1=…</span>). Use the raw body, before parsing it.</p>
      </section>

      {adding === "key" ? <NewKeyDialog onClose={() => setAdding(null)} onMade={(k) => { setAdding(null); keys.reload(); setShown({ title: "Your new API key", label: "API key", value: k.key, note: "Copy it now: it's never shown again. Keep it on your server, never in a browser or app." }); }} /> : null}
      {adding === "hook" ? <NewHookDialog events={hooks.data?.events ?? Object.keys(EVENT_WORDS)} onClose={() => setAdding(null)} onMade={(secret) => { setAdding(null); hooks.reload(); setShown({ title: "Endpoint added", label: "Signing secret", value: secret, note: "Copy it now: it's never shown again. Your server uses it to check each event came from us." }); }} /> : null}
      {shown ? <ShownOnce {...shown} onClose={() => setShown(null)} /> : null}
      {confirmDialog}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-caption leading-relaxed">{children}</pre>;
}

function EndpointCard({ h, reload, confirm }: { h: Endpoint; reload: () => void; confirm: ReturnType<typeof useConfirm>[0] }) {
  const [busy, setBusy] = useState("");
  const act = async (what: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(what);
    try { const r = await fn(); if (ok) toast.success(ok); else if (r && typeof r === "object" && "status" in r) { const x = r as { status: string; code: number }; x.status === "delivered" ? toast.success(`Delivered (${x.code})`) : toast.error(x.code ? `Your server answered ${x.code}` : "Your server didn't answer"); } reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(""); }
  };
  return (
    <article className="overflow-hidden rounded-lg border bg-card">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <Webhook aria-hidden className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm">{h.url}</p>
          <p className="text-caption text-muted-foreground">{h.description ? `${h.description} · ` : ""}{h.events.length} {h.events.length === 1 ? "event" : "events"}</p>
        </div>
        <StatusBadge tone={h.enabled ? "success" : "neutral"} dot>{h.enabled ? "On" : "Off"}</StatusBadge>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={!!busy || !h.enabled} onClick={() => act("ping", () => api.ping(h.id))}>{busy === "ping" ? <Loader2 aria-hidden className="animate-spin" /> : <Send aria-hidden />}Send a test</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("toggle", () => api.setHook(h.id, { enabled: !h.enabled }), h.enabled ? "Turned off" : "Turned on")}>{h.enabled ? "Turn off" : "Turn on"}</Button>
          <Button size="icon" variant="ghost" className="size-8" aria-label={`Delete ${h.url}`} disabled={!!busy} onClick={async () => { if (await confirm({ title: "Delete this endpoint?", body: "Its delivery log goes too, and no more events are sent to it.", action: "Delete endpoint", destructive: true })) void act("remove", () => api.setHook(h.id, { remove: true }), "Endpoint deleted"); }}><Trash2 aria-hidden /></Button>
        </div>
      </header>
      {h.deliveries.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">No deliveries yet. Send a test to check your server.</p> : (
        <ul className="divide-y text-sm" aria-label="Recent deliveries">
          {h.deliveries.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <span className={cn("size-2 shrink-0 rounded-full", d.status === "delivered" ? "bg-[var(--success)]" : d.status === "failed" ? "bg-destructive" : "bg-[var(--warning)]")} aria-hidden />
              <span className="font-mono text-caption">{d.event}</span>
              <span className="text-caption text-muted-foreground">
                {d.status === "delivered" ? `delivered ${relative(d.delivered_at ?? d.created_at)}` : d.status === "failed" ? `failed after ${d.attempts} ${d.attempts === 1 ? "try" : "tries"}` : d.attempts ? `retrying ${d.next_attempt_at ? relative(d.next_attempt_at) : "soon"}` : "sending"}
                {d.response_code ? ` · ${d.response_code}` : ""}
              </span>
              {d.status !== "delivered" ? <Button size="sm" variant="ghost" className="ml-auto h-7" disabled={!!busy} onClick={() => act(`re-${d.id}`, () => api.resend(d.id))}>{busy === `re-${d.id}` ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />}Resend</Button> : null}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function NewKeyDialog({ onClose, onMade }: { onClose: () => void; onMade: (k: { key: string }) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New API key</DialogTitle><DialogDescription>Name it after what will use it, so you know which to revoke later.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { onMade(await api.makeKey(name.trim())); } catch (err) { setError(err instanceof Error ? err.message : "It wasn't made. Try again."); setBusy(false); } }}>
          <div className="grid gap-1.5"><Label htmlFor="key-name">Name</Label><Input id="key-name" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="CRM sync" /></div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter className="gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Make key</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewHookDialog({ events, onClose, onMade }: { events: string[]; onClose: () => void; onMade: (secret: string) => void }) {
  const [url, setUrl] = useState("https://");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<string[]>(["envelope.completed"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader><DialogTitle>Add a webhook endpoint</DialogTitle><DialogDescription>Your server's address, and which events to send it.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { onMade((await api.addHook(url.trim(), chosen, description.trim())).secret); } catch (err) { setError(err instanceof Error ? err.message : "It wasn't added. Try again."); setBusy(false); } }}>
          <div className="grid gap-1.5"><Label htmlFor="hook-url">Address</Label><Input id="hook-url" type="url" value={url} autoFocus onChange={(e) => setUrl(e.target.value)} className="font-mono text-sm" /></div>
          <div className="grid gap-1.5"><Label htmlFor="hook-desc">Description (optional)</Label><Input id="hook-desc" value={description} maxLength={120} onChange={(e) => setDescription(e.target.value)} placeholder="Billing system" /></div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Events</legend>
            {events.map((ev) => (
              <label key={ev} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={chosen.includes(ev)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, ev] : c.filter((x) => x !== ev)))} />
                <span>{EVENT_WORDS[ev] ?? ev}</span><span className="font-mono text-caption text-muted-foreground">{ev}</span>
              </label>
            ))}
          </fieldset>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter className="gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || chosen.length === 0}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Add endpoint</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShownOnce({ title, label, value, note, onClose }: { title: string; label: string; value: string; note: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{note}</DialogDescription></DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
          <Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { toast.error("Couldn't copy. Select it and copy it instead."); } }}>{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copied" : "Copy"}</Button>
        </div>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
