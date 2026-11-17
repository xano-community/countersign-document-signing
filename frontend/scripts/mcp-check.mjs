#!/usr/bin/env node
// The MCP tools as an AI client calls them: the tool list stays at 12 or fewer, reads work as the person who connected, and
// sending from a template waits for that person's approval, then sends once.
//
//   node frontend/scripts/mcp-check.mjs --backend <url>
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.

import { backend, frontend, needBackend } from "./check-lib.mjs";

needBackend("mcp-check.mjs");
const B = backend, APP = frontend;
const api = async (verb, path, body, token) => {
  const h = { accept: "application/json" }; if (token) h.authorization = `Bearer ${token}`; if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(B + path, { method: verb, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => null) };
};
const ok = (c, m) => { console.log(c ? "PASS " : "FAIL ", m); if (!c) process.exitCode = 1; };
process.on("exit", (code) => console.log(code ? "\nsome checks failed" : "\nall passed"));
const jordan = (await api("POST", "/api:authn/auth/demo", { persona: "jordan" })).j.authToken;
const conn = await api("POST", "/api:agent/agent/connections", { name: "MCP check", scope: "read_write", days: 7 }, jordan);
const key = conn.j?.key ?? conn.j?.token ?? conn.j?.api_key;
if (!key) { console.log("connection answer:", conn.status, JSON.stringify(conn.j).slice(0, 300)); process.exit(1); }
let n = 0;
const mcp = async (method, params) => {
  const r = await fetch(`${B}/x2/mcp/countersign-mcp/mcp/stream`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
  const t = await r.text(); const line = t.split("\n").find((l) => l.startsWith("data:")); const j = JSON.parse(line ? line.slice(5) : t);
  return j;
};
const tools = await mcp("tools/list", {});
const names = tools.result?.tools?.map((t) => t.name) ?? [];
ok(names.length <= 12 && names.includes("send_from_template"), `${names.length} tools: ${names.join(", ")}`);
const call = async (name, args) => { const r = await mcp("tools/call", { name, arguments: args }); const txt = r.result?.content?.[0]?.text; try { return { err: r.result?.isError || r.error, body: JSON.parse(txt) }; } catch { return { err: r.result?.isError || r.error, body: txt }; } };
const docs = await call("list_envelopes", { segment: "all" });
ok(!docs.err && Array.isArray(docs.body?.documents), `list_envelopes answers ${docs.body?.documents?.length} documents`);
const tpls = await call("list_templates", {});
const t = tpls.body?.items?.[0];
ok(!!t, `list_templates answers ${tpls.body?.items?.length} templates`);
const before = (await api("GET", "/api:envelopes/envelopes/stats", undefined, jordan)).j.out;
const people = t.roles.filter((r) => !r.email).map((r, i) => ({ role_id: r.id, name: `Agent Person ${i + 1}`, email: `agent-${i}-${Date.now()}@example.com` }));
const asked = await call("send_from_template", { template_id: t.id, people, title: "Sent by an agent" });
ok(!asked.err && asked.body?.status === "pending", `send_from_template asks first: ${JSON.stringify(asked.body).slice(0, 160)}`);
const mid = (await api("GET", "/api:envelopes/envelopes/stats", undefined, jordan)).j.out;
ok(mid === before, `nothing is sent before approval (${before} → ${mid})`);
const pending = await api("GET", "/api:approvals/approvals?view=pending", undefined, jordan);
const req = (pending.j?.items ?? pending.j ?? []).find?.((a) => a.id === asked.body?.approval_id) ?? null;
ok(!!req, `the request waits under Approvals for Jordan: ${req?.title}`);
const approved = await api("POST", `/api:approvals/approvals/${asked.body.approval_id}/approve`, {}, jordan);
ok(approved.status === 200, `Jordan approves: ${approved.status} ${JSON.stringify(approved.j).slice(0, 160)}`);
const after = (await api("GET", "/api:envelopes/envelopes/stats", undefined, jordan)).j.out;
ok(after === before + 1, `it's sent once approved (${before} → ${after})`);
