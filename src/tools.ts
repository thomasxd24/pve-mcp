import type { Config } from "./config.ts";
import { formatResult, label, type Runner } from "./exec.ts";
import { bytes, duration, json, pct, table, time } from "./format.ts";
import { checkRead, READ_COMMANDS } from "./guard.ts";
import { type Api, findGuest, type Guest, guestPath, upidNode, waitTask } from "./pve.ts";
import type { Shell } from "./ssh.ts";

// The tools. `kind` decides the MCP annotations (JARVIS lets reads run and asks for the rest) and whether the tool
// is listed at all: "danger" tools exist only with PVE_ALLOW_DESTRUCTIVE=1.

type Json = Record<string, unknown>;
export type Deps = { api: Api; runner: Runner; shell: Shell; config: Pick<Config, "allowDestructive"> };
export type Tool = {
  name: string;
  description: string;
  inputSchema: Json;
  kind: "read" | "write" | "danger";
  run: (args: Json, d: Deps) => Promise<string>;
};

const obj = (properties: Json = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: Json = {}) => ({ type: "integer", description, ...extra });
const bool = (description: string) => ({ type: "boolean", description });
const GUEST = { type: ["integer", "string"], description: "The VM or container: its vmid (e.g. 101) or its name" };
const NODE = str("Node name (see overview)");
const ARGV = { type: "array", items: { type: "string" }, minItems: 1, description: 'The command as separate words, e.g. ["df", "-h"] or ["journalctl", "-u", "nginx", "-n", "50"]. No shell: pipes and redirections do not work here.' };

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const n = (v: unknown, def: number, min: number, max: number) => {
  const x = Number(v ?? def);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : def;
};
const nodePath = (node: unknown) => {
  const v = s(node);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(v)) throw new Error("node: give a node name, e.g. pve");
  return `/nodes/${v}`;
};
const guest = (d: Deps, a: Json) => findGuest(d.api, s(a.guest));
const snapName = (v: unknown) => {
  const name = s(v);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/.test(name)) throw new Error("Snapshot names start with a letter, then letters, digits, - or _ (2-40 characters).");
  return name;
};

async function taskResult(d: Deps, upid: string, waitS: number, what: string): Promise<string> {
  const st = await waitTask(d.api, upid, waitS * 1000);
  if (!st) return `${what}: started, still running after ${waitS} s. Task ${upid} (see task_log).`;
  return st.exitstatus === "OK" ? `${what}: done.` : `${what}: failed (${st.exitstatus}). Task ${upid} (see task_log).`;
}

type Res = Json & { type: string; node?: string; status?: string };

