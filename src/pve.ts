import https from "node:https";

// A thin Proxmox VE API client (API token auth). Every call returns the `data` field of the reply.

export type Params = Record<string, string | number | boolean | string[] | undefined | null>;
export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface Api {
  call<T = unknown>(method: Method, path: string, params?: Params): Promise<T>;
}

export type Guest = {
  vmid: number;
  name: string;
  node: string;
  type: "qemu" | "lxc";
  status: string;
  template?: number;
  [k: string]: unknown;
};

export class PveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Form encoding as pvesh does it: arrays repeat the key, booleans are 1/0, empty values are left out. */
export function encodeParams(params: Params = {}): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) p.append(k, item);
    else p.append(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  return p;
}

export class PveClient implements Api {
  private agent: https.Agent;
  private base: URL;
  private auth: string;

  constructor(opts: { url: string; tokenId: string; tokenSecret: string; insecure?: boolean; ca?: string }) {
    this.base = new URL(`${opts.url}/api2/json`);
    this.auth = `PVEAPIToken=${opts.tokenId}=${opts.tokenSecret}`;
    this.agent = new https.Agent({ keepAlive: true, rejectUnauthorized: !opts.insecure, ca: opts.ca });
  }

  call<T = unknown>(method: Method, path: string, params: Params = {}): Promise<T> {
    const body = encodeParams(params).toString();
    const url = new URL(this.base.href + path);
    if ((method === "GET" || method === "DELETE") && body) url.search = body;
    const sendBody = method === "POST" || method === "PUT";
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          agent: this.agent,
          timeout: 60_000,
          headers: {
            authorization: this.auth,
            accept: "application/json",
            ...(sendBody ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            let json: { data?: unknown; errors?: Record<string, string>; message?: string } = {};
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              /* not JSON: the status line says enough */
            }
            if (status >= 200 && status < 300) return resolve(json.data as T);
            const details = json.errors ? ` ${Object.entries(json.errors).map(([k, v]) => `${k}: ${String(v).trim()}`).join("; ")}` : "";
            const reason = (res.statusMessage || json.message || text || "").toString().trim().slice(0, 500);
            reject(new PveError(status, `Proxmox ${method} ${path} failed (${status}): ${reason}${details}`));
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`Proxmox ${method} ${path} timed out`)));
      req.on("error", reject);
      if (sendBody) req.write(body);
      req.end();
    });
  }
}

/** Finds a guest by vmid or name (one cluster-wide lookup, so the node and type need not be known). */
export async function findGuest(api: Api, ref: string | number): Promise<Guest> {
  const list = await api.call<Guest[]>("GET", "/cluster/resources", { type: "vm" });
  const s = String(ref).trim();
  const byId = /^\d+$/.test(s) ? list.find((g) => g.vmid === Number(s)) : undefined;
  if (byId) return byId;
  const byName = list.filter((g) => g.name?.toLowerCase() === s.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`Several guests are named "${s}": ${byName.map((g) => g.vmid).join(", ")}. Use the vmid.`);
  throw new Error(`No VM or container "${s}". The overview tool lists them.`);
}

export const guestPath = (g: Guest) => `/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}`;

/** The node a task ran on, from its UPID (UPID:node:pid:...). */
export function upidNode(upid: string): string {
  const m = /^UPID:([^:]+):/.exec(upid);
  if (!m) throw new Error(`"${upid}" is not a task id (UPID:node:...)`);
  return m[1];
}

/** Waits for a task to finish, up to `ms`. Returns its status (exitstatus OK on success), or null if still running. */
export async function waitTask(api: Api, upid: string, ms: number): Promise<{ status: string; exitstatus?: string } | null> {
  const node = upidNode(upid);
  const end = Date.now() + ms;
  for (;;) {
    const st = await api.call<{ status: string; exitstatus?: string }>("GET", `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
    if (st.status === "stopped") return st;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
