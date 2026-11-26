// The allow-list behind guest_read and node_read: commands that only look, so JARVIS can run them without asking.
// The command is an argv array, never a shell string: it is executed without a shell inside the guest (pct exec and
// the guest agent exec it directly; the node's shell only sees single-quoted words), so ; | > $( ) are plain text.
// Anything not allowed here goes through guest_exec / node_exec, which ask first.

type Rule = {
  /** First argument that is not a flag must be one of these (e.g. systemctl status). */
  sub?: string[];
  /** When set, every argument starting with "-" must be in this list (e.g. smartctl). */
  flags?: string[];
  /** Arguments (exact, or `--x` matching `--x=...`) that are refused. */
  ban?: string[];
  /** Arguments matching this are refused. */
  banRe?: RegExp;
  /** Words refused anywhere in the arguments (e.g. ip ... add). */
  banWords?: string[];
  /** Must have no arguments at all, or only these. */
  only?: string[];
  /** With only: at least one argument is required (crontab alone would read a new crontab from stdin). */
  need?: boolean;
  scope?: "node";
};

const FOLLOW = ["-f", "-F", "--follow", "--retry"];
const IP_WRITES = ["add", "del", "delete", "set", "flush", "change", "replace", "append", "restore", "prepend", "exec", "netns", "save"];

