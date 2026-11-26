import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";

// SSH to the Proxmox nodes, for commands on a node and inside LXC containers (pct exec). The key is made inside this
// container on first start and never leaves it: only the public half is shown (ssh_public_key tool, and the log).
// Host keys are trusted on first use and pinned in known_hosts.json; a changed key is refused.

export type ExecResult = { code: number | null; signal?: string; stdout: string; stderr: string; truncated: boolean };

export interface Shell {
  exec(host: string, command: string, timeoutMs: number): Promise<ExecResult>;
  publicKey(): string;
}

const MAX_BYTES = 512 * 1024;

/** Single-quotes a word for a POSIX shell. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class SshShell implements Shell {
  private key: string;
  private pub: string;
  private knownFile: string;
  private known: Record<string, string>;
  private user: string;
  private port: number;

  constructor(opts: { dataDir: string; user: string; port: number }) {
    const dir = path.join(opts.dataDir, "ssh");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyFile = path.join(dir, "id_ed25519");
    if (!existsSync(keyFile)) {
      const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: "pve-mcp" });
      writeFileSync(keyFile, pair.private, { mode: 0o600 });
      writeFileSync(`${keyFile}.pub`, `${pair.public}\n`);
    }
    this.key = readFileSync(keyFile, "utf8");
    this.pub = readFileSync(`${keyFile}.pub`, "utf8").trim();
    this.knownFile = path.join(dir, "known_hosts.json");
    this.known = existsSync(this.knownFile) ? JSON.parse(readFileSync(this.knownFile, "utf8")) : {};
    this.user = opts.user;
    this.port = opts.port;
  }

  publicKey(): string {
    return this.pub;
  }

  private verify(host: string, key: Buffer): boolean {
    const fp = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
    const id = `${host}:${this.port}`;
    const pinned = this.known[id];
    if (!pinned) {
      this.known[id] = fp;
      writeFileSync(this.knownFile, JSON.stringify(this.known, null, 2));
      console.log(JSON.stringify({ event: "ssh_host_pinned", host: id, fingerprint: fp }));
      return true;
    }
    if (pinned !== fp) console.error(JSON.stringify({ event: "ssh_host_key_changed", host: id, pinned, got: fp }));
    return pinned === fp;
  }

  exec(host: string, command: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const conn = new ssh2.Client();
      let out: Buffer = Buffer.alloc(0);
      let err: Buffer = Buffer.alloc(0);
      let truncated = false;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.end();
        fn();
      };
      const add = (buf: Buffer, chunk: Buffer): Buffer => {
        if (buf.length >= MAX_BYTES) {
          truncated = true;
          return buf;
        }
        const next = Buffer.concat([buf, chunk]);
        if (next.length > MAX_BYTES) truncated = true;
        return next.subarray(0, MAX_BYTES) as Buffer;
      };
      // The remote command has its own `timeout`; this one is the backstop (+15 s) for a hung connection.
      const timer = setTimeout(() => done(() => reject(new Error(`SSH to ${host} timed out`))), timeoutMs + 15_000);
      conn
        .on("ready", () => {
          conn.exec(command, (e, stream) => {
            if (e) return done(() => reject(e));
            stream
              .on("close", (code: number | null, signal?: string) =>
                done(() => resolve({ code, signal, stdout: out.toString("utf8"), stderr: err.toString("utf8"), truncated })),
              )
              .on("data", (c: Buffer) => {
                out = add(out, c);
              });
            stream.stderr.on("data", (c: Buffer) => {
              err = add(err, c);
            });
          });
        })
        .on("error", (e) => done(() => reject(new Error(`SSH to ${host}: ${e.message}`))))
        .connect({
          host,
          port: this.port,
          username: this.user,
          privateKey: this.key,
          readyTimeout: 15_000,
          hostVerifier: (key: Buffer) => this.verify(host, key),
        });
    });
  }
}
