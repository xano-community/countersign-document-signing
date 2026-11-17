// A model picks a tool by reading every tool it's offered, so the list stays short. A new record type extends a `save_*` input or
// `read_record`'s list, and doesn't add a tool.
export const MOST_TOOLS = 12;

/** Stops the build if the MCP servers offer too many tools. Runs on every export, so a deploy can't get past it. */
export function withinToolLimit<T extends { name: string }>(tools: T[]): T[] {
  if (tools.length > MOST_TOOLS) throw new Error(`The MCP servers offer ${tools.length} tools, and the limit is ${MOST_TOOLS}: ${tools.map((t) => t.name).join(", ")}. Extend an existing tool's input instead of adding one.`);
  return tools;
}
