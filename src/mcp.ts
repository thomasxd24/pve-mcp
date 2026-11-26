import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { type Deps, listTools, type Tool } from "./tools.ts";

// MCP over Streamable HTTP, the simple way: stateless JSON-RPC over POST /mcp with JSON replies, behind a Bearer token.
// GET /healthz is open and says only "ok".

export const PROTOCOL = "2025-06-18";
const MAX_BODY = 256 * 1024;
type Json = Record<string, unknown>;

const INSTRUCTIONS =
  "Thomas's Proxmox VE cluster. Start with overview. Guests are named by vmid or name. guest_read/node_read run read-only commands (argv arrays); guest_exec/node_exec run any shell command and change things. VMs need the QEMU guest agent for commands and IPs; containers use pct exec on their node.";

export function annotations(t: Tool) {
  if (t.kind === "read") return { readOnlyHint: true, openWorldHint: false };
  return { readOnlyHint: false, destructiveHint: t.kind === "danger" || /exec|power|migrate|set/.test(t.name), openWorldHint: false };
}

export async function handleRpc(deps: Deps, msg: unknown, log: (e: Json) => void = () => {}): Promise<Json | null> {
  const m = msg as { jsonrpc?: string; id?: unknown; method?: unknown; params?: Json } | null;
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string")
    return { jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "Invalid request" } };
  const isNote = m.id === undefined || m.id === null;
  const ok = (result: unknown) => (isNote ? null : { jsonrpc: "2.0", id: m.id, result });
  const fail = (code: number, message: string) => (isNote ? null : { jsonrpc: "2.0", id: m.id, error: { code, message } });
  const tools = listTools(deps.config.allowDestructive);
  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion;
      return ok({
        protocolVersion: typeof asked === "string" && asked <= PROTOCOL ? asked : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pve-mcp", version: process.env.APP_VERSION ?? "dev" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: annotations(t) })) });
    case "tools/call": {
      const name = String(m.params?.name);
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool ${name}`);
      const args = (m.params?.arguments as Json) ?? {};
      const started = Date.now();
      try {
        const text = await tool.run(args, deps);
        log({ event: "tool", tool: name, kind: tool.kind, args: summarize(args), ms: Date.now() - started, ok: true });
        return ok({ content: [{ type: "text", text: text || "(no output)" }] });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log({ event: "tool", tool: name, kind: tool.kind, args: summarize(args), ms: Date.now() - started, ok: false, error: message.slice(0, 300) });
        return ok({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      if (m.method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${m.method}`);
  }
}

/** Arguments for the audit log, with long values cut. */
function summarize(args: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    out[k] = s && s.length > 500 ? `${s.slice(0, 500)}…` : v;
  }
  return out;
}

const sha = (s: string) => createHash("sha256").update(s).digest();

export function createServer(deps: Deps, token: string, log: (e: Json) => void = (e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e }))) {
  let failures: number[] = [];
  return http.createServer(async (req, res) => {
    const send = (status: number, body?: unknown) => {
      if (body === undefined) {
        res.writeHead(status).end();
        return;
      }
      const s = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) }).end(s);
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") return send(200, { status: "ok" });
    if (url.pathname !== "/mcp") return send(404, { error: "not_found" });

    const given = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(sha(given), sha(token))) {
      const now = Date.now();
      failures = failures.filter((t) => now - t < 15 * 60_000);
      failures.push(now);
      log({ event: "unauthorized", ip: req.headers["x-forwarded-for"] ?? req.socket.remoteAddress });
      await new Promise((r) => setTimeout(r, 500));
      return send(failures.length > 20 ? 429 : 401, { error: failures.length > 20 ? "too_many_attempts" : "unauthorized" });
    }
    // No server-sent events: GET is refused, as the spec allows for servers that do not stream.
    if (req.method === "DELETE") return send(204);
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return send(405, { error: "method_not_allowed" });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) return send(413, { error: "too_large" });
      chunks.push(c as Buffer);
    }
    let msg: unknown;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const out = Array.isArray(msg) ? (await Promise.all(msg.map((x) => handleRpc(deps, x, log)))).filter(Boolean) : await handleRpc(deps, msg, log);
    if (!out || (Array.isArray(out) && !out.length)) return send(202);
    send(200, out);
  });
}
