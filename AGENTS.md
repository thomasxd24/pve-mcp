# pve-mcp – notes for agents

JARVIS's Proxmox integration. Keep it small: one runtime dependency (ssh2), no framework, no build step (Node 24 strips types).

- `src/pve.ts`: Proxmox API client (token auth), guest lookup, task wait
- `src/ssh.ts`: SSH to nodes (key made in /data/ssh, host keys pinned)
- `src/exec.ts`: where commands run (node SSH, `pct exec` for LXC, guest agent for VMs)
- `src/guard.ts`: the read-only allow-list for `guest_read` / `node_read`. Security-sensitive: anything added must not change state, follow forever, or read commands from a file. Add a test in `test/guard.test.ts` for every change.
- `src/tools.ts`: the tools. `kind`: read (JARVIS allows), write (asks), danger (only listed with PVE_ALLOW_DESTRUCTIVE=1).
- `src/mcp.ts`: JSON-RPC over POST /mcp, Bearer token.

Rules: run `npm run check` before pushing. Direct pushes to `main` are fine, except changes to `guard.ts`, auth in `mcp.ts`, or a tool's `kind`, which need a PR. CI builds `ghcr.io/thomasxd24/pve-mcp:latest`; it runs as the `pve-mcp` stack.
