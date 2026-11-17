# Countersign

Send documents for signature, sign them anywhere, and keep a copy anyone can check.

**Starter template**

`36 tables · 122 endpoints · 14 screens · auth: @xano-sdk/auth`

![Countersign: Jordan's documents, with one waiting for his signature](docs/screenshot-light.png)

Countersign is electronic signing for a team. Upload a PDF, add who signs and in what order, drop signature, initials, date and text fields on the page, and send. Each person signs from a link on their phone or computer, with no account. When everyone has signed, Countersign seals a final PDF with a certificate of completion, and anyone can check that file on the verify page. Templates, bulk sending from a spreadsheet, public signing links, a REST API, webhooks and MCP tools are built in.

It is a template to learn from and build on. Read [Is this legally binding?](#is-this-legally-binding) and [Limits](#limits) before you use it for anything that matters.

The backend under [`xano/`](xano/) is TypeScript, written with the [Xano SDK](https://github.com/xano-sdk/sdk). It runs on your machine as the Xano Engine, and on Xano's cloud with the same command. The React frontend under [`frontend/`](frontend/) takes its request paths and types from the backend.

## Quick start

```sh
git clone https://github.com/xano-community/countersign-document-signing
cd countersign-document-signing
npm install
```

Then run it one of two ways:

- **On your machine, no account.** `npm run xano:deploy` deploys and seeds the backend on the Xano Engine on your machine. Then `npm run dev` opens the app.
- **On a cloud link** (works with ChatGPT and Claude). Run `npx xanosdk login` once, then `npm run xano:deploy:ephemeral`. It prints a live URL.

Then click **Continue as Jordan Lee**. You need no email account for the demo: until you connect email, every signing link is shown to you to share yourself.

The demo is Fernhill Property Group, a property manager, in the middle of a week:

| Persona | Role | Who they are |
|---|---|---|
| **Jordan Lee** | member | Leasing manager. A plumbing contract waits for his countersignature |
| **Priya Shah** | admin | Runs operations: branding, email, retention, the team, API keys |
| **Sam Okafor** | member | People lead. An offer letter is out with a candidate |
| **Taylor Brooks** | viewer | Finance. Reads signed agreements, sends nothing |
| **Maya Chen** | signer, no account | A tenant with a lease to sign: "See what a signer sees" on the sign-in page |

## What you can do

**As Jordan, the first minute:**

1. **Documents** opens on what's waiting for you. Select **Your turn: sign** on the Northside Plumbing contract, adopt a signature, and finish. Ben from Northside has already signed, so the moment you finish, Countersign seals the final PDF.
2. Open **Mutual NDA — Harbor Analytics** under Completed: everyone's progress, the emails, and an audit trail marked **Intact**. **View signed copy** reads it right in the app, certificate pages included, or switch to the original; **Signed PDF** downloads it.
3. Open **Verify a PDF** and drop that file on it (outsiders use the same check at `/verify`, no sign-in). It matches, and with the document ID from the footer, it names who signed.
4. **New document**: upload any PDF, add yourself and a colleague (**Add me**), place fields, and send. Each person needs a name and a valid email before it sends. With email off, you get each person's link to share.
5. **Templates → Residential lease → Use**: fill in a tenant and send. **Send to many** does the same from a CSV.

**As Maya, with no account:** on the sign-in page, choose **See what a signer sees**. Her lease opens where she left it: **Start** walks her through each field, and **Sign and finish** sends it on to Jordan.

**In two windows:** sign as Maya in one, and keep Jordan's document page open in the other: it updates as she signs.

**As Priya:** **Settings → Organisation** sets the name and logo signers see, the email sender, default deadlines, the consent disclosure (published as versions), retention, demo mode and the export. **Developers** makes API keys and webhook endpoints. **Team** invites people and removes them.

## Connect your agent

Countersign is an MCP server. In **Agents**, make a key (read, or read and write), and add the server to Claude Code, Cursor or any MCP client with the line it shows. ChatGPT and Claude on the web connect by signing in instead, once `MCP_OAUTH_LOGIN_URL` is set ([Going to production](#going-to-production)).

The tools act as the person who connected them, with their access:

| Tool | Does |
|---|---|
| `list_envelopes` | Your documents by segment or search |
| `get_envelope` | One document: people, emails, trail |
| `list_templates` | Templates and their roles |
| `send_from_template` | **Asks first.** Sends once you approve it under Approvals |
| `void_envelope` | **Asks first.** Cancels once you approve |
| `remind` | Reminds whoever's turn it is |
| `download_link` | Where to get a signed PDF |
| `whats_new`, `my_notifications`, `request_role_change`, `check_approval` | From the base app |

Revoke a key in **Agents** and it stops at once. Every call is in the key's activity log.

## Built in

- **Signing from any device**: guided fields with **Next field**, typed, drawn or uploaded signatures, keyboard-only signing, and a phone layout. Signers never make an account.
- **Ordered or parallel signing**, approvers, viewers, and people who only get a copy. Each person can be asked for an access code or an emailed code.
- **Sealed final PDFs**: fields flattened onto the page, a certificate of completion with each party's consent, IP, device and times, and the hash-chained audit trail. With your own certificate set, also an embedded digital signature PDF readers check.
- **Read a sent document in the app**: the signed copy with its certificate pages, or the original, with zoom. Each party can read their signed copy from their download link too. With email off, the sender (or an admin) copies each party's link from the document's page.
- **Verify a PDF**: anyone checks a file against completed documents by its SHA-256, without uploading it.
- **Reminders, deadlines, corrections and cancelling**, on a one-minute sweep.
- **Templates, bulk sending from CSV, public signing links**, self-signing and signing in person.
- **REST API and webhooks** under Developers. **MCP tools** under Agents.
- From the base app: live updates and who's here, notifications, ⌘K and shortcuts, the assistant (it reads your documents and templates), invites and password resets, and settings.

## How auth works

Team members sign in with `@xano-sdk/auth` (email and password, or one click as a demo person while demo mode is on). Roles come from `@xano-sdk/rbac` in [`xano/rbac.ts`](xano/rbac.ts):

| Permission | admin | member | viewer |
|---|---|---|---|
| Prepare and send documents, use templates | ✓ | ✓ | |
| Read the team's documents | ✓ | ✓ | ✓ |
| Read every document, private ones included | ✓ | | |
| Make and edit templates | ✓ | ✓ | |
| Branding, email, defaults, disclosure, retention | ✓ | | |
| API keys and webhooks | ✓ | | |
| Manage the team | ✓ | | |

A person's own documents are always theirs. A document is **private** (the sender and admins) or shared with **the team**.

Signers are not users. Each signing link carries a random token, stored only as its SHA-256. Opening it, passing the identity check and agreeing to the disclosure mints a 30-minute signer session on the `recipient` table, tied to that person's current round: correcting their details, resending or cancelling ends every older link and session at once. Public routes are rate-limited per IP and per link.

Removing someone from the team ends their sessions and API keys immediately; their documents stay. API keys are long-lived tokens on their own table, act with their maker's current role, and are refused once revoked.

## API surface

The app's screens use these groups (signed in): `documents`, `envelopes`, `templates`, `email`, `org`, `developer`, plus the base app's. The public and machine groups:

| Verb · path | Who may call it | Enforces |
|---|---|---|
| `POST /api:sign/sign/open` · `code` · `identity` · `consent` | Anyone with a signing link | Token hash, round, identity, consent, rate limits |
| `/api:signing/signing/*` | A signer session | The signer gate: round, status, whose turn |
| `POST /api:final/sign/final` · `final/raw` | A party's download link | Token hash, rate limit |
| `POST /api:verify/verify`, `GET /api:verify/brand` | Anyone | Fingerprint only; names signers only with the document ID |
| `/api:public/public/{slug}` · `start` · `verify` | Anyone with a public link | Link on, emailed code, 3 codes per address per hour |
| `/api:api/v1/*` | An API key | The key's maker's current role |
| `POST /api:email_hooks/resend` | Resend | Svix signature with `RESEND_WEBHOOK_SECRET` |
| `/api:seal/seal/{id}/*` | The seal's own lambda | A one-time seal key per envelope |

The REST API, with `Authorization: Bearer <API key>`:

| Verb · path | Does |
|---|---|
| `GET /v1/envelopes?segment=&q=` | Your documents |
| `GET /v1/envelopes/{id}` | One document with its people, emails and trail |
| `GET /v1/templates` | Templates and roles |
| `POST /v1/templates/{id}/send` | Send a template: `people: [{ role_id, name, email }]` |
| `POST /v1/envelopes/{id}/remind` | Remind a recipient |
| `POST /v1/envelopes/{id}/void` | Cancel, with a reason |
| `GET /v1/envelopes/{id}/signed_pdf` | The signed PDF |

Webhooks are signed `X-Countersign-Signature: t=<unix>,v1=<hex>`, the HMAC-SHA256 of `<t>.<raw body>` with the endpoint's secret. Events: `envelope.sent`, `envelope.completed`, `envelope.declined`, `envelope.voided`, `envelope.expired`, `recipient.opened`, `recipient.signed`, `recipient.declined`. A failed delivery is tried five times over about three hours.

## Connect email

Countersign sends invitations, reminders, codes and signed copies through [Resend](https://resend.com).

1. Make a Resend account, add your domain, and add the DNS records it shows (SPF and DKIM) so mail isn't marked as spam.
2. Make an API key, and set the backend's environment: `RESEND_API_KEY`, and `RESEND_FROM` as an address on that domain (`signing@yourcompany.com`).
3. In Resend, add a webhook to `<backend URL>/api:email_hooks/resend` for delivered, bounced and complained events, and set its signing secret as `RESEND_WEBHOOK_SECRET`. Without it, email works but delivery tracking is off.
4. Put the same values in `xano/.env` so a later deploy doesn't clear them, then **Settings → Organisation → Send me a test**.

Until then nothing is emailed: each person's signing link is shown to the sender to share, and the signing pages say so. Once a document is complete, the sender copies each party's link to their signed copy the same way. Public signing links need email, because visitors prove their address with a code.

**Demo mode** (on in the seed) only emails people on your team, never the addresses in the demo documents. Turn it off in **Settings → Organisation → Data** before real use.

## Is this legally binding?

Countersign makes a **simple electronic signature** (SES): a signer shows intent by adopting a signature and agreeing to sign electronically, after reading a consent disclosure you control. In many places, including under the US ESIGN Act and UETA and the EU's eIDAS regulation, an SES is valid for most everyday agreements: leases, offer letters, NDAs, vendor contracts. It is not a qualified or advanced signature, and some documents (wills, some real estate deeds, court filings) need more. Check what applies to yours.

What makes a signed document hold up is evidence, and Countersign keeps it:

- **An audit trail you can't quietly edit.** Every event is chained to the one before by SHA-256; changing any row breaks every hash after it, and each document page says whether its chain is intact.
- **A certificate in the PDF**, with each party's consent and disclosure version, IP address, device, and when they were sent, opened and signed.
- **An independent anchor.** The final PDF's fingerprint is in every party's completion email, so the file can be checked on the verify page against what each party received, not only against this database.

## Digital signatures

There are two different things people mean by "signed", and Countersign does the first always and the second when you set it up.

**An electronic signature** is a person showing they agree: here, adopting a signature and agreeing to sign electronically. That's what every signer does, and it's what the law above is about.

**A digital signature** is cryptography *in the PDF file*: a certificate's signature over the file's bytes, which a PDF reader checks on its own. It protects the file, not the person's intent.

| | Without a certificate (default) | With your certificate | What it can't do |
|---|---|---|---|
| Who signs the file | Nobody: the file isn't digitally signed | Your organisation (the seal), not each signer | Signers never hold certificates of their own |
| Proof the file is unchanged | Its SHA-256 fingerprint, in every party's email and on the verify page | That, plus a signature any PDF reader checks with no internet | The signing time is the server's clock, with no trusted timestamp |
| Adobe Acrobat / Preview | No signature panel | A self-made certificate: a yellow "signer's identity is unknown". A certificate on the Adobe Approved Trust List: the blue "signed and all signatures are valid" bar | No long-term validation data (LTV) |
| Legal level | Simple electronic signature (SES) | Still SES, with stronger evidence | Not an advanced (AdES) or qualified (QES) signature under eIDAS |

### Turn on digital signing

Set these backend environment values in `xano/.env`, so every deploy sends them. `npx xanosdk env set` changes one on a running backend, but the next deploy replaces it with what `xano/.env` has.

| Name | Value |
|---|---|
| `SIGNING_KEY` | The private key as unencrypted PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), RSA or EC P-256/P-384, or that PEM base64-encoded on one line |
| `SIGNING_CERT` | Its certificate, as PEM (or base64 of the PEM) |
| `SIGNING_CHAIN` | Optional: any intermediate certificates, as PEM (or base64 of the PEM) |

Every document sealed from then on carries the signature; documents sealed before stay as they were. **Settings → Organisation → Document signing** shows the certificate in use, who issued it, whether the key can be read, and when it expires. The certificate page in each signed PDF says whether the file is digitally signed, and as whom.

**To try it with a test certificate** (free, signer shown as unknown):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=Your Company (test)/O=Your Company"
echo "SIGNING_KEY=$(base64 -i key.pem | tr -d '\n')" >> xano/.env
echo "SIGNING_CERT=$(base64 -i cert.pem | tr -d '\n')" >> xano/.env
npm run xano:deploy
```

A key from `openssl genrsa` or an older tool (`-----BEGIN RSA PRIVATE KEY-----`) converts with `openssl pkcs8 -topk8 -nocrypt -in old.pem -out key.pem`. A `.p12`/`.pfx` file converts with `openssl pkcs12 -in cert.p12 -nodes -nocerts | openssl pkcs8 -topk8 -nocrypt -out key.pem` and `openssl pkcs12 -in cert.p12 -nokeys -clcerts -out cert.pem`.

**For Adobe's trusted "signed" bar,** buy a document-signing certificate from a certificate authority on the [Adobe Approved Trust List](https://helpx.adobe.com/acrobat/kb/approved-trust-list1.html) (GlobalSign, DigiCert, Entrust and others), issued to your organisation after they verify it. Most now require the private key to live in hardware or a cloud key service and never leave it. Countersign signs with a key it's given, so with those you'd either use a provider that issues an exportable key, or change the seal (`xano/lambdas/seal.ts`, the `cms` step) to send the document's digest to your provider's signing API instead of signing it here. This template doesn't come with such a certificate.

**For advanced or qualified electronic signatures (eIDAS),** each signer's identity must be verified and their signature made with a certificate issued to them, by a qualified trust service provider. That's a different product: integrate a provider's signing flow per signer rather than sealing with one organisation certificate.

What protects every signed document either way: the hash-chained audit trail, the certificate pages, and the fingerprint in each party's completion email, which they can check on the verify page without trusting your database.

## Repo layout

| Yours to change | |
|---|---|
| [`xano/app.ts`](xano/app.ts) | Name, roles, demo people |
| [`xano/domain.ts`](xano/domain.ts) | Everything the backend registers |
| [`xano/rbac.ts`](xano/rbac.ts), [`xano/approvals.ts`](xano/approvals.ts) | Permissions; what agents ask before doing |
| [`xano/table/`](xano/table/), [`xano/function/`](xano/function/), [`xano/query/`](xano/query/) | Tables, the shared functions every route calls, the routes |
| [`xano/lambdas/seal.ts`](xano/lambdas/seal.ts) | The seal: flattening fields and the certificate |
| [`xano/world.ts`](xano/world.ts), [`xano/seed-files/`](xano/seed-files/) | The demo; `frontend/scripts/make-seed-files.mjs` remakes its PDFs |
| [`xano/agents/`](xano/agents/) | MCP and assistant tools |
| [`frontend/src/app.config.tsx`](frontend/src/app.config.tsx), `lib/`, `pages/`, `components/` | Screens and their data |

The base app is [`xano/base`](xano/base/), [`frontend/src/base`](frontend/src/base/) and [`frontend/src/components/kit`](frontend/src/components/kit/).

## Extend it

### Add a field type

Say a "phone number" field:

1. Add `"phone"` to `FIELD_TYPES` in [`xano/table/envelope/field.ts`](xano/table/envelope/field.ts), and its check to `fillField` in [`xano/function/signing/sign.ts`](xano/function/signing/sign.ts) (like `number`).
2. Add it to `PALETTE` and `FIELD_LABEL` in [`frontend/src/pages/prepare/model.ts`](frontend/src/pages/prepare/model.ts) and [`frontend/src/lib/envelopes.ts`](frontend/src/lib/envelopes.ts), with an icon in `fields.tsx`.
3. The signing page shows it as a text input already; give it `inputMode="tel"` in `FieldWidget`.
4. The seal draws any field's value as text. `npm run xano:deploy -- --test` runs the workflow tests.

### Add a role

Add it to `ROLES` in [`xano/app.ts`](xano/app.ts), grant its permissions in [`xano/rbac.ts`](xano/rbac.ts), and name it in `permissionLabels` in [`frontend/src/app.config.tsx`](frontend/src/app.config.tsx).

### Send from your own app

Make a template, make an API key under Developers, and `POST /api:api/v1/templates/{id}/send`. Add a webhook for `envelope.completed` to hear when it's done.

## Going to production

- **Turn off demo mode** in Settings → Organisation → Data, and **Clear demo data**. Remove the demo people from `DEMO_PEOPLE` in [`xano/app.ts`](xano/app.ts).
- **Connect email** ([above](#connect-email)), with keys in `xano/.env`.
- **Signed file storage** is used automatically on Xano's cloud; on the Engine files are kept in the database (5 MB per document).
- Set `MCP_OAUTH_LOGIN_URL` after the first cloud deploy, so ChatGPT and Claude can sign in.
- Choose a **retention** period, and review the consent disclosure with your lawyer.
- Decide whether sealed PDFs should be **digitally signed**, and with which certificate ([Digital signatures](#digital-signatures)).
- Cut a release: `npx xanosdk release create`, then `npx xanosdk promote`.

## Where it runs

Countersign runs on the Xano Engine (local) and on Xano's cloud. Sending, signing, sealing, verify, templates, bulk send, the API, webhooks and the MCP tools work on both.

- **Real email and public signing links** need a Resend key. See [Connect email](#connect-email).
- **ChatGPT and Claude sign-in** and **signed file storage** need a cloud deploy. On the Engine, files are kept in the database.
- **Digital signing** works with any PKCS#8 RSA or EC P-256/P-384 key and its certificate. The signature is a standard detached CMS (`adbe.pkcs7.detached`) that PDF readers check.
- **Adobe's trusted "signed" bar** needs a certificate on Adobe's Approved Trust List.

## Limits

- **Simple electronic signatures only**: no ID verification, and no advanced or qualified signatures. Sealed PDFs carry an embedded digital signature only when you set your own certificate, without a trusted timestamp ([Digital signatures](#digital-signatures)).
- **PDFs up to 5 MB on the Engine** and 15 MB on Xano's cloud; up to 20 people and 300 fields a document; bulk sends of 500 rows.
- **Fields sit on the page as placed**: no conditional fields, formulas or attachments.
- **The export is a CSV of every document's record**; signed PDFs download one at a time or as a ZIP per document.

## Run it and test it

```sh
npm run xano:deploy -- --test      # deploy with the workflow tests
npm test                           # frontend unit tests
```

Then, against the running backend (`--frontend` is the app's address, for links the checks open):

| Check | What it proves |
|---|---|
| `node frontend/scripts/first-run-check.mjs --backend <url>` | On a fresh demo: every trail verifies, the signed documents seal, a sealed file matches its fingerprint and the verify page, the demo signer's page opens, Jordan's countersignature seals |
| `node frontend/scripts/sign-flow-check.mjs --backend <url>` | Send, identity codes, consent, ordered signing, decline, correction, seal and verify, over HTTP |
| `node frontend/scripts/keyboard-sign-check.mjs --backend <url> --frontend <url>` | A whole document signed with the keyboard alone, phone-sized, in dark mode (needs Chrome, or `CHROME_PATH`) |
| `node frontend/scripts/templates-check.mjs --backend <url>` | Self-signing, in-person signing, templates, bulk send, public links |
| `node frontend/scripts/developer-check.mjs --backend <url>` | API keys and signed webhooks, with a real receiver (local Engine) |
| `node frontend/scripts/mcp-check.mjs --backend <url>` | The MCP tools, and sending that waits for approval |
| `node frontend/scripts/upload-check.mjs --backend <url>` | Upload limits, bad files, retries |
| `node frontend/scripts/email-hook-check.mjs --backend <url> --secret <whsec_...>` | The Resend webhook takes a correctly signed event and refuses a changed body, a wrong signature, an old timestamp and missing headers (use the backend's `RESEND_WEBHOOK_SECRET`) |

## FAQ

**Why do signers not need an account?** Their link is the credential, like a password reset link, and the identity check (an access code or an emailed code) adds a second factor when you need one.

**Can I change a document after sending it?** Correct a person's name or email, extend the deadline, or cancel it and send a new one. The document itself is fixed once sent, so what each person signed is what everyone else saw.

**Where are the PDFs kept?** In Xano's private file storage on the cloud (short signed links), or in the database on the Engine. The sealed PDF's fingerprint is kept with the document and in each party's email.

**Will Adobe show the PDF as signed?** Not by default: sealed PDFs are protected by their fingerprint and the verify page, and Adobe shows no signature panel. Set your own certificate and Adobe shows a signature: as "unknown signer" with a self-made one, and as trusted with a certificate on Adobe's trust list. See [Digital signatures](#digital-signatures).

## Built with

[Xano](https://xano.com) and the [Xano SDK](https://github.com/xano-sdk/sdk), `@xano-sdk/auth`, `@xano-sdk/rbac`, `@xano-sdk/agents`, `@xano-sdk/chatbot`, `@xano-sdk/mcp-oauth`, [pdf-lib](https://pdf-lib.js.org) and fontkit for sealing, [PDF.js](https://mozilla.github.io/pdf.js/) through react-pdf for viewing, [Resend](https://resend.com) for email, [Noto Sans](https://fonts.google.com/noto) in certificates (SIL Open Font License, see [`xano/seed-files/OFL.txt`](xano/seed-files/OFL.txt)), and Mrs Saint Delafield, Homemade Apple and Caveat from [Fontsource](https://fontsource.org) for typed signatures (OFL and Apache 2.0).
