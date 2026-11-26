import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRead } from "../src/guard.ts";

const ok = (argv: string[], scope: "guest" | "node" = "guest") => assert.equal(checkRead(argv, scope), null, argv.join(" "));
const no = (argv: string[], scope: "guest" | "node" = "guest") => assert.notEqual(checkRead(argv, scope), null, argv.join(" "));

test("read-only commands pass", () => {
  ok(["df", "-h"]);
  ok(["cat", "/etc/os-release"]);
  ok(["systemctl", "status", "nginx"]);
  ok(["systemctl", "--no-pager", "status", "nginx"]);
  ok(["systemctl", "--failed"]);
  ok(["journalctl", "-u", "nginx", "-n", "50", "--no-pager"]);
  ok(["docker", "ps", "-a"]);
  ok(["docker", "logs", "--tail", "100", "web"]);
  ok(["docker", "compose", "ps"]);
  ok(["tail", "-n", "20", "/var/log/syslog"]);
  ok(["ip", "addr"]);
  ok(["ip", "-br", "a"]);
  ok(["find", "/etc", "-name", "*.conf"]);
  ok(["apt", "list", "--upgradable"]);
  ok(["dpkg", "-l"]);
  ok(["crontab", "-l"]);
  ok(["smartctl", "-a", "/dev/sda"], "node");
  ok(["zpool", "status"], "node");
  ok(["qm", "list"], "node");
  ok(["pvesh", "get", "/cluster/resources"], "node");
});

test("anything that changes or follows is refused", () => {
  no([]);
  no(["rm", "-rf", "/"]);
  no(["sh", "-c", "id"]);
  no(["bash"]);
  no(["systemctl", "restart", "nginx"]);
  no(["systemctl", "--no-pager", "stop", "nginx"]);
  no(["systemctl"]);
  no(["journalctl", "-f"]);
  no(["journalctl", "--vacuum-time=1d"]);
  no(["tail", "-f", "/var/log/syslog"]);
  no(["tail", "-fn", "10", "/var/log/syslog"]);
  no(["docker", "rm", "web"]);
  no(["docker", "compose", "down"]);
  no(["docker", "compose", "logs", "-f"]);
  no(["docker", "run", "alpine"]);
  no(["docker", "exec", "web", "sh"]);
  no(["find", "/", "-delete"]);
  no(["find", "/", "-exec", "rm", "{}", ";"]);
  no(["ip", "link", "set", "eth0", "down"]);
  no(["ip", "route", "add", "default", "via", "1.2.3.4"]);
  no(["apt", "install", "curl"]);
  no(["dpkg", "-i", "x.deb"]);
  no(["dpkg", "--purge", "x"]);
  no(["crontab"]);
  no(["crontab", "-r"]);
  no(["dmesg", "-C"]);
  no(["hostname", "evil"]);
  no(["date", "-s", "2020-01-01"]);
  no(["smartctl", "-t", "long", "/dev/sda"], "node");
  no(["qm", "destroy", "100"], "node");
  no(["pct", "exec", "100", "--", "rm"], "node");
  no(["pvesh", "set", "/x"], "node");
  no(["zpool", "destroy", "tank"], "node");
  no(["ceph", "osd", "out", "1"], "node");
  no(["cat", "a\nrm -rf /"]);
});

test("Proxmox tools only on nodes", () => {
  no(["qm", "list"], "guest");
  no(["zpool", "status"], "guest");
});

test("tricky ones", () => {
  no(["ip", "-b", "/tmp/cmds"]);
  no(["ip", "-batch", "/tmp/cmds"]);
  ok(["ip", "-br", "link"]);
  no(["sensors", "-s"]);
  no(["docker", "compose", "build"]);
  no(["docker", "compose", "pause"]);
  no(["ceph", "osd", "reweight-by-utilization"], "node");
  ok(["ceph", "health"], "node");
});