export const TOOLS: Tool[] = [
  // ---------------------------------------------------------------- reads
  {
    name: "overview",
    kind: "read",
    description:
      "The whole cluster at a glance: quorum, every node (CPU, memory, uptime), every VM and LXC container (vmid, name, node, status, CPU, memory, disk, uptime, tags) and every storage (use). Start here.",
    inputSchema: obj({ node: str("Only this node (optional)") }),
    run: async (a, d) => {
      const [status, res] = await Promise.all([
        d.api.call<Res[]>("GET", "/cluster/status").catch(() => [] as Res[]),
        d.api.call<Res[]>("GET", "/cluster/resources"),
      ]);
      const only = (r: Res) => !a.node || r.node === a.node;
      const cluster = status.find((x) => x.type === "cluster");
      const nodes = res.filter((r) => r.type === "node" && only(r));
      const guests = res.filter((r) => (r.type === "qemu" || r.type === "lxc") && only(r)).sort((x, y) => Number(x.vmid) - Number(y.vmid));
      const stores = res.filter((r) => r.type === "storage" && only(r));
      const out: string[] = [];
      if (cluster) out.push(`Cluster ${s(cluster.name)}: ${cluster.quorate ? "quorate" : "NOT QUORATE"}, ${s(cluster.nodes)} nodes`);
      else out.push("Standalone node (no cluster)");
      out.push(
        "",
        "Nodes",
        table(
          ["node", "status", "cpu", "mem", "disk", "uptime"],
          nodes.map((r) => [s(r.node), s(r.status), pct(Number(r.cpu) * 100, 100), `${bytes(r.mem)}/${bytes(r.maxmem)} ${pct(r.mem, r.maxmem)}`, pct(r.disk, r.maxdisk), duration(r.uptime)]),
        ),
        "",
        `Guests (${guests.filter((g) => g.status === "running").length}/${guests.length} running)`,
        table(
          ["vmid", "name", "type", "node", "status", "cpu", "mem", "disk", "uptime", "tags"],
          guests.map((g) => [
            s(g.vmid),
            s(g.name),
            g.template ? `${g.type} template` : g.type,
            s(g.node),
            s(g.status),
            g.status === "running" ? pct(Number(g.cpu) * 100, 100) : "",
            g.status === "running" ? `${bytes(g.mem)}/${bytes(g.maxmem)}` : bytes(g.maxmem),
            g.type === "lxc" && g.maxdisk ? `${bytes(g.disk)}/${bytes(g.maxdisk)}` : bytes(g.maxdisk),
            duration(g.uptime),
            s(g.tags).replace(/;/g, ","),
          ]),
        ),
        "",
        "Storage",
        table(
          ["storage", "node", "type", "status", "used", "content"],
          dedupeShared(stores).map((r) => [s(r.storage), r.shared ? "shared" : s(r.node), s(r.plugintype), s(r.status), `${bytes(r.disk)}/${bytes(r.maxdisk)} ${pct(r.disk, r.maxdisk)}`, s(r.content)]),
        ),
      );
      return out.join("\n");
    },
  },
  {
    name: "node_status",
    kind: "read",
    description: "One node in detail: CPU model and load, memory, swap, root disk, kernel and Proxmox versions, uptime, and its services' states.",
    inputSchema: obj({ node: NODE }, ["node"]),
    run: async (a, d) => {
      const p = nodePath(a.node);
      const [st, services] = await Promise.all([
        d.api.call<Json & { memory: Json; swap: Json; rootfs: Json; cpuinfo: Json }>("GET", `${p}/status`),
        d.api.call<Json[]>("GET", `${p}/services`).catch(() => []),
      ]);
      const cpu = st.cpuinfo ?? {};
      return [
        `${s(a.node)}: up ${duration(st.uptime)}, ${s(st.pveversion)}, kernel ${s((st["current-kernel"] as Json)?.release ?? st.kversion)}`,
        `CPU: ${s(cpu.model)} (${s(cpu.cpus)} threads), use ${pct(Number(st.cpu) * 100, 100)}, load ${(st.loadavg as string[] | undefined)?.join(" ") ?? "-"}, iowait ${pct(Number(st.wait) * 100, 100)}`,
        `Memory: ${bytes(st.memory?.used)}/${bytes(st.memory?.total)} (${pct(st.memory?.used, st.memory?.total)}), swap ${bytes(st.swap?.used)}/${bytes(st.swap?.total)}`,
        `Root disk: ${bytes(st.rootfs?.used)}/${bytes(st.rootfs?.total)} (${pct(st.rootfs?.used, st.rootfs?.total)})`,
        "",
        table(["service", "state"], services.map((x) => [s(x.name ?? x.service), s(x.state)])),
      ].join("\n");
    },
  },
  {
    name: "guest",
    kind: "read",
    description: "One VM or container in detail: live status (CPU, memory, disk, network I/O, uptime, guest agent) and its full config.",
    inputSchema: obj({ guest: GUEST }, ["guest"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      const [cur, cfg] = await Promise.all([d.api.call<Json>("GET", `${guestPath(g)}/status/current`), d.api.call<Json>("GET", `${guestPath(g)}/config`)]);
      return [
        `${label(g)} on ${g.node}: ${s(cur.status)}${cur.qmpstatus && cur.qmpstatus !== cur.status ? ` (${s(cur.qmpstatus)})` : ""}, up ${duration(cur.uptime)}`,
        `CPU ${pct(Number(cur.cpu) * 100, 100)} of ${s(cur.cpus)}, memory ${bytes(cur.mem)}/${bytes(cur.maxmem)}, disk ${bytes(cur.disk)}/${bytes(cur.maxdisk)}, net in ${bytes(cur.netin)} out ${bytes(cur.netout)}${g.type === "qemu" ? `, guest agent ${cur.agent ? "on" : "off"}` : ""}${cur.lock ? `, LOCKED (${s(cur.lock)})` : ""}`,
        "",
        "Config:",
        Object.entries(cfg)
          .filter(([k]) => k !== "digest")
          .map(([k, v]) => `${k}: ${s(v)}`)
          .join("\n"),
      ].join("\n");
    },
  },
  {
    name: "guest_ip",
    kind: "read",
    description: "A guest's network interfaces and IP addresses (VMs need the QEMU guest agent).",
    inputSchema: obj({ guest: GUEST }, ["guest"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      if (g.type === "lxc") {
        const ifs = await d.api.call<Json[]>("GET", `${guestPath(g)}/interfaces`);
        return table(["iface", "mac", "inet", "inet6"], ifs.map((i) => [s(i.name), s(i.hwaddr), s(i.inet), s(i.inet6)]));
      }
      const r = await d.api.call<{ result: { name: string; "hardware-address"?: string; "ip-addresses"?: { "ip-address": string; prefix: number }[] }[] }>(
        "GET",
        `${guestPath(g)}/agent/network-get-interfaces`,
      );
      return table(
        ["iface", "mac", "addresses"],
        r.result.map((i) => [i.name, i["hardware-address"], (i["ip-addresses"] ?? []).map((x) => `${x["ip-address"]}/${x.prefix}`).join(" ")]),
      );
    },
  },
  {
    name: "storage",
    kind: "read",
    description: "Every storage with its type, state, use and what it holds (images, backups, ISOs…).",
    inputSchema: obj({ node: str("Only this node (optional)") }),
    run: async (a, d) => {
      const res = await d.api.call<Res[]>("GET", "/cluster/resources", { type: "storage" });
      const rows = dedupeShared(res.filter((r) => !a.node || r.node === a.node));
      return table(
        ["storage", "node", "type", "status", "used", "free", "content"],
        rows.map((r) => [s(r.storage), r.shared ? "shared" : s(r.node), s(r.plugintype), s(r.status), `${bytes(r.disk)}/${bytes(r.maxdisk)} ${pct(r.disk, r.maxdisk)}`, bytes(Number(r.maxdisk) - Number(r.disk)), s(r.content)]),
      );
    },
  },
  {
    name: "backups",
    kind: "read",
    description: "Scheduled backup jobs and the backup files on every storage (newest first), optionally for one guest. Use it to check that backups run and are recent.",
    inputSchema: obj({ guest: { ...GUEST, description: "Only this guest (optional)" }, limit: int("How many files (default 40)") }),
    run: async (a, d) => {
      const vmid = a.guest !== undefined && a.guest !== "" ? (await guest(d, a)).vmid : undefined;
      const [jobs, res] = await Promise.all([
        d.api.call<Json[]>("GET", "/cluster/backup").catch(() => [] as Json[]),
        d.api.call<Res[]>("GET", "/cluster/resources", { type: "storage" }),
      ]);
      const stores = dedupeShared(res.filter((r) => r.status === "available" && s(r.content).split(",").includes("backup")));
      const files = (
        await Promise.all(
          stores.map((st) =>
            d.api
              .call<Json[]>("GET", `/nodes/${s(st.node)}/storage/${encodeURIComponent(s(st.storage))}/content`, { content: "backup", vmid })
              .then((l) => l.map((f): Json => ({ ...f, storage: st.storage })))
              .catch(() => [] as Json[]),
          ),
        )
      )
        .flat()
        .sort((x, y) => Number(y.ctime) - Number(x.ctime))
        .slice(0, n(a.limit, 40, 1, 500));
      return [
        "Backup jobs",
        table(
          ["id", "enabled", "schedule", "storage", "guests", "mode", "keep"],
          jobs.map((j) => [s(j.id), j.enabled === 0 ? "no" : "yes", s(j.schedule), s(j.storage), j.all ? `all${j.exclude ? ` except ${s(j.exclude)}` : ""}` : s(j.vmid || j.pool), s(j.mode), s(j["prune-backups"])]),
        ),
        "",
        `Backup files (${files.length} shown)`,
        table(
          ["vmid", "date", "size", "storage", "verified", "protected", "notes"],
          files.map((f) => [s(f.vmid), time(f.ctime), bytes(f.size), s(f.storage), s((f.verification as Json)?.state), f.protected ? "yes" : "", s(f.notes).slice(0, 60)]),
        ),
      ].join("\n");
    },
  },
  {
    name: "snapshots",
    kind: "read",
    description: "A guest's snapshots.",
    inputSchema: obj({ guest: GUEST }, ["guest"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      const list = await d.api.call<Json[]>("GET", `${guestPath(g)}/snapshot`);
      return table(
        ["name", "date", "parent", "ram", "description"],
        list.map((x) => [s(x.name), x.name === "current" ? "(now)" : time(x.snaptime), s(x.parent), x.vmstate ? "yes" : "", s(x.description).trim().slice(0, 80)]),
      );
    },
  },
  {
    name: "tasks",
    kind: "read",
    description: "Recent tasks across the cluster (backups, starts, migrations…), newest first. Filter by node, guest or failures only.",
    inputSchema: obj({ node: str("Only this node"), guest: { ...GUEST, description: "Only this vmid" }, errors: bool("Only failed tasks"), limit: int("How many (default 30)") }),
    run: async (a, d) => {
      const list = await d.api.call<Json[]>("GET", "/cluster/tasks");
      const rows = list
        .filter((t) => (!a.node || t.node === a.node) && (a.guest === undefined || a.guest === "" || s(t.id) === s(a.guest)) && (!a.errors || (t.status && t.status !== "OK")))
        .sort((x, y) => Number(y.starttime) - Number(x.starttime))
        .slice(0, n(a.limit, 30, 1, 500));
      return table(
        ["start", "node", "type", "id", "user", "status", "upid"],
        rows.map((t) => [time(t.starttime), s(t.node), s(t.type), s(t.id), s(t.user), t.endtime ? s(t.status) : "running", s(t.upid)]),
      );
    },
  },
  {
    name: "task_log",
    kind: "read",
    description: "The status and log of one task, by its UPID (from tasks or from an action's result).",
    inputSchema: obj({ upid: str("Task id, UPID:node:…"), lines: int("Last N lines (default 200)") }, ["upid"]),
    run: async (a, d) => {
      const upid = s(a.upid);
      const base = `/nodes/${upidNode(upid)}/tasks/${encodeURIComponent(upid)}`;
      const st = await d.api.call<Json>("GET", `${base}/status`);
      const lines = n(a.lines, 200, 1, 5000);
      const log = await d.api.call<{ n: number; t: string }[]>("GET", `${base}/log`, { start: 0, limit: 50_000 });
      return [`${s(st.type)} ${s(st.id)} on ${s(st.node)} by ${s(st.user)}: ${st.status === "stopped" ? s(st.exitstatus) : "running"}`, "", ...log.slice(-lines).map((l) => l.t)].join("\n");
    },
  },
  {
    name: "metrics",
    kind: "read",
    description: "CPU, memory, network, disk I/O (and load/iowait for nodes) over a time range for a node or a guest: average, peak and latest.",
    inputSchema: obj({ node: str("A node (or give guest)"), guest: { ...GUEST, description: "A VM or container (or give node)" }, timeframe: str("hour (default), day, week, month or year", { enum: ["hour", "day", "week", "month", "year"] }) }),
    run: async (a, d) => {
      let path: string;
      let title: string;
      if (a.guest !== undefined && a.guest !== "") {
        const g = await guest(d, a);
        path = `${guestPath(g)}/rrddata`;
        title = label(g);
      } else if (a.node) {
        path = `${nodePath(a.node)}/rrddata`;
        title = `Node ${s(a.node)}`;
      } else throw new Error("Give node or guest.");
      const tf = s(a.timeframe) || "hour";
      const rows = (await d.api.call<Json[]>("GET", path, { timeframe: tf, cf: "AVERAGE" })).filter((r) => Object.keys(r).length > 1);
      if (!rows.length) return `${title}: no data for this ${tf}.`;
      const series: [string, (r: Json) => number | undefined, (v: number) => string][] = [
        ["cpu", (r) => num(r.cpu) * 100, (v) => `${v.toFixed(1)}%`],
        ["mem", (r) => (r.memused ?? r.mem) as number, bytes],
        ["mem %", (r) => (num(r.memtotal ?? r.maxmem) ? (num(r.memused ?? r.mem) / num(r.memtotal ?? r.maxmem)) * 100 : undefined), (v) => `${v.toFixed(0)}%`],
        ["load", (r) => r.loadavg as number, (v) => v.toFixed(2)],
        ["iowait", (r) => (r.iowait === undefined ? undefined : num(r.iowait) * 100), (v) => `${v.toFixed(1)}%`],
        ["net in /s", (r) => r.netin as number, bytes],
        ["net out /s", (r) => r.netout as number, bytes],
        ["disk read /s", (r) => r.diskread as number, bytes],
        ["disk write /s", (r) => r.diskwrite as number, bytes],
        ["root disk", (r) => r.rootused as number, bytes],
      ];
      const out = series
        .map(([name, get, fmt]) => {
          const vals = rows.map(get).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
          if (!vals.length) return null;
          return [name, fmt(vals.reduce((x, y) => x + y, 0) / vals.length), fmt(Math.max(...vals)), fmt(vals[vals.length - 1])];
        })
        .filter((r): r is string[] => r !== null);
      return `${title}, last ${tf} (${time(rows[0].time)} → ${time(rows[rows.length - 1].time)})\n${table(["metric", "avg", "peak", "latest"], out)}`;
    },
  },
  {
    name: "node_log",
    kind: "read",
    description: "A node's system journal (last lines). For one service use node_read with journalctl -u <unit>.",
    inputSchema: obj({ node: NODE, lines: int("How many (default 100)") }, ["node"]),
    run: async (a, d) => (await d.api.call<string[]>("GET", `${nodePath(a.node)}/journal`, { lastentries: n(a.lines, 100, 1, 5000) })).join("\n"),
  },
  {
    name: "cluster_log",
    kind: "read",
    description: "The cluster-wide log (logins, task starts and ends, errors).",
    inputSchema: obj({ max: int("How many entries (default 50)") }),
    run: async (a, d) => {
      const list = await d.api.call<Json[]>("GET", "/cluster/log", { max: n(a.max, 50, 1, 1000) });
      return list.map((e) => `${time(e.time)} ${s(e.node)} ${s(e.tag)} ${s(e.user)}: ${s(e.msg)}`).join("\n");
    },
  },
  {
    name: "disks",
    kind: "read",
    description: "A node's physical disks: model, size, type, SMART health and SSD wear.",
    inputSchema: obj({ node: NODE }, ["node"]),
    run: async (a, d) => {
      const list = await d.api.call<Json[]>("GET", `${nodePath(a.node)}/disks/list`);
      return table(
        ["device", "model", "size", "type", "health", "wear left", "used by"],
        list.map((x) => [s(x.devpath), s(x.model), bytes(x.size), s(x.type), s(x.health), x.wearout === "N/A" || x.wearout === undefined ? "" : `${s(x.wearout)}%`, s(x.used)]),
      );
    },
  },
  {
    name: "updates",
    kind: "read",
    description: "Package updates waiting on a node (as of its last apt refresh).",
    inputSchema: obj({ node: NODE }, ["node"]),
    run: async (a, d) => {
      const list = await d.api.call<Json[]>("GET", `${nodePath(a.node)}/apt/update`);
      if (!list.length) return `${s(a.node)}: up to date (as of the last apt refresh).`;
      return `${list.length} updates\n${table(["package", "installed", "new"], list.map((p) => [s(p.Package), s(p.OldVersion), s(p.Version)]))}`;
    },
  },
  {
    name: "ha_status",
    kind: "read",
    description: "High-availability manager state and HA-managed resources.",
    inputSchema: obj(),
    run: async (_a, d) => {
      const st = await d.api.call<Json[]>("GET", "/cluster/ha/status/current");
      return st.length ? st.map((x) => `${s(x.type)} ${s(x.id ?? x.sid)}: ${s(x.status)}${x.state ? ` (${s(x.state)})` : ""}${x.node ? ` on ${s(x.node)}` : ""}`).join("\n") : "HA is not used.";
    },
  },
  {
    name: "api_get",
    kind: "read",
    description:
      "Any read (GET) of the Proxmox API, for what the other tools do not cover, e.g. /nodes/pve/network, /cluster/firewall/rules, /pools, /access/users, /nodes/pve/qemu/101/pending. Returns JSON. API reference: https://pve.proxmox.com/pve-docs/api-viewer/",
    inputSchema: obj({ path: str("API path after /api2/json, e.g. /nodes"), params: { type: "object", description: "Query parameters (optional)", additionalProperties: { type: ["string", "number", "boolean"] } } }, ["path"]),
    run: async (a, d) => json(await d.api.call("GET", apiPath(a.path), (a.params as Json as Record<string, string>) ?? {})),
  },
  {
    name: "ssh_public_key",
    kind: "read",
    description: "This server's SSH public key, which must be in root's authorized_keys on each Proxmox node for node_* and LXC commands.",
    inputSchema: obj(),
    run: async (_a, d) =>
      `${d.shell.publicKey()}\n\nOn every node, as root:\n  echo '${d.shell.publicKey()}' >> /root/.ssh/authorized_keys\n(In a cluster /root/.ssh/authorized_keys is shared through /etc/pve, so once is enough.)`,
  },
  {
    name: "guest_read",
    kind: "read",
    description: `Run a read-only command inside a VM (QEMU guest agent) or LXC container (pct exec), as root. Only commands that look are allowed: ${READ_COMMANDS.filter((c) => !["pveversion", "pvecm", "pvesm", "pvesh", "qm", "pct", "ha-manager", "pve-firewall", "zpool", "zfs", "lvs", "vgs", "pvs", "ceph", "corosync-quorumtool", "corosync-cfgtool"].includes(c)).join(", ")} (systemctl, docker, apt and some others only with their read subcommands, e.g. systemctl status, docker ps/logs). For anything else use guest_exec.`,
    inputSchema: obj({ guest: GUEST, command: ARGV, timeout: int("Seconds (default 30, at most 120)") }, ["guest", "command"]),
    run: async (a, d) => {
      const argv = a.command as string[];
      const why = checkRead(argv, "guest");
      if (why) throw new Error(why);
      const g = await guest(d, a);
      return formatResult(await d.runner.inGuest(g, { argv }, n(a.timeout, 30, 1, 120)));
    },
  },
  {
    name: "node_read",
    kind: "read",
    description:
      "Run a read-only command on a Proxmox node over SSH, as root: the same commands as guest_read plus Proxmox and storage tools (pveversion, pvecm status, pvesm status, qm/pct list|config|status, zpool status|list, zfs list, ceph status, lvs/vgs/pvs, ha-manager status, pvesh get…). For anything else use node_exec.",
    inputSchema: obj({ node: NODE, command: ARGV, timeout: int("Seconds (default 30, at most 120)") }, ["node", "command"]),
    run: async (a, d) => {
      const argv = a.command as string[];
      const why = checkRead(argv, "node");
      if (why) throw new Error(why);
      nodePath(a.node);
      return formatResult(await d.runner.onNode(s(a.node), { argv }, n(a.timeout, 30, 1, 120)));
    },
  },

  // ---------------------------------------------------------------- changes (JARVIS asks first)
  {
    name: "guest_exec",
    kind: "write",
    description:
      "Run any shell command (sh -c, so pipes and && work) inside a VM (QEMU guest agent) or LXC container (pct exec), as root, and get its exit code and output. Can change anything in the guest.",
    inputSchema: obj({ guest: GUEST, command: str("Shell command, e.g. apt-get update && apt-get -y upgrade"), timeout: int("Seconds (default 60, at most 1800)") }, ["guest", "command"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      if (!s(a.command).trim()) throw new Error("command is empty");
      return formatResult(await d.runner.inGuest(g, { script: s(a.command) }, n(a.timeout, 60, 1, 1800)));
    },
  },
  {
    name: "node_exec",
    kind: "write",
    description: "Run any shell command on a Proxmox node over SSH, as root (sh -c). Can change anything on the node and the cluster.",
    inputSchema: obj({ node: NODE, command: str("Shell command"), timeout: int("Seconds (default 60, at most 1800)") }, ["node", "command"]),
    run: async (a, d) => {
      nodePath(a.node);
      if (!s(a.command).trim()) throw new Error("command is empty");
      return formatResult(await d.runner.onNode(s(a.node), { script: s(a.command) }, n(a.timeout, 60, 1, 1800)));
    },
  },
  {
    name: "guest_power",
    kind: "write",
    description: "Start, gracefully shut down, reboot, suspend or resume a VM or container. Waits up to 2 minutes for the task.",
    inputSchema: obj({ guest: GUEST, action: str("start, shutdown, reboot, suspend or resume", { enum: ["start", "shutdown", "reboot", "suspend", "resume"] }) }, ["guest", "action"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      const action = s(a.action);
      if (!["start", "shutdown", "reboot", "suspend", "resume"].includes(action)) throw new Error("action: start, shutdown, reboot, suspend or resume");
      const upid = await d.api.call<string>("POST", `${guestPath(g)}/status/${action}`);
      return taskResult(d, upid, 120, `${action} ${label(g)}`);
    },
  },
  {
    name: "snapshot_create",
    kind: "write",
    description: "Take a snapshot of a VM or container (e.g. before an upgrade).",
    inputSchema: obj({ guest: GUEST, name: str("Snapshot name, e.g. before_upgrade"), description: str("What it is for"), ram: bool("VMs: also save the RAM (slower, bigger)") }, ["guest", "name"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      const upid = await d.api.call<string>("POST", `${guestPath(g)}/snapshot`, { snapname: snapName(a.name), description: s(a.description) || undefined, vmstate: g.type === "qemu" && a.ram ? true : undefined });
      return taskResult(d, upid, 300, `Snapshot ${s(a.name)} of ${label(g)}`);
    },
  },
  {
    name: "backup_now",
    kind: "write",
    description: "Back up one guest now (vzdump, zstd). Without storage it uses the node's default backup storage.",
    inputSchema: obj({ guest: GUEST, storage: str("Backup storage (optional)"), mode: str("snapshot (default, no downtime), suspend or stop", { enum: ["snapshot", "suspend", "stop"] }), notes: str("Notes on the backup") }, ["guest"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      const upid = await d.api.call<string>("POST", `/nodes/${g.node}/vzdump`, {
        vmid: String(g.vmid),
        storage: s(a.storage) || undefined,
        mode: s(a.mode) || "snapshot",
        compress: "zstd",
        "notes-template": s(a.notes) || "{{guestname}} (JARVIS)",
      });
      return taskResult(d, upid, 60, `Backup of ${label(g)}`);
    },
  },
  {
    name: "guest_set",
    kind: "write",
    description: "Change a guest's resources or settings: cores, memory (MiB), swap (MiB, containers), start at boot, tags, description, name. Some changes need a reboot to apply (shown as pending).",
    inputSchema: obj(
      {
        guest: GUEST,
        cores: int("CPU cores", { minimum: 1, maximum: 512 }),
        memory: int("Memory in MiB", { minimum: 16 }),
        swap: int("Swap in MiB (containers)", { minimum: 0 }),
        onboot: bool("Start when the node boots"),
        tags: str("Tags separated by ; (replaces all)"),
        description: str("Notes shown in the web UI"),
        name: str("New name (hostname for containers)"),
      },
      ["guest"],
    ),
    run: async (a, d) => {
      const g = await guest(d, a);
      const p: Json = {};
      for (const k of ["cores", "memory", "onboot", "tags", "description"]) if (a[k] !== undefined) p[k] = a[k];
      if (a.swap !== undefined) {
        if (g.type !== "lxc") throw new Error("swap is only for containers");
        p.swap = a.swap;
      }
      if (a.name !== undefined) p[g.type === "lxc" ? "hostname" : "name"] = a.name;
      if (!Object.keys(p).length) throw new Error("Nothing to change.");
      const r = await d.api.call<string | null>(g.type === "qemu" ? "POST" : "PUT", `${guestPath(g)}/config`, p as Record<string, string>);
      if (typeof r === "string" && r.startsWith("UPID:")) return taskResult(d, r, 60, `Config of ${label(g)}`);
      const pending = await d.api.call<Json[]>("GET", `${guestPath(g)}/pending`).catch(() => [] as Json[]);
      const waiting = pending.filter((x) => x.pending !== undefined).map((x) => s(x.key));
      return `Config of ${label(g)} changed: ${Object.keys(p).join(", ")}.${waiting.length ? ` Pending until reboot: ${waiting.join(", ")}.` : ""}`;
    },
  },
  {
    name: "migrate",
    kind: "write",
    description: "Move a guest to another node (VMs live when running and online is true; containers restart).",
    inputSchema: obj({ guest: GUEST, target: str("Target node"), online: bool("VMs: live migration (default true when running)") }, ["guest", "target"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      nodePath(a.target);
      const running = g.status === "running";
      const p = g.type === "qemu" ? { target: s(a.target), online: running && a.online !== false } : { target: s(a.target), restart: running };
      const upid = await d.api.call<string>("POST", `${guestPath(g)}/migrate`, p);
      return taskResult(d, upid, 120, `Migration of ${label(g)} to ${s(a.target)}`);
    },
  },

  // ---------------------------------------------------------------- destructive (only with PVE_ALLOW_DESTRUCTIVE=1)
  {
    name: "guest_stop_hard",
    kind: "danger",
    description: "Hard stop (pull the plug) or reset a VM or container that does not shut down. Unsaved data in it is lost.",
    inputSchema: obj({ guest: GUEST, action: str("stop (default) or reset (VMs)", { enum: ["stop", "reset"] }) }, ["guest"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      const action = a.action === "reset" ? "reset" : "stop";
      if (action === "reset" && g.type !== "qemu") throw new Error("reset is only for VMs");
      const r = await d.api.call<string>("POST", `${guestPath(g)}/status/${action}`);
      return action === "reset" ? `Reset ${label(g)}.` : taskResult(d, r, 60, `Hard stop of ${label(g)}`);
    },
  },
  {
    name: "snapshot_rollback",
    kind: "danger",
    description: "Roll a guest back to a snapshot. Everything since that snapshot is lost.",
    inputSchema: obj({ guest: GUEST, name: str("Snapshot name"), start: bool("Start it afterwards") }, ["guest", "name"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      const upid = await d.api.call<string>("POST", `${guestPath(g)}/snapshot/${snapName(a.name)}/rollback`, { start: a.start ? true : undefined });
      return taskResult(d, upid, 300, `Rollback of ${label(g)} to ${s(a.name)}`);
    },
  },
  {
    name: "snapshot_delete",
    kind: "danger",
    description: "Delete a guest's snapshot.",
    inputSchema: obj({ guest: GUEST, name: str("Snapshot name") }, ["guest", "name"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      const upid = await d.api.call<string>("DELETE", `${guestPath(g)}/snapshot/${snapName(a.name)}`);
      return taskResult(d, upid, 300, `Deleting snapshot ${s(a.name)} of ${label(g)}`);
    },
  },
  {
    name: "guest_delete",
    kind: "danger",
    description: "Delete a stopped VM or container and its disks, for good. Backups are kept.",
    inputSchema: obj({ guest: GUEST, confirm_name: str("The guest's current name, typed again as a check") }, ["guest", "confirm_name"]),
    run: async (a, d) => {
      const g = await guest(d, a);
      if (s(a.confirm_name) !== g.name) throw new Error(`confirm_name must be "${g.name}"`);
      if (g.status !== "stopped") throw new Error(`${label(g)} is ${g.status}; stop it first.`);
      const upid = await d.api.call<string>("DELETE", guestPath(g), { purge: true, "destroy-unreferenced-disks": true });
      return taskResult(d, upid, 300, `Deleting ${label(g)}`);
    },
  },
  {
    name: "api_call",
    kind: "danger",
    description: "Any POST, PUT or DELETE on the Proxmox API, for what no other tool does. Returns the reply as JSON.",
    inputSchema: obj(
      {
        method: str("POST, PUT or DELETE", { enum: ["POST", "PUT", "DELETE"] }),
        path: str("API path after /api2/json"),
        params: { type: "object", description: "Parameters", additionalProperties: { type: ["string", "number", "boolean", "array"] } },
      },
      ["method", "path"],
    ),
    run: async (a, d) => {
      const m = s(a.method);
      if (m !== "POST" && m !== "PUT" && m !== "DELETE") throw new Error("method: POST, PUT or DELETE");
      return json(await d.api.call(m, apiPath(a.path), (a.params as Record<string, string>) ?? {}));
    },
  },
];

function num(v: unknown): number {
  return Number(v) || 0;
}

function apiPath(v: unknown): string {
  const p = s(v).trim();
  if (!p.startsWith("/") || p.includes("..") || /[?#\s]/.test(p)) throw new Error("path: an API path such as /nodes/pve/status (parameters go in params)");
  return p.replace(/^\/api2\/json/, "");
}

/** Shared storages appear once per node in /cluster/resources; keep one row. */
function dedupeShared(rows: Res[]): Res[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!r.shared) return true;
    const k = s(r.storage);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const listTools = (allowDestructive: boolean) => TOOLS.filter((t) => t.kind !== "danger" || allowDestructive);

export type { Guest };
