# pve-mcp

A small MCP server so JARVIS can run Thomas's Proxmox VE cluster: read everything, run commands on nodes and **inside VMs and LXC containers**, and do the everyday actions (power, snapshots, backups, resources, migration). Destructive tools are not even listed unless `PVE_ALLOW_DESTRUCTIVE=1`.

- **VMs**: commands go through the QEMU guest agent API (no SSH or keys in the VM).
- **LXC containers**: the Proxmox API has no exec, so the server SSHes to the container's node and runs `pct exec <vmid> -- …`.
- **Nodes**: SSH as root.
- Transport: stateless Streamable HTTP, `POST /mcp` with `Authorization: Bearer $MCP_TOKEN`. `GET /healthz` is open.

The SSH key is generated inside the container on first start (`/data/ssh`) and never leaves it. Node host keys are pinned on first use; a changed key is refused.

## Tools

| Tier | Tools | JARVIS policy |
|---|---|---|
| Read | `overview`, `node_status`, `guest`, `guest_ip`, `storage`, `backups`, `snapshots`, `tasks`, `task_log`, `metrics`, `node_log`, `cluster_log`, `disks`, `updates`, `ha_status`, `api_get`, `ssh_public_key`, `guest_read`, `node_read` | Allow |
| Change | `guest_exec`, `node_exec`, `guest_power`, `snapshot_create`, `backup_now`, `guest_set`, `migrate` | Ask |
| Destructive (hidden by default) | `guest_stop_hard`, `snapshot_rollback`, `snapshot_delete`, `guest_delete`, `api_call` | Block |

`guest_read` / `node_read` take an argv array and only run commands on an allow-list of read-only commands and subcommands (`src/guard.ts`): `cat`, `ls`, `df`, `systemctl status`, `journalctl`, `docker ps/logs`, `zpool status`… No shell is involved, so `;`, `|` and `$( )` are plain text. Everything else goes through `guest_exec` / `node_exec`.

## Setup

1. **API token** (on a node, as root):
   ```sh
   pveum user add jarvis@pve --comment "JARVIS"
   pveum acl modify / --users jarvis@pve --roles Administrator
   pveum user token add jarvis@pve mcp --privsep 0
   ```
   Copy the secret it prints (shown once). Token id: `jarvis@pve!mcp`.
2. **Guest agent** in each VM: `apt install qemu-guest-agent && systemctl enable --now qemu-guest-agent`, then in Proxmox *VM → Options → QEMU Guest Agent → Enabled* (or `qm set <vmid> --agent 1`) and a full stop/start of the VM.
3. **Stack**: `deploy/docker-compose.yml` plus a `.env` from `.env.example` (`MCP_TOKEN=$(openssl rand -hex 32)`). It joins JARVIS's network (`jarvis_default`), no port published.
4. **SSH key**: after the first start, `docker logs pve-mcp | grep ssh_public_key` (or the `ssh_public_key` tool) and add it to `/root/.ssh/authorized_keys` on the nodes (in a cluster that file is shared, so once).
5. **JARVIS**: Integrations → add HTTP integration `proxmox`, URL `http://pve-mcp:8080/mcp`, header `Authorization: Bearer <MCP_TOKEN>`, default policy *allow reads*.

## Development

Node 24 runs the TypeScript directly (type stripping), so there is no build step.

```sh
npm install
npm run check   # tsc + node --test
```
