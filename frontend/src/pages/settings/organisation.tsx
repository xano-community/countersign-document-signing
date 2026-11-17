// Organisation settings (admins): branding signers see, email setup, the defaults new documents start with, the consent
// disclosure, and data: how long ended documents are kept, demo data, and an export of every document's record.
import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, CircleAlert, Download, Loader2, Mail, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { routePath } from "../../../../xano/routes.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoadError, PageHeader, ProfileSection, Segmented, useLoad } from "@/components/kit";
import { XANO_HOST, qs, request } from "@/lib/api";
import { useConfirm } from "@/components/confirm";
import { saveBlob } from "@/lib/envelopes";

type Org = {
  id: number; org_name: string; logo_data_url: string; accent: string; email_sender_name: string; reply_to: string;
  default_expiry_days: number; default_reminder_days: number; retention_days: number; demo_mode: boolean;
};
type Signing = { ok: boolean; configured?: boolean; key_ok?: boolean; subject?: string; issuer?: string; not_before?: number; not_after?: number; self_signed?: boolean; chain?: number; error?: string };
type OrgView = { org: Org; app_url: string | null; disclosure: { version: number; text: string; created_at: number } | null; demo_documents: number; signing: Signing };
type EmailStatus = { state: "ready" | "missing_key" | "missing_from" | "webhook_missing"; can_send: boolean; key_set: boolean; from_set: boolean; tracking: boolean };
type Exported = {
  documents: { id: number; public_id: string; title: string; status: string; sender_id: number; created_at: number; sent_at: number | null; completed_at: number | null; ended_at: number | null; end_reason: string; final_sha256: string }[];
  members: { id: number; name: string; email: string }[];
  recipients: { envelope_id: number; name: string; email: string; role: string; status: string; completed_at: number | null }[];
};

const orgApi = {
  read: () => request<OrgView>("GET", routePath("GET org")),
  save: (o: Omit<Org, "id">) => request<Org>("PATCH", routePath("PATCH org"), o),
  disclosure: (text: string) => request<{ version: number }>("POST", routePath("POST org/disclosure"), { text }),
  clearDemo: () => request<{ removed: number }>("POST", routePath("POST org/clear_demo")),
  exportAll: () => request<Exported>("GET", routePath("GET org/export")),
  email: () => request<EmailStatus>("GET", routePath("GET email/status") + qs({ app_url: window.location.origin })),
  testEmail: () => request<{ ok: boolean; status: string; error: string; to: string }>("POST", routePath("POST email/test"), { app_url: window.location.origin }),
};

