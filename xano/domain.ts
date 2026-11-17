// The template's own backend: its tables, functions, endpoints, agent tools and assistant tools (BASELINE.md).
// xano/index.ts registers everything listed here, beside the base app and the modules. Put each def in its own
// file (table/<name>.ts, query/<group>.ts, query/<group>/<name>.ts, function/<name>.ts) and list it below.
//
// Every endpoint or tool that writes one of these tables calls `changed(...)` from ./base/index.js in the same
// stack, so open screens update live and the activity feed records it (audit-bundle.mjs checks).

import { envelope } from "./table/envelope/envelope.js";
import { recipient } from "./table/envelope/recipient.js";
import { field } from "./table/envelope/field.js";
import { public_link } from "./table/envelope/public_link.js";
import { bulk_send, bulk_send_row } from "./table/envelope/bulk_send.js";
import { purged_envelope } from "./table/envelope/purged_envelope.js";
import { org_setting } from "./table/envelope/org_setting.js";
import { signature } from "./table/signing/signature.js";
import { signing_link } from "./table/signing/signing_link.js";
import { audit_event } from "./table/signing/audit_event.js";
import { otp_code } from "./table/signing/otp_code.js";
import { rate_bucket } from "./table/signing/rate_bucket.js";
import { disclosure } from "./table/signing/disclosure.js";
import { email_outbox } from "./table/email/email_outbox.js";
import { api_key, api_key_use } from "./table/developer/api_key.js";
import { webhook_delivery, webhook_endpoint } from "./table/developer/webhook.js";
import { document_blob, document_file } from "./table/files/document_file.js";
import { vendor } from "./table/files/vendor.js";
import { appendFn, verifyFn } from "./function/audit/audit.js";
import { envelopeTransition, recipientTransition } from "./function/envelope/transition.js";
import { saveFields, saveRecipients, sendProblems, updateDraft } from "./function/envelope/draft.js";
import { documentFunctions } from "./function/documents/documents.js";
import { canRead } from "./function/envelope/access.js";
import { createFunctions } from "./function/envelope/create.js";
import { documentQueries, documentsGroup } from "./query/documents.js";
import { documentTests, vendorFixture } from "./test/documents.js";
import { emailStatusFn } from "./function/email/status.js";
import { enqueueFn } from "./function/email/outbox.js";
import { drainFunctions } from "./function/email/drain.js";
import { layoutFn } from "./function/email/layout.js";
import { renderFn } from "./function/email/templates.js";
import { hookFunctions } from "./function/email/hooks.js";
import { linkFunctions } from "./function/signing/links.js";
import { rememberUrlsFn } from "./function/settings/app_url.js";
import { emailGroup, emailQueries } from "./query/email.js";
import { emailHookQueries, emailHooksGroup } from "./query/email_hooks.js";
import { tasks as sweepTasks } from "./tasks/sweep.js";
import { emailTests } from "./test/email.js";
import { hitFn } from "./function/rate/limit.js";
import { sendFunctions } from "./function/envelope/send.js";
import { manageFunctions } from "./function/envelope/manage.js";
import { listFunctions } from "./function/envelope/list.js";
import { prepareView } from "./function/envelope/view.js";
import { openFunctions } from "./function/signing/open.js";
import { signFunctions, signerGate } from "./function/signing/sign.js";
import { envelopeQueries, envelopesGroup } from "./query/envelopes.js";
import { signGroup, signingGroup, signQueries } from "./query/sign.js";
import { sealFunctions } from "./function/seal/build.js";
import { sealFileFunctions } from "./function/seal/files.js";
import { sealApiGroups, sealQueries } from "./query/seal.js";
import { sealTests, sealVendorFixture } from "./test/seal.js";
import { lifecycleTests } from "./test/lifecycle.js";
import { draftTests } from "./test/draft.js";
import { manageTests } from "./test/manage.js";
import { templateFunctions } from "./function/templates/templates.js";
import { publicFunctions } from "./function/templates/public.js";
import { bulkFunctions } from "./function/templates/bulk.js";
import { publicGroup, templateQueries, templatesGroup } from "./query/templates.js";
import { templateTests } from "./test/templates.js";
import { hostFunctions } from "./function/envelope/host.js";
import { hostTests } from "./test/host.js";
import { countersignTools } from "./agents/tools.js";
import { COUNTERSIGN_PROMPT, countersignAssistantTools } from "./agents/assistant.js";
import { developerTests } from "./test/developer.js";
import { orgFunctions } from "./function/settings/org.js";
import { orgGroup, orgQueries } from "./query/settings.js";
import { purgeDaily } from "./tasks/purge.js";
import { settingsTests } from "./test/settings.js";
import { worldFunctions } from "./function/demo/world.js";
import { keyFunctions } from "./function/developer/keys.js";
import { webhookFunctions } from "./function/developer/webhooks.js";
import { apiQueries, apiV1Group, developerGroup, developerQueries } from "./query/developer.js";

export const middlewares = [signerGate];
export const tables = [
  org_setting, envelope, recipient, field, public_link, bulk_send, bulk_send_row, purged_envelope,
  signature, signing_link, audit_event, otp_code, rate_bucket, disclosure, email_outbox,
  api_key, api_key_use, webhook_endpoint, webhook_delivery, document_file, document_blob, vendor,
];
export const functions = [appendFn, verifyFn, envelopeTransition, recipientTransition, updateDraft, saveRecipients, saveFields, sendProblems, canRead, ...documentFunctions, ...createFunctions, vendorFixture,
  emailStatusFn, enqueueFn, ...drainFunctions, layoutFn, renderFn, ...hookFunctions, ...linkFunctions, rememberUrlsFn, hitFn,
  ...sendFunctions, ...manageFunctions, ...listFunctions, prepareView, ...openFunctions, ...signFunctions,
  ...sealFunctions, ...sealFileFunctions, sealVendorFixture, ...templateFunctions, ...publicFunctions, ...bulkFunctions, ...hostFunctions, ...keyFunctions, ...webhookFunctions, ...orgFunctions, ...worldFunctions];
export const workflowTests = [...lifecycleTests, ...draftTests, ...documentTests, ...emailTests, ...manageTests, ...sealTests, ...templateTests, ...hostTests, ...developerTests, ...settingsTests];
export const tasks = [...sweepTasks, purgeDaily];
export const apiGroups = [documentsGroup, emailGroup, emailHooksGroup, envelopesGroup, signGroup, signingGroup, ...sealApiGroups, templatesGroup, publicGroup, developerGroup, apiV1Group, orgGroup];
export const queries = [...documentQueries, ...emailQueries, ...emailHookQueries, ...envelopeQueries, ...signQueries, ...sealQueries, ...templateQueries, ...developerQueries, ...apiQueries, ...orgQueries];

/** MCP tools (AGENT-ACCESS.md §2): `agent.tool({...})` defs. index.ts adds `approvals.checkTool("mcp")`. */
export const agentTools = countersignTools;
export const agentPrompts = [];
export const agentResources = [];

/** The assistant's domain tools (CHATBOT.md §1): `tool({...})` defs. The base adds what-changed and notifications. */
export const assistantTools = countersignAssistantTools;

/** The domain half of the assistant's system prompt: what the app is, its records and roles, which tool when. */
export const assistantPrompt = COUNTERSIGN_PROMPT;
