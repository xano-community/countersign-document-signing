// A list's sort, from the URL to the database (CRAFT.md §16 "A list"): the endpoint takes `sort` as text ("due",
// "-due") and maps it through an ALLOWLIST to the query's runtime order. Never pass a client's sort object straight
// to the query: it could order by any column (a password hash, a token), and ordering alone leaks.
//
//   const order = listSort({ title: "title", priority: "priority", due: "due_on", created: "created_at" });
//   query({ input: { …, sort: input.text() }, stack: [ …order.stack, s.db.query({ …,
//     paging: { page: inp("page"), per_page: ref("size"), totals: true, sort: order.value } }) ] })
import { c, expr, inp, ref, s, type Statement } from "@xano/sdk";

type Order = { sortBy: string; orderBy: "asc" | "desc" }[];

/**
 * `keys` maps each sort name the screen sends to a column of the queried table (bare, not "table.col").
 * "-<name>" sorts descending. Every order ends on `id` so pages never shuffle rows with equal values.
 * The fallback (an empty or unknown `sort`) is newest first.
 */
export function listSort(keys: Record<string, string>, opts: { input?: string; fallback?: Order; as?: string } = {}) {
  const input = opts.input ?? "sort";
  const as = opts.as ?? "list_order";
  const fallback: Order = opts.fallback ?? [{ sortBy: "id", orderBy: "desc" }];
  const tie = (dir: "asc" | "desc"): Order => [{ sortBy: "id", orderBy: dir }];
  const stack: Statement[] = [s.set_var(as, c.array(fallback))];
  for (const [name, column] of Object.entries(keys)) {
    for (const dir of ["asc", "desc"] as const) {
      const order: Order = [{ sortBy: column, orderBy: dir }, ...(column === "id" ? [] : tie(dir))];
      stack.push(s.conditional({ when: expr(inp(input), "=", c.text(dir === "desc" ? `-${name}` : name)), then: [s.update_var(as, c.array(order))] }));
    }
  }
  return { stack, value: ref(as) };
}