const RULES: Record<string, Rule> = {
  // files and text
  cat: {},
  head: {},
  tail: { ban: FOLLOW },
  ls: {},
  stat: {},
  file: {},
  wc: {},
  grep: {},
  egrep: {},
  zgrep: {},
  zcat: {},
  du: {},
  readlink: {},
  realpath: {},
  find: { ban: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"] },
  md5sum: {},
  sha256sum: {},
  // system
  df: {},
  free: {},
  uptime: {},
  uname: {},
  hostname: { only: ["-f", "-I", "-i", "-s", "-A", "--fqdn", "--all-ip-addresses"] },
  date: { only: ["-u", "-R", "-I", "--iso-8601", "--utc"] },
  id: {},
  whoami: {},
  w: {},
  who: {},
  last: {},
  ps: {},
  pgrep: {},
  pstree: {},
  nproc: {},
  lscpu: {},
  lsblk: {},
  blkid: {},
  findmnt: {},
  lspci: {},
  lsusb: {},
  lsof: {},
  vmstat: {},
  iostat: {},
  sensors: { ban: ["-s", "--set"] },
  printenv: {},
  getent: {},
  mount: { only: ["-l", "--show-labels"] },
  dmesg: { ban: ["-c", "-C", "-D", "-E", "-n", "--clear", "--read-clear", "--console-off", "--console-on", "--console-level", "-w", "--follow", "-W", "--follow-new"] },
  crontab: { only: ["-l"], need: true },
  // network
  // ip takes abbreviated options: -b/-ba/-batch read commands from a file, -br is --brief.
  ip: { banWords: IP_WRITES, banRe: /^--?(b|ba|bat|batc|batch)$/ },
  ss: { ban: ["-K", "--kill"] },
  netstat: {},
  dig: {},
  host: {},
  nslookup: {},
  // services and logs
  systemctl: {
    sub: ["status", "is-active", "is-enabled", "is-failed", "is-system-running", "list-units", "list-timers", "list-unit-files", "list-sockets", "show", "cat", "--failed"],
  },
  journalctl: {
    ban: ["-f", "--follow", "--rotate", "--flush", "--sync", "--relinquish-var", "--smart-relinquish-var", "--setup-keys", "--update-catalog", "--vacuum-size", "--vacuum-time", "--vacuum-files"],
  },
  timedatectl: { sub: ["status", "show", "timesync-status", "show-timesync"] },
  hostnamectl: { sub: ["status"] },
  // packages
  apt: { sub: ["list", "policy", "show"] },
  "apt-cache": { sub: ["policy", "show", "search", "depends", "rdepends"] },
  dpkg: { flags: ["-l", "-s", "-L", "-S", "--list", "--status", "--listfiles", "--search", "--get-selections"] },
  // docker
  docker: {
    sub: ["ps", "logs", "images", "inspect", "stats", "version", "info", "top", "port", "compose", "network", "volume", "system"],
    ban: [...FOLLOW, "rm", "prune", "create", "up", "down", "restart", "stop", "start", "kill", "pull", "connect", "disconnect", "exec", "run", "rmi",
      "build", "push", "cp", "pause", "unpause", "scale", "watch", "update", "rename", "commit", "tag", "attach", "kill", "wait", "events", "--watch", "-w",
    ],
  },
  // disks
  smartctl: { flags: ["-a", "-H", "-i", "-x", "-A", "-l", "-c", "-j", "--all", "--health", "--info", "--xall", "--attributes", "--log", "--capabilities", "--json", "-d", "--device", "--scan"] },
  // Proxmox node tools (node_read only)
  pveversion: { scope: "node" },
  pvecm: { scope: "node", sub: ["status", "nodes"] },
  pvesm: { scope: "node", sub: ["status", "list", "path"] },
  pvesh: { scope: "node", sub: ["get", "ls", "usage"] },
  qm: { scope: "node", sub: ["list", "config", "status", "pending", "listsnapshot", "showcmd"] },
  pct: { scope: "node", sub: ["list", "config", "status", "pending", "listsnapshot", "df"] },
  "ha-manager": { scope: "node", sub: ["status", "config"] },
  "pve-firewall": { scope: "node", sub: ["status"] },
  zpool: { scope: "node", sub: ["status", "list", "iostat", "get", "history"] },
  zfs: { scope: "node", sub: ["list", "get"] },
  lvs: { scope: "node" },
  vgs: { scope: "node" },
  pvs: { scope: "node" },
  ceph: { scope: "node", sub: ["status", "health", "df", "-s", "versions"] },
  "corosync-quorumtool": { scope: "node", only: ["-s", "-l", "-p"] },
  "corosync-cfgtool": { scope: "node", only: ["-s", "-n"] },
};

export const READ_COMMANDS = Object.keys(RULES);

/** Why argv may not run read-only here, or null when it may. */
export function checkRead(argv: string[], scope: "guest" | "node"): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return "command is empty: give it as an array, e.g. [\"df\", \"-h\"]";
  if (argv.some((a) => typeof a !== "string")) return "every word of the command must be a string";
  if (argv.some((a) => /[\0\n\r]/.test(a))) return "no newlines in a read-only command";
  const [cmd, ...args] = argv;
  const rule = RULES[cmd];
  const other = scope === "guest" ? "guest_exec" : "node_exec";
  if (!rule || (rule.scope === "node" && scope !== "node"))
    return `"${cmd}" is not on the read-only list (${scope}). Use ${other} instead, which asks first.`;
  if (rule.need && args.length === 0) return `${cmd} needs ${rule.only?.join(" or ")} here.`;
  if (rule.only && args.some((a) => !rule.only?.includes(a))) return `${cmd} only allows ${rule.only.length ? rule.only.join(" ") : "no arguments"} here. Use ${other}.`;
  if (rule.sub) {
    const sub = args.find((a) => !a.startsWith("-") || rule.sub?.includes(a));
    if (!sub || !rule.sub.includes(sub)) return `${cmd} ${sub ?? ""} is not read-only here; allowed: ${rule.sub.join(", ")}. Use ${other}.`;
  }
  if (rule.flags) {
    const bad = args.find((a) => a.startsWith("-") && !rule.flags?.includes(a.split("=")[0]));
    if (bad) return `${cmd} ${bad} is not allowed read-only. Use ${other}.`;
  }
  if (rule.ban) {
    const bad = args.find((a) => rule.ban?.some((b) => a === b || (b.startsWith("--") && a.startsWith(`${b}=`))));
    if (bad) return `${cmd} ${bad} is not allowed read-only. Use ${other}.`;
    // Combined short flags such as -fn for tail/dmesg.
    const shorts = rule.ban.filter((b) => /^-[a-zA-Z]$/.test(b)).map((b) => b[1]);
    const combo = args.find((a) => /^-[a-zA-Z]{2,}$/.test(a) && [...a.slice(1)].some((ch) => shorts.includes(ch)));
    if (combo) return `${cmd} ${combo} is not allowed read-only. Use ${other}.`;
  }
  if (rule.banRe) {
    const bad = args.find((a) => rule.banRe?.test(a));
    if (bad) return `${cmd} ${bad} is not allowed read-only. Use ${other}.`;
  }
  if (rule.banWords) {
    const bad = args.find((a) => rule.banWords?.includes(a));
    if (bad) return `${cmd} ... ${bad} changes something. Use ${other}.`;
  }
  return null;
}
