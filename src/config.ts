// Everything comes from the environment (the stack's .env). Startup fails loudly when something required is missing.

export type Config = {
  port: number;
  /** Bearer token JARVIS sends. 32+ characters, separate from the Proxmox token. */
  mcpToken: string;
  pveUrl: string;
  pveTokenId: string;
  pveTokenSecret: string;
  /** Skip TLS verification of the Proxmox API (self-signed certificate on a LAN). */
  pveInsecure: boolean;
  /** PEM of the cluster CA (/etc/pve/pve-root-ca.pem), to verify the API properly instead. */
  pveCa?: string;
  dataDir: string;
  sshUser: string;
  sshPort: number;
  /** node name -> address, overriding the IPs from /cluster/status. */
  sshHosts: Record<string, string>;
  /** List the tools that delete, roll back or hard-stop things. Off unless PVE_ALLOW_DESTRUCTIVE=1. */
  allowDestructive: boolean;
};

const truthy = (v: string | undefined) => /^(1|true|yes)$/i.test(v ?? "");

export function parseHosts(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(/[,\s]+/)) {
    if (!part) continue;
    const [name, host] = part.split("=");
    if (!name || !host) throw new Error(`SSH_HOSTS: "${part}" is not node=address`);
    out[name.trim()] = host.trim();
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const mcpToken = need("MCP_TOKEN");
  if (mcpToken.length < 32) throw new Error("MCP_TOKEN must be at least 32 characters (openssl rand -hex 32)");
  const pveTokenSecret = need("PVE_TOKEN_SECRET");
  if (mcpToken === pveTokenSecret) throw new Error("MCP_TOKEN must differ from PVE_TOKEN_SECRET");
  const pveUrl = need("PVE_URL").replace(/\/+$/, "");
  if (!/^https:\/\//.test(pveUrl)) throw new Error("PVE_URL must start with https:// (e.g. https://192.168.1.10:8006)");
  return {
    port: Number(env.PORT ?? 8080),
    mcpToken,
    pveUrl,
    pveTokenId: need("PVE_TOKEN_ID"),
    pveTokenSecret,
    pveInsecure: truthy(env.PVE_INSECURE),
    pveCa: env.PVE_CA?.replace(/\\n/g, "\n") || undefined,
    dataDir: env.DATA_DIR ?? "/data",
    sshUser: env.SSH_USER ?? "root",
    sshPort: Number(env.SSH_PORT ?? 22),
    sshHosts: parseHosts(env.SSH_HOSTS),
    allowDestructive: truthy(env.PVE_ALLOW_DESTRUCTIVE),
  };
}
