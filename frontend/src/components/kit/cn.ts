// The project's `cn` (Vite and tsconfig alias the bare "cn" import here, so shadcn's primitives use it too).
// tailwind-merge's rules plus the kit's six type roles (kit.css): without them `text-body`, `text-caption`, …
// read as COLOURS, so `cn("text-body", "text-muted-foreground")` dropped the size and the text fell back to 16 px.
import { createCn, createTwMerge } from "cn/config";
import { clsx } from "cn/lite";

const roles = { extend: { classGroups: { "font-size": [{ text: ["metric", "title", "heading", "body", "caption", "micro"] }] } } };

export const cn = createCn(roles);
export const twMerge = createTwMerge(roles);
export { clsx };
export const twJoin = (...parts: (string | false | null | undefined | 0)[]) => parts.filter(Boolean).join(" ");
export type ClassValue = Parameters<typeof cn>[number];