const KEEP = [
  { value: "0", label: "Forever" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" }, { value: "730", label: "2 years" }, { value: "2555", label: "7 years" },
];

/** The settings a person edits, with blanks for the ones never set, in a fixed order so two copies compare equal. */
const editable = (x: Org): Omit<Org, "id"> => ({
  org_name: x.org_name ?? "", logo_data_url: x.logo_data_url ?? "", accent: x.accent || "ink", email_sender_name: x.email_sender_name ?? "", reply_to: x.reply_to ?? "",
  default_expiry_days: x.default_expiry_days ?? 30, default_reminder_days: x.default_reminder_days ?? 3, retention_days: x.retention_days ?? 0, demo_mode: !!x.demo_mode,
});

export function OrganisationPage() {
  const view = useLoad(() => orgApi.read(), []);
  if (view.error) return <div className="mx-auto max-w-3xl p-8"><LoadError title="Settings didn't load" error={view.error} onRetry={view.reload} /></div>;
  if (!view.data) return <div className="grid min-h-[50vh] place-items-center text-muted-foreground"><Loader2 aria-label="Loading" className="animate-spin" /></div>;
  return <Organisation v={view.data} reload={view.reload} />;
}

function Organisation({ v, reload }: { v: OrgView; reload: () => void }) {
  const [o, setO] = useState<Omit<Org, "id">>(() => editable(v.org));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(o) !== JSON.stringify(editable(v.org));
  const set = (patch: Partial<typeof o>) => setO((x) => ({ ...x, ...patch }));
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setSaving(true); setError(null);
    try { await orgApi.save(o); toast.success("Settings saved"); reload(); }
    catch (err) { setError(err instanceof Error ? err.message : "That didn't save. Try again."); }
    finally { setSaving(false); }
  };
  const pickLogo = async (f: File) => {
    if (!/^image\/(png|jpeg)$/.test(f.type)) { toast.error("Use a PNG or JPEG logo."); return; }
    if (f.size > 200 * 1024) { toast.error("That logo is too large. Use one under 200 KB."); return; }
    const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });
    set({ logo_data_url: url });
  };

  return (
    <form className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10" onSubmit={save}>
      <PageHeader title="Organisation" description="What signers see, how email reads, and the rules every document follows." back={{ href: "/settings", label: "Settings" }}
        actions={<Button type="submit" disabled={saving || !dirty}>{saving ? <Loader2 aria-hidden className="animate-spin" /> : null}Save changes</Button>} />
      {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <ProfileSection title="Branding" description="Shown at the top of every signing page, in every email, and on certificates.">
        <div className="grid gap-4 sm:max-w-md">
          <div className="grid gap-1.5"><Label htmlFor="org-name">Organisation name</Label><Input id="org-name" value={o.org_name} maxLength={80} onChange={(e) => set({ org_name: e.target.value })} /></div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Logo</span>
            <div className="flex items-center gap-3">
              {o.logo_data_url
                ? <img src={o.logo_data_url} alt="Your logo" className="size-12 rounded-md border bg-white object-contain p-1" />
                : <span aria-hidden className="grid size-12 place-items-center rounded-md bg-primary text-lg font-semibold text-primary-foreground">{o.org_name.trim()[0] ?? "?"}</span>}
              <label className="focus-within:ring-ring inline-flex cursor-pointer items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium focus-within:ring-2 hover:bg-muted">
                <Upload aria-hidden className="size-4" />{o.logo_data_url ? "Replace" : "Upload"}
                <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickLogo(f); e.target.value = ""; }} />
              </label>
              {o.logo_data_url ? <Button type="button" variant="ghost" size="sm" onClick={() => set({ logo_data_url: "" })}>Remove</Button> : null}
            </div>
            <p className="text-caption text-muted-foreground">A square PNG or JPEG under 200 KB. Without one, the first letter of your name is used.</p>
          </div>
        </div>
      </ProfileSection>

      <EmailSection o={o} set={set} />

      <SigningSection signing={v.signing} />

      <ProfileSection title="New documents" description="What every new document starts with. Senders can change them before sending.">
        <div className="grid gap-4 sm:grid-cols-2 sm:max-w-md">
          <div className="grid gap-1.5"><Label htmlFor="org-expiry">Deadline (days)</Label><Input id="org-expiry" type="number" min={1} max={365} value={o.default_expiry_days} onChange={(e) => set({ default_expiry_days: Number(e.target.value) })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="org-remind">Remind every (days, 0 for never)</Label><Input id="org-remind" type="number" min={0} max={30} value={o.default_reminder_days} onChange={(e) => set({ default_reminder_days: Number(e.target.value) })} /></div>
        </div>
      </ProfileSection>

      <DisclosureSection current={v.disclosure} onSaved={reload} />

      <ProfileSection title="Data" description="How long ended documents are kept, the demo, and a copy of every record.">
        <div className="grid gap-5">
          <div className="grid gap-2">
            <span id="keep-label" className="text-sm font-medium">Keep ended documents</span>
            <Segmented label="Keep ended documents" value={String(o.retention_days || 0)} onChange={(x) => set({ retention_days: Number(x) })} options={KEEP} />
            <p className="text-caption text-muted-foreground">
              {o.retention_days ? `Completed, declined, cancelled and expired documents are deleted ${KEEP.find((k) => k.value === String(o.retention_days))?.label.toLowerCase() ?? `${o.retention_days} days`} after they end, with their files. The verify page still says a deleted document once existed.` : "Nothing is deleted automatically."}
            </p>
          </div>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--primary)]" checked={o.demo_mode} onChange={(e) => set({ demo_mode: e.target.checked })} />
            <span><span className="block text-sm font-medium">Demo mode</span><span className="block text-caption text-muted-foreground">Visitors can try the app as a sample person, and email only goes to people on your team. Turn it off before real use.</span></span>
          </label>
          <DataActions demo={v.demo_documents} onCleared={reload} />
        </div>
      </ProfileSection>
      <div className="flex justify-end"><Button type="submit" disabled={saving || !dirty}>{saving ? <Loader2 aria-hidden className="animate-spin" /> : null}Save changes</Button></div>
    </form>
  );
}

