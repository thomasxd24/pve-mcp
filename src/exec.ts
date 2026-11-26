import { type Api, type Guest, guestPath } from "./pve.ts";
import { type ExecResult, type Shell, shQuote } from "./ssh.ts";

// Running commands: on a node over SSH, in an LXC with `pct exec` on its node, in a VM through the QEMU guest agent.
// A command is either an argv array (run directly, no shell) or a shell string (run with sh -c).

export type Command = { argv: string[] } | { script: string };

const MAX_TEXT = 40_000;

export class Runner {
  private hosts = new Map<string, string>();
  private api: Api;
  private shell: Shell;
  private overrides: Record<string, string>;
  private fallbackHost: string;

  constructor(api: Api, shell: Shell, opts: { sshHosts: Record<string, string>; pveUrl: string }) {
    this.api = api;
    this.shell = shell;
    this.overrides = opts.sshHosts;
    this.fallbackHost = new URL(opts.pveUrl).hostname;
  }

  /** The address to SSH to for a node: SSH_HOSTS, else its IP from /cluster/status, else the API host. */
  async nodeHost(node: string): Promise<string> {
    if (this.overrides[node]) return this.overrides[node];
    const cached = this.hosts.get(node);
    if (cached) return cached;
    const status = await this.api.call<{ type: string; name: string; ip?: string }[]>("GET", "/cluster/status");
    const nodes = status.filter((s) => s.type === "node");
    if (!nodes.some((n) => n.name === node)) throw new Error(`No node "${node}". Nodes: ${nodes.map((n) => n.name).join(", ")}`);
    for (const n of nodes) if (n.ip) this.hosts.set(n.name, n.ip);
    return this.hosts.get(node) ?? this.fallbackHost;
  }

  async onNode(node: string, cmd: Command, timeoutS: number): Promise<ExecResult> {
    const inner = "argv" in cmd ? cmd.argv.map(shQuote).join(" ") : `sh -c ${shQuote(cmd.script)}`;
    return this.shell.exec(await this.nodeHost(node), `timeout -k 5 ${timeoutS} ${inner}`, timeoutS * 1000);
  }

  async inGuest(g: Guest, cmd: Command, timeoutS: number): Promise<ExecResult> {
    if (g.status !== "running") throw new Error(`${label(g)} is ${g.status}; start it first.`);
    if (g.type === "lxc") {
      const argv = "argv" in cmd ? cmd.argv : ["sh", "-c", cmd.script];
      const line = `timeout -k 5 ${timeoutS} pct exec ${g.vmid} -- ${argv.map(shQuote).join(" ")}`;
      return this.shell.exec(await this.nodeHost(g.node), line, timeoutS * 1000);
    }
    return this.agentExec(g, "argv" in cmd ? cmd.argv : ["sh", "-c", cmd.script], timeoutS);
  }

  private async agentExec(g: Guest, argv: string[], timeoutS: number): Promise<ExecResult> {
    const base = `${guestPath(g)}/agent`;
    let pid: number;
    try {
      ({ pid } = await this.api.call<{ pid: number }>("POST", `${base}/exec`, { command: argv }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/agent/i.test(msg) && /not running|not configured|No QEMU guest agent/i.test(msg))
        throw new Error(`${label(g)}: the QEMU guest agent is not running. Install qemu-guest-agent in the VM and turn on Options → QEMU Guest Agent. (${msg})`);
      throw e;
    }
    const end = Date.now() + timeoutS * 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await this.api.call<{
        exited: number | boolean;
        exitcode?: number;
        signal?: number;
        "out-data"?: string;
        "err-data"?: string;
        "out-truncated"?: boolean;
        "err-truncated"?: boolean;
      }>("GET", `${base}/exec-status`, { pid });
      if (st.exited) {
        return {
          code: st.exitcode ?? null,
          signal: st.signal ? String(st.signal) : undefined,
          stdout: st["out-data"] ?? "",
          stderr: st["err-data"] ?? "",
          truncated: Boolean(st["out-truncated"] || st["err-truncated"]),
        };
      }
      if (Date.now() > end)
        return { code: null, stdout: "", stderr: `Still running after ${timeoutS} s (guest agent pid ${pid}); it was not stopped.`, truncated: false };
    }
  }
}

export const label = (g: Guest) => `${g.type === "lxc" ? "CT" : "VM"} ${g.vmid}${g.name ? ` (${g.name})` : ""}`;

const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, 8_000)}\n… (${s.length - MAX_TEXT} characters cut) …\n${s.slice(-(MAX_TEXT - 8_000))}` : s);

/** One readable block: exit code, then stdout and stderr. */
export function formatResult(r: ExecResult): string {
  const head = r.code === 0 ? "exit 0" : r.code === 124 ? "exit 124 (timed out)" : `exit ${r.code ?? "?"}${r.signal ? ` (signal ${r.signal})` : ""}`;
  const parts = [head + (r.truncated ? " (output truncated)" : "")];
  if (r.stdout.trim()) parts.push(cut(r.stdout.replace(/\s+$/, "")));
  if (r.stderr.trim()) parts.push(`--- stderr\n${cut(r.stderr.replace(/\s+$/, ""))}`);
  return parts.join("\n");
}
