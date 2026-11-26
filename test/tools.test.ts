import assert from "node:assert/strict";
import { test } from "node:test";
import { Runner } from "../src/exec.ts";
import { createServer, handleRpc } from "../src/mcp.ts";
import { type Api, encodeParams, type Method, type Params } from "../src/pve.ts";
import type { ExecResult, Shell } from "../src/ssh.ts";
import type { Deps } from "../src/tools.ts";

type Call = { method: Method; path: string; params: Params };

const RESOURCES = [
  { type: "node", node: "pve1", status: "online", cpu: 0.1, mem: 4e9, maxmem: 16e9, disk: 1e10, maxdisk: 1e11, uptime: 90000 },
  { type: "qemu", vmid: 101, name: "web", node: "pve1", status: "running", cpu: 0.02, mem: 1e9, maxmem: 2e9, maxdisk: 3e10, uptime: 3600 },
  { type: "lxc", vmid: 200, name: "dns", node: "pve1", status: "running", cpu: 0, mem: 1e8, maxmem: 5e8, disk: 1e9, maxdisk: 8e9, uptime: 60 },
  { type: "lxc", vmid: 201, name: "off", node: "pve1", status: "stopped", maxmem: 5e8, maxdisk: 8e9 },
  { type: "storage", storage: "local", node: "pve1", status: "available", plugintype: "dir", disk: 1e10, maxdisk: 1e11, content: "backup,iso" },
];

function fakeApi(): Api & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async call<T>(method: Method, path: string, params: Params = {}): Promise<T> {
      calls.push({ method, path, params });
      const r = (v: unknown) => v as T;
      if (path === "/cluster/resources") return r(params.type === "vm" ? RESOURCES.filter((x) => x.type === "qemu" || x.type === "lxc") : RESOURCES);
      if (path === "/cluster/status") return r([{ type: "cluster", name: "home", quorate: 1, nodes: 1 }, { type: "node", name: "pve1", ip: "10.0.0.5" }]);
      if (path === "/nodes/pve1/qemu/101/agent/exec") return r({ pid: 42 });
      if (path === "/nodes/pve1/qemu/101/agent/exec-status") return r({ exited: 1, exitcode: 0, "out-data": "hello from vm\n" });
      if (path.endsWith("/status") && path.includes("/tasks/")) return r({ status: "stopped", exitstatus: "OK" });
      if (path === "/nodes/pve1/lxc/200/status/start") return r("UPID:pve1:0001:0002:0003:vzstart:200:root@pam:");
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

function fakeShell(): Shell & { runs: { host: string; command: string }[] } {
  const runs: { host: string; command: string }[] = [];
  return {
    runs,
    publicKey: () => "ssh-ed25519 AAAA pve-mcp",
    async exec(host, command): Promise<ExecResult> {
      runs.push({ host, command });
      return { code: 0, stdout: "out\n", stderr: "", truncated: false };
    },
  };
}

function deps(allowDestructive = false) {
  const api = fakeApi();
  const shell = fakeShell();
  const runner = new Runner(api, shell, { sshHosts: {}, pveUrl: "https://10.0.0.5:8006" });
  const d: Deps = { api, runner, shell, config: { allowDestructive } };
  return { d, api, shell };
}

const call = async (d: Deps, name: string, args: Record<string, unknown>) => {
  const r = (await handleRpc(d, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  return { text: r.result.content[0].text, isError: Boolean(r.result.isError) };
};

test("params are encoded like pvesh", () => {
  assert.equal(encodeParams({ command: ["sh", "-c", "a b"], onboot: true, x: undefined, n: 3 }).toString(), "command=sh&command=-c&command=a+b&onboot=1&n=3");
});

test("tools/list hides destructive tools unless allowed, and marks reads", async () => {
  const list = async (allow: boolean) =>
    ((await handleRpc(deps(allow).d, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }).result.tools;
  const safe = await list(false);
  assert.ok(!safe.some((t) => t.name === "guest_delete" || t.name === "api_call" || t.name === "snapshot_rollback"));
  assert.equal(safe.find((t) => t.name === "guest_read")?.annotations.readOnlyHint, true);
  assert.equal(safe.find((t) => t.name === "guest_exec")?.annotations.readOnlyHint, false);
  assert.ok((await list(true)).some((t) => t.name === "guest_delete"));
  const { d } = deps(false);
  assert.match((await handleRpc(d, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_delete", arguments: {} } }) as { error: { message: string } }).error.message, /Unknown tool/);
});

test("overview lists guests", async () => {
  const { d } = deps();
  const { text } = await call(d, "overview", {});
  assert.match(text, /quorate/);
  assert.match(text, /101\s+web\s+qemu/);
  assert.match(text, /Guests \(2\/3 running\)/);
});

test("guest_read in an LXC runs pct exec on its node, quoted, without a shell", async () => {
  const { d, shell } = deps();
  const { text, isError } = await call(d, "guest_read", { guest: "dns", command: ["cat", "/etc/x; rm -rf /"] });
  assert.equal(isError, false);
  assert.match(text, /^exit 0\nout/);
  assert.equal(shell.runs[0].host, "10.0.0.5");
  assert.equal(shell.runs[0].command, "timeout -k 5 30 pct exec 200 -- 'cat' '/etc/x; rm -rf /'");
});

test("guest_read refuses a command that changes things", async () => {
  const { d, shell } = deps();
  const { text, isError } = await call(d, "guest_read", { guest: 200, command: ["systemctl", "restart", "nginx"] });
  assert.equal(isError, true);
  assert.match(text, /guest_exec/);
  assert.equal(shell.runs.length, 0);
});

test("guest_exec in a VM goes through the guest agent", async () => {
  const { d, api } = deps();
  const { text } = await call(d, "guest_exec", { guest: 101, command: "uptime | cut -d, -f1" });
  assert.match(text, /hello from vm/);
  const exec = api.calls.find((c) => c.path.endsWith("/agent/exec"));
  assert.deepEqual(exec?.params.command, ["sh", "-c", "uptime | cut -d, -f1"]);
});

test("guest_exec in an LXC wraps the script in sh -c, safely quoted", async () => {
  const { d, shell } = deps();
  await call(d, "guest_exec", { guest: 200, command: "echo 'hi' && id" });
  assert.equal(shell.runs[0].command, `timeout -k 5 60 pct exec 200 -- 'sh' '-c' 'echo '\\''hi'\\'' && id'`);
});

test("a stopped guest is reported, not run", async () => {
  const { d } = deps();
  const { text, isError } = await call(d, "guest_read", { guest: "off", command: ["df"] });
  assert.equal(isError, true);
  assert.match(text, /stopped/);
});

test("guest_power starts and waits for the task", async () => {
  const { d } = deps();
  const { text } = await call(d, "guest_power", { guest: 200, action: "start" });
  assert.match(text, /done/);
});

test("node_exec runs on the node", async () => {
  const { d, shell } = deps();
  await call(d, "node_exec", { node: "pve1", command: "pveversion -v" });
  assert.equal(shell.runs[0].command, "timeout -k 5 60 sh -c 'pveversion -v'");
});

test("HTTP: bearer token required, health open", async () => {
  const { d } = deps();
  const token = "x".repeat(40);
  const server = createServer(d, token, () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", body, headers: { authorization: "Bearer wrong" } })).status, 401);
    const res = await fetch(`${base}/mcp`, { method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 1, result: {} });
    const note = await fetch(`${base}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), headers: { authorization: `Bearer ${token}` } });
    assert.equal(note.status, 202);
  } finally {
    server.close();
  }
});
