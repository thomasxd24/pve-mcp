// Small helpers to turn API numbers into short, readable text (tool results are read by a model, so keep them compact).

export function bytes(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  const units = ["B", "K", "M", "G", "T", "P"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)}${units[i]}`;
}

export const pct = (used: unknown, total: unknown) => {
  const u = Number(used);
  const t = Number(total);
  return t > 0 ? `${Math.round((u / t) * 100)}%` : "-";
};

export function duration(s: unknown): string {
  const v = Math.floor(Number(s) || 0);
  if (v <= 0) return "-";
  const d = Math.floor(v / 86400);
  const h = Math.floor((v % 86400) / 3600);
  const m = Math.floor((v % 3600) / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${m}m` : `${m}m`;
}

export const time = (epoch: unknown) => {
  const v = Number(epoch);
  return v > 0 ? new Date(v * 1000).toISOString().replace("T", " ").slice(0, 16) : "-";
};

/** A plain text table: header row, then one row per item. */
export function table(head: string[], rows: (string | number | undefined | null)[][]): string {
  const cells = [head, ...rows.map((r) => r.map((c) => (c === undefined || c === null || c === "" ? "-" : String(c))))];
  const widths = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ")).join("\n");
}

const MAX_JSON = 40_000;
export function json(v: unknown): string {
  const s = JSON.stringify(v, null, 1);
  return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}\n… (cut: ${s.length} characters in all; ask for less)` : s;
}
