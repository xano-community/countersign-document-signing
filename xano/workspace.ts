// Workspace settings: the env names this backend reads. Values live in xano/.env (never committed) or are set on a
// deployed backend with `npx @xano/sdk env set NAME`. Every one is optional: with none set, the app runs, and email
// waits as copyable signing links until Resend is connected (Settings, Email).
import { workspaceConfig } from "@xano/sdk";

export const workspaceSettings = workspaceConfig({
  name: "countersign",
  env: {
    MCP_OAUTH_LOGIN_URL: "",
    // The token that lets the first admin set up a production deploy. Empty: setup is off.
    SETUP_TOKEN: "",
    // Resend: an API key, and the From address on a domain verified in Resend ("Countersign <sign@yourco.com>").
    RESEND_API_KEY: "",
    RESEND_FROM: "",
    // The signing secret of the Resend webhook (whsec_…), for delivered, bounced and complained states.
    RESEND_WEBHOOK_SECRET: "",
    // Optional digital signing of sealed PDFs (README, "Digital signatures"): a PKCS#8 private key and its certificate, as PEM
    // (or base64 of the PEM), and any intermediate certificates. Empty: documents are sealed without an embedded signature.
    SIGNING_KEY: "",
    SIGNING_CERT: "",
    SIGNING_CHAIN: "",
  },
});
