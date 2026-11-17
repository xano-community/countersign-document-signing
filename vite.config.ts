import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// One chunk per library, so a change to one doesn't invalidate the rest of a returning visitor's cache, and a library only
// the lazy routes use stays out of the shell (CRAFT.md §13). Radix primitives only forms, confirmations and menus use stay
// out of the shell's radix chunk.
const RADIX_LAZY = /@radix-ui\/react-(select|checkbox|alert-dialog|dropdown-menu|menu|roving-focus|collection)\//;
const LIBRARY = /node_modules\/((?:@[^/]+\/)?[^/]+)\//;
const GROUPS: Record<string, string> = {
  scheduler: "react-dom", "react-dom": "react-dom", react: "react",
  "@floating-ui/core": "floating-ui", "@floating-ui/dom": "floating-ui", "@floating-ui/react-dom": "floating-ui", "@floating-ui/utils": "floating-ui",
  "react-remove-scroll": "radix", "react-remove-scroll-bar": "radix", "react-style-singleton": "radix", "use-callback-ref": "radix", "use-sidecar": "radix", "aria-hidden": "radix", "radix-ui": "radix",
};
function libraryChunk(id: string) {
  const name = id.match(LIBRARY)?.[1];
  if (!name) return undefined;
  if (RADIX_LAZY.test(id)) return "radix-forms";
  if (name.startsWith("@radix-ui/")) return "radix";
  return (GROUPS[name] ?? name).replace(/^@/, "").replace("/", "-");
}

// Vite's root is the frontend/ folder, so index.html and the app live there
// while the Xano SDK backend sits in xano/ as a peer. The build lands in
// frontend/dist, which `npm run xano:deploy:ephemeral` ships as the static frontend.
export default defineConfig({
  root: "frontend",
  // Vite resolves `.env` files against `root`, which is frontend/ here — but
  // `.env.example` sits at the project root, so that is where anyone will
  // actually put their `.env.local`. Point envDir back at this file's own
  // directory so VITE_XANO_HOST is picked up in dev.
  envDir: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // The app's own modules have no side effects but their CSS, so a screen that takes one thing from the kit's index
      // doesn't carry the rest of the kit into its chunk (the shell included).
      treeshake: { moduleSideEffects: (id: string, external: boolean) => external || id.includes("/node_modules/") || /\.css(\?|$)/.test(id) },
      output: {
        // One chunk per library, so the shell carries only what it imports, and the PDF viewer, PDF writer, drag-and-drop and
        // handwriting fonts load with the screens that use them.
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [{ test: /node_modules/, name: libraryChunk }],
        },
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // The alias the UI kit writes its imports against. Resolved from this
      // file rather than from Vite's root so it points at the right directory
      // either way. Keep in sync with the `paths` entry in tsconfig.json.
      { find: "@", replacement: fileURLToPath(new URL("./frontend/src", import.meta.url)) },
      // The kit's cn (its type roles merge as font sizes): every bare "cn" import, the shadcn primitives' included.
      { find: /^cn$/, replacement: fileURLToPath(new URL("./frontend/src/components/kit/cn.ts", import.meta.url)) },
    ],
  },
  server: { host: "127.0.0.1", port: 5173 },
});
