// The app's frontend config (BASELINE.md): its name and icon, its screens, its nav, its ⌘K actions and record
// search, its permissions in plain words, and its assistant. The base app (src/base) builds everything else from it:
// sign-in, the shell, notifications, activity, settings, profile, team + invites, agents, approvals, live updates.
import { Code2, FilePlus2, FileSignature, LayoutTemplate, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router";
import { useCan } from "@xano-sdk/rbac/react";
import { page, type AppConfig } from "@/base/app";
import { envelopesApi } from "@/lib/envelopes";
import { DemoSignerButton } from "./pages/public/demo-signer";

export const config: AppConfig = {
  name: "Countersign",
  icon: FileSignature,
  tagline: "Pick a person to try it as, or sign in with your account.",
  signInExtra: DemoSignerButton,

  // The domain's screens. "/" is Documents. Each is lazy, so it loads on its own.
  routes: [
    { path: "/", lazy: page(() => import("./pages/documents/list"), "DocumentsPage") },
    { path: "/documents/new", lazy: page(() => import("./pages/documents/new"), "NewDocumentPage") },
    { path: "/documents/:id/prepare", lazy: page(() => import("./pages/prepare/prepare"), "PreparePage"), handle: { wide: true } },
    { path: "/documents/:id/view", lazy: page(() => import("./pages/documents/view"), "DocumentViewPage"), handle: { wide: true } },
    { path: "/documents/:id", lazy: page(() => import("./pages/documents/detail"), "DocumentDetailPage") },
    { path: "/templates", lazy: page(() => import("./pages/templates/templates"), "TemplatesPage") },
    { path: "/templates/:id/bulk", lazy: page(() => import("./pages/templates/bulk"), "BulkSendPage") },
    { path: "/bulk/:id", lazy: page(() => import("./pages/templates/bulk"), "BulkProgressPage") },
    { path: "/verify-pdf", lazy: page(() => import("./pages/public/public-pages"), "VerifyInAppPage") },
    { path: "/developer", lazy: page(() => import("./pages/developer/developer"), "DeveloperPage") },
    { path: "/settings/organisation", lazy: page(() => import("./pages/settings/organisation"), "OrganisationPage") },
  ],

  // Pages a recipient or anyone else opens without signing in.
  publicRoutes: [
    { path: "/sign/:token", lazy: page(() => import("./pages/sign/sign-page"), "SignPage") },
    { path: "/signed/:token", lazy: page(() => import("./pages/public/public-pages"), "SignedCopyPage") },
    { path: "/verify", lazy: page(() => import("./pages/public/public-pages"), "VerifyPage") },
    { path: "/p/:slug", lazy: page(() => import("./pages/public/start-page"), "PublicStartPage") },
  ],

  // The sidebar's first groups. `primary: true` puts an item in the phone's bottom bar (3 or 4 at most).
  useNav: () => {
    const canSend = useCan("envelope.send");
    const canDevelop = useCan("developer.manage");
    return [
      { items: [
        { href: "/", label: "Documents", icon: FileSignature, primary: true, exact: true },
        ...(canSend ? [{ href: "/documents/new", label: "New document", icon: FilePlus2, primary: true }] : []),
        { href: "/templates", label: "Templates", icon: LayoutTemplate },
        { href: "/verify-pdf", label: "Verify a PDF", icon: ShieldCheck },
        ...(canDevelop ? [{ href: "/developer", label: "Developers", icon: Code2 }] : []),
      ] },
    ];
  },

  // ⌘K: the domain's actions, and documents found as you type.
  usePaletteActions: () => {
    const canSend = useCan("envelope.send");
    const navigate = useNavigate();
    return canSend ? [
      { id: "new-document", label: "New document", group: "Actions", icon: FilePlus2, keywords: ["upload", "send", "sign"], run: () => navigate("/documents/new") },
      { id: "templates", label: "Use a template", group: "Actions", icon: LayoutTemplate, keywords: ["template", "bulk", "public link"], run: () => navigate("/templates") },
    ] : [];
  },
  search: async (q, go) => {
    const found = await envelopesApi.list({ segment: "all", q });
    return found.items.slice(0, 8).map((e) => ({
      id: `doc-${e.id}`, label: e.title, icon: FileSignature, group: "Documents", hint: e.sender_name ?? undefined,
      run: () => go(e.status === "draft" ? `/documents/${e.id}/prepare` : `/documents/${e.id}`),
    }));
  },

  // Each permission in xano/rbac.ts, in the app's words: Team and Profile say "Admins can manage the team".
  permissionLabels: {
    "envelope.send": "prepare and send documents",
    "envelope.read_team": "read the team's documents",
    "envelope.read_all": "read every document, private ones included",
    "template.manage": "manage templates",
    "settings.manage": "change branding, email and retention",
    "developer.manage": "manage API keys and webhooks",
    "team.manage": "manage the team",
  },

  assistant: {
    name: "Assistant",
    welcome: "Ask what's waiting on you, or where a document stands.",
    suggestions: ["What's waiting for me?", "What changed today?"],
  },
};