function EmailSection({ o, set }: { o: Omit<Org, "id">; set: (p: Partial<Omit<Org, "id">>) => void }) {
  const status = useLoad(() => orgApi.email(), []);
  const [testing, setTesting] = useState(false);
  const st = status.data;
  const hook = `${XANO_HOST}${routePath("POST resend")}`;
  return (
    <ProfileSection title="Email" description="Invitations, reminders, codes and signed copies are sent through Resend.">
      <div className="grid gap-4">
        {st ? (
          <div className="flex items-start gap-3 rounded-lg border bg-paper p-3">
            {st.can_send ? <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-[var(--success)]" /> : <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-[var(--warning)]" />}
            <div className="grid gap-1 text-sm">
              <p className="font-medium">{st.state === "ready" ? "Email is set up" : st.state === "webhook_missing" ? "Email is set up; delivery tracking is off" : "Email isn't set up yet"}</p>
              {st.state === "ready" ? <p className="text-muted-foreground">Delivered, bounced and spam reports show on each document.</p> : null}
              {!st.can_send ? (
                <>
                  <p className="text-muted-foreground">Until it is, senders get each person's signing link to share themselves. To send email:</p>
                  <ol className="ml-4 list-decimal text-muted-foreground">
                    <li>Make a free account at resend.com and verify your domain.</li>
                    <li>In Xano, set the environment variables <span className="font-mono text-caption">RESEND_API_KEY</span> and <span className="font-mono text-caption">RESEND_FROM</span> (like <span className="font-mono text-caption">signing@yourcompany.com</span>).</li>
                    <li>Come back here and send a test.</li>
                  </ol>
                </>
              ) : st.state === "webhook_missing" ? (
                <p className="text-muted-foreground">In Resend, add a webhook to <span className="break-all font-mono text-caption">{hook}</span>, then set its signing secret as <span className="font-mono text-caption">RESEND_WEBHOOK_SECRET</span>.</p>
              ) : null}
              {st.can_send ? (
                <Button type="button" variant="outline" size="sm" className="mt-1 w-fit" disabled={testing} onClick={async () => {
                  setTesting(true);
                  try { const r = await orgApi.testEmail(); r.ok ? toast.success(`Test email sent to ${r.to}`) : toast.error(r.error || "The test didn't send."); }
                  catch (e) { toast.error(e instanceof Error ? e.message : "The test didn't send."); }
                  finally { setTesting(false); }
                }}>{testing ? <Loader2 aria-hidden className="animate-spin" /> : <Mail aria-hidden />}Send me a test</Button>
              ) : null}
            </div>
          </div>
        ) : status.error ? <LoadError title="Email status didn't load" error={status.error} onRetry={status.reload} /> : <div className="h-16 animate-pulse rounded-lg border bg-card" />}
        <div className="grid gap-4 sm:grid-cols-2 sm:max-w-xl">
          <div className="grid gap-1.5"><Label htmlFor="org-sender">Sender name</Label><Input id="org-sender" value={o.email_sender_name} maxLength={80} placeholder={o.org_name} onChange={(e) => set({ email_sender_name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="org-reply">Replies go to (optional)</Label><Input id="org-reply" type="email" value={o.reply_to} placeholder="The sender of each document" onChange={(e) => set({ reply_to: e.target.value })} /></div>
        </div>
      </div>
    </ProfileSection>
  );
}

function DisclosureSection({ current, onSaved }: { current: OrgView["disclosure"]; onSaved: () => void }) {
  const [text, setText] = useState(current?.text ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(current?.text ?? ""), [current?.text]);
  const changed = text.trim() !== (current?.text ?? "").trim();
  return (
    <ProfileSection title="Consent disclosure" description={`What every signer reads and agrees to before signing electronically. Version ${current?.version ?? 1} is in use.`}>
      <div className="grid gap-2">
        <Label htmlFor="disclosure" className="sr-only">Disclosure text</Label>
        <Textarea id="disclosure" value={text} onChange={(e) => setText(e.target.value)} rows={9} maxLength={10_000} className="font-[inherit] text-sm" />
        <p className="text-caption text-muted-foreground">Publishing makes a new version. Each signer's record and certificate keep the version they agreed to.</p>
        <Button type="button" variant="outline" className="w-fit" disabled={busy || !changed} onClick={async () => {
          setBusy(true);
          try { const r = await orgApi.disclosure(text.trim()); toast.success(`Version ${r.version} is now in use`); onSaved(); }
          catch (e) { toast.error(e instanceof Error ? e.message : "It wasn't published. Try again."); }
          finally { setBusy(false); }
        }}>{busy ? <Loader2 aria-hidden className="animate-spin" /> : null}Publish version {(current?.version ?? 1) + 1}</Button>
      </div>
    </ProfileSection>
  );
}

const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : "");

function DataActions({ demo, onCleared }: { demo: number; onCleared: () => void }) {
  const [busy, setBusy] = useState("");
  const [confirm, confirmDialog] = useConfirm();
  const exportAll = async () => {
    setBusy("export");
    try {
      const r = await orgApi.exportAll();
      const who = new Map(r.members.map((m) => [m.id, m]));
      const people = new Map<number, string[]>();
      for (const p of r.recipients) people.set(p.envelope_id, [...(people.get(p.envelope_id) ?? []), `${p.name} <${p.email}> (${p.role}, ${p.status})`]);
      const rows = [["Document ID", "Title", "Status", "Sender", "Created", "Sent", "Completed", "Ended", "Why it ended", "Signed PDF SHA-256", "People"],
        ...r.documents.map((d) => [d.public_id, d.title, d.status, who.get(d.sender_id)?.email ?? "", iso(d.created_at), iso(d.sent_at), iso(d.completed_at), iso(d.ended_at), d.end_reason, d.final_sha256, (people.get(d.id) ?? []).join("; ")])];
      saveBlob(new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\n")], { type: "text/csv" }), `countersign-documents-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "The export didn't run. Try again."); }
    finally { setBusy(""); }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {confirmDialog}
      <Button type="button" variant="outline" onClick={exportAll} disabled={!!busy}>{busy === "export" ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}Export every document's record (CSV)</Button>
      {demo > 0 ? (
        <Button type="button" variant="outline" className="text-destructive" disabled={!!busy} onClick={async () => {
          if (!(await confirm({ title: `Delete the ${demo} demo documents and templates?`, body: "Your own documents stay. This can't be undone.", action: "Delete demo data", destructive: true }))) return;
          setBusy("demo");
          try { const r = await orgApi.clearDemo(); toast.success(`${r.removed} demo ${r.removed === 1 ? "item" : "items"} deleted`); onCleared(); }
          catch (e) { toast.error(e instanceof Error ? e.message : "They weren't deleted. Try again."); }
          finally { setBusy(""); }
        }}>{busy === "demo" ? <Loader2 aria-hidden className="animate-spin" /> : <Trash2 aria-hidden />}Clear demo data ({demo})</Button>
      ) : null}
    </div>
  );
}

/**
 * How sealed PDFs are protected, and what a reader sees in Adobe or Preview: always the fingerprint, the chained audit trail and
 * the verify page; with a certificate set on the backend, an embedded digital signature too. Says plainly what each level can't do.
 */
function SigningSection({ signing }: { signing: Signing }) {
  const on = signing.ok && signing.configured;
  const expired = on && !!signing.not_after && signing.not_after < Date.now();
  const date = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");
  const state = !signing.ok ? "error" : !on ? "off" : !signing.key_ok ? "bad_key" : expired ? "expired" : signing.self_signed ? "self" : "ca";
  return (
    <ProfileSection title="Document signing" description="How a signed PDF proves it hasn't changed since everyone signed.">
      <div className="grid gap-4 text-sm">
        <div className="flex items-start gap-3 rounded-lg border bg-paper p-3">
          {state === "ca" ? <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-[var(--success)]" /> : <CircleAlert aria-hidden className={`mt-0.5 size-5 shrink-0 ${state === "bad_key" || state === "expired" || state === "error" ? "text-destructive" : "text-[var(--warning)]"}`} />}
          <div className="grid gap-1">
            <p className="font-medium">{{
              off: "Sealed with a fingerprint, without an embedded digital signature",
              self: "Digitally signed with a self-made certificate",
              ca: "Digitally signed with your organisation's certificate",
              bad_key: "The signing key doesn't work",
              expired: "The signing certificate has expired",
              error: "The signing certificate couldn't be read",
            }[state]}</p>
            <p className="text-muted-foreground">{{
              off: "Each signed PDF's SHA-256 fingerprint is recorded, sent to every party in their completion email, and checked on the verify page; the audit trail is chained so any edit shows. Adobe and Preview show no signature panel, and someone holding only the file can't tell it's unchanged without the verify page.",
              self: "PDF readers can now tell, from the file alone, whether it changed after sealing. Because nobody vouches for a self-made certificate, Adobe shows the signer as unknown (a yellow warning), not a blue “signed” bar. Fine for testing; for recipients, use a certificate from a trusted authority.",
              ca: "Every sealed PDF carries a signature readers check on their own. Adobe shows the blue “signed and all signatures are valid” bar when this certificate chains to the Adobe Approved Trust List (AATL); otherwise it shows the signer as unknown.",
              bad_key: "SIGNING_KEY must be the certificate's PKCS#8 private key (“BEGIN PRIVATE KEY”), RSA or EC P-256/P-384, unencrypted. Until it works, documents are sealed without a digital signature.",
              expired: "Documents sealed now are signed with an expired certificate, which readers flag. Renew it and set the new one.",
              error: signing.error ?? "Check SIGNING_CERT is a PEM certificate.",
            }[state]}</p>
            {on ? (
              <dl className="mt-1 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-0.5 text-caption">
                <dt className="text-muted-foreground">Signed as</dt><dd className="break-words">{signing.subject}</dd>
                <dt className="text-muted-foreground">Issued by</dt><dd className="break-words">{signing.self_signed ? "Itself (self-made)" : signing.issuer}</dd>
                <dt className="text-muted-foreground">Valid</dt><dd>{date(signing.not_before)} to {date(signing.not_after)}</dd>
                {signing.chain ? <><dt className="text-muted-foreground">Chain</dt><dd>{signing.chain} intermediate {signing.chain === 1 ? "certificate" : "certificates"}</dd></> : null}
              </dl>
            ) : null}
          </div>
        </div>
        <details className="rounded-lg border px-3 py-2">
          <summary className="cursor-pointer font-medium">What each level protects, and how to go further</summary>
          <ul className="mt-2 grid list-disc gap-1.5 pl-5 text-muted-foreground">
            <li><span className="text-foreground">Always:</span> a simple electronic signature with each signer's consent, IP, device and times; a tamper-evident audit trail; the file's fingerprint in every party's email; the public verify page.</li>
            <li><span className="text-foreground">With a certificate</span> (set <span className="font-mono text-caption">SIGNING_KEY</span> and <span className="font-mono text-caption">SIGNING_CERT</span> on the backend): an embedded signature, so the file proves on its own whether it changed. Countersign signs as your organisation; the individual signers don't each hold a certificate.</li>
            <li><span className="text-foreground">For Adobe's trusted “signed” bar:</span> buy a document-signing certificate from an authority on the Adobe Approved Trust List. They usually require the key in hardware or a cloud key service, which may mean signing through that provider instead of a key stored here.</li>
            <li><span className="text-foreground">Not included:</span> a trusted timestamp from a timestamp authority (the signing time is this server's clock), long-term validation data, and qualified or advanced signatures (eIDAS), which need each signer's identity verified by a certified provider.</li>
          </ul>
          <p className="mt-2 text-caption text-muted-foreground">The README's “Digital signatures” section has the steps, including making a test certificate.</p>
        </details>
      </div>
    </ProfileSection>
  );
}

