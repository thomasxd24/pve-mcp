import { loadConfig } from "./config.ts";
import { Runner } from "./exec.ts";
import { createServer } from "./mcp.ts";
import { PveClient } from "./pve.ts";
import { SshShell } from "./ssh.ts";

const config = loadConfig();
const api = new PveClient({ url: config.pveUrl, tokenId: config.pveTokenId, tokenSecret: config.pveTokenSecret, insecure: config.pveInsecure, ca: config.pveCa });
const shell = new SshShell({ dataDir: config.dataDir, user: config.sshUser, port: config.sshPort });
const runner = new Runner(api, shell, { sshHosts: config.sshHosts, pveUrl: config.pveUrl });
const server = createServer({ api, runner, shell, config }, config.mcpToken);

server.listen(config.port, () => {
  console.log(JSON.stringify({ event: "listening", port: config.port, destructive: config.allowDestructive }));
  console.log(JSON.stringify({ event: "ssh_public_key", key: shell.publicKey() }));
});
api
  .call<{ version: string }>("GET", "/version")
  .then((v) => console.log(JSON.stringify({ event: "proxmox_ok", version: v.version })))
  .catch((e) => console.error(JSON.stringify({ event: "proxmox_unreachable", error: String(e.message ?? e) })));

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
