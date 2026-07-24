# kmc — multi-cluster KubeVirt console

Local web console for listing and managing KubeVirt virtual machines across Kubernetes clusters. Single React Router app (loaders, actions, resource routes).

## Stack

- React Router 8 (framework mode, SSR)
- TypeScript + Vite
- Mantine (dark) + Geist Mono
- `@kubernetes/client-node` (server-only)

## Layout

```
app/
  routes/           # React Router route modules
  lib/
    auth/           # session, GitHub OAuth, actor + root middleware
    k8s/            # clients, cluster registry, catalog, events, yaml
  ui/               # shared UI primitives
  shell/            # app chrome, refresh control, loading bar
  vms/ datavolumes/ instancetypes/ ssh-keys/
config/
  clusters.example.yaml
  clusters.yaml     # local (gitignored) — apiServer + SA tokens
  secrets/          # local (gitignored) — platform SA tokens
deploy/impersonator/  # cluster-side SA + impersonate + settings RBAC
```

## Prerequisites

- Node 22+
- pnpm
- Working `kubectl` against your clusters (OIDC/exec auth is fine for local mode)

Default clusters: `prod-sjc1`, `homelab`.

## Setup (local / kubeconfig mode)

```bash
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173).

Default **auth mode is `kubeconfig`**: no login, API calls use your local kubeconfig contexts (same as before).

## Auth modes

| Mode                     | `KMC_AUTH_MODE`       | Behavior                                                                                                                                                                                                                        |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **kubeconfig** (default) | `kubeconfig` or unset | Uses local kubeconfig. Optional GitHub login only for `/me` identity preview.                                                                                                                                                   |
| **impersonate**          | `impersonate`         | Requires GitHub login. When `KMC_GITHUB_ORGS` is set, login is denied unless the user is a member of one of those orgs. Calls each cluster with a platform ServiceAccount and `Impersonate-User` / `Impersonate-Group` headers. |

### Identity mapping (impersonate)

GitHub session → Kubernetes principal (matches apiserver OIDC shape):

| Claim                                     | Header                                    |
| ----------------------------------------- | ----------------------------------------- |
| primary verified email                    | `Impersonate-User: oidc:<email>`          |
| org teams (filtered by `KMC_GITHUB_ORGS`) | `Impersonate-Group: oidc:<org>:<team>`    |
| always                                    | `Impersonate-Group: system:authenticated` |

Example: `oidc:me@ianunruh.com` + `oidc:kcloud-ops:k8s-admins`.

Auth is applied once in **root middleware** (`app/lib/auth/middleware.server.ts`). Loaders/actions stay flat — `getClusterClients()` reads the request-scoped actor from AsyncLocalStorage.

### Platform SA (already applied on prod-sjc1 / homelab)

Manifests live in `deploy/impersonator/rbac.yaml` (`kmc-system` namespace, SA `kmc`, ClusterRole `kmc-impersonator`). The SA only needs **impersonate** rights; effective power comes from the impersonated user/groups (e.g. existing `oidc-cluster-admin` binding).

Mint a token:

```bash
kubectl --context=homelab -n kmc-system create token kmc --duration=8760h \
  > config/secrets/homelab.token
```

### Cluster registry

```bash
cp config/clusters.example.yaml config/clusters.yaml
# point tokenFile / tokenEnv at your SA tokens
```

Example entry:

```yaml
clusters:
  - id: homelab
    displayName: homelab
    apiServer: https://kubernetes.den1.kcloud.zone:6443
    caData: LS0t...
    tokenFile: config/secrets/homelab.token
    # Optional — enables VM metrics graphs (KubeVirt VMI metrics)
    prometheusUrl: https://prometheus.example.com
    # Optional — scan-derived IPv4 pools for Multus bridge networks
    ipPools:
      - id: public
        multusNetwork: bridge-external
        cidr: 74.82.62.0/24
        gateway: 74.82.62.1
        dns: [8.8.8.8, 1.1.1.1]
    # Optional — VLAN pool for self-service VPCs (Multus NAD on bridge + vlan)
    vlanPools:
      - id: default
        start: 3000
        end: 3100
        bridge: br0
        dns: [1.1.1.1]
        exclude: [3000] # hand-managed VLANs
```

### IPAM (scan-derived)

When a Multus network on create matches a cluster `ipPools` entry **or** a self-service VPC NAD with a `cidr` annotation, kmc:

1. Scans cluster VMs for `kmc.ianunruh.com/ipv4` annotations (comma-separated when multi-attach) and live VMI interface IPs in the pool CIDR
2. Picks the first free address (excluding network, broadcast, gateway, and `exclude`)
3. Annotates the VM (`kmc.ianunruh.com/ipv4`, `kmc.ianunruh.com/ipam-pool`) and injects cloud-init `networkData` (netplan static config; omits default route if the pool has no gateway)
4. Frees the address automatically when the VM is deleted (next create re-scans)

**Multi-attach:** Launch VM can attach multiple Multus NADs (up to 8). Each attachment that has a pool gets its own address; netplan matches NICs by MAC. Only one default route is installed (first attachment with a gateway, else the first pooled NIC). Empty network list keeps the historical **pod network only** behavior.
No separate IPAM database — the cluster is the source of truth. Concurrent creates in a single kmc process are serialized per pool; multi-replica kmc can still race (use one replica or graduate to explicit leases later).

### GitHub OAuth App (impersonate mode)

1. Create a GitHub OAuth App:
   - Homepage: `http://localhost:5173`
   - Callback: `http://localhost:5173/auth/callback`
2. Request org access so `read:org` can list teams.
3. Configure env:

```bash
cp .env.example .env
# edit .env — set KMC_AUTH_MODE=impersonate, GitHub client id/secret
# KMC_SESSION_SECRET: openssl rand -hex 32
pnpm dev
```

`.env` is gitignored; `.env.example` is the template. Vite/React Router loads `.env` into `process.env` on `pnpm dev`.

Visit `/me` after login to verify `Impersonate-User` / groups match `kubectl auth whoami`.

## Config

| Env                        | Default                 | Description                                                                   |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `KMC_AUTH_MODE`            | `kubeconfig`            | `kubeconfig` \| `impersonate`                                                 |
| `KMC_CLUSTERS_CONFIG`      | `config/clusters.yaml`  | Cluster identity registry                                                     |
| `KMC_SETTINGS_CLUSTER`     | first cluster in YAML   | Cluster for app-level prefs (SSH keys ConfigMaps in `kmc-system`)             |
| `KMC_CONTEXTS`             | `prod-sjc1,homelab`     | Fallback cluster list when YAML missing (kubeconfig mode)                     |
| `KMC_IMAGE_NAMESPACE`      | `vm-images`             | Namespace scanned for golden image PVCs                                       |
| `KMC_SESSION_SECRET`       | —                       | ≥32 chars; HMAC key for signed session cookies (survives restarts)            |
| `KMC_GITHUB_CLIENT_ID`     | —                       | GitHub OAuth App client id                                                    |
| `KMC_GITHUB_CLIENT_SECRET` | —                       | GitHub OAuth App client secret                                                |
| `KMC_GITHUB_ORGS`          | —                       | Comma-separated GitHub orgs allowed to sign in; their teams become k8s groups |
| `KMC_PUBLIC_URL`           | `http://localhost:5173` | Public origin (OAuth redirect)                                                |
| `KMC_USERNAME_PREFIX`      | `oidc:`                 | Match apiserver username prefix                                               |
| `KMC_GROUPS_PREFIX`        | `oidc:`                 | Match apiserver groups prefix                                                 |

## Features (MVP)

- **Virtual machines** — list, create, detail, edit (labels always; size / preference / run strategy when stopped), stop/start/restart/pause/unpause/delete, **serial console** (full-page xterm via app-proxied WebSocket)
- **IPAM** — optional per-cluster IPv4 pools for Multus NADs; auto-allocate + netplan cloud-init on create
- **VPCs** — self-service Multus networks from a cluster VLAN pool (`vlanPools`); optional private CIDR for IPAM
- **Routers** — shared DHCP/DNS appliance per namespace (OpenStack-style); external SNAT + floating IPs; multi-VPC attach later
- **SSH keys** — signed-in users save named public keys (ConfigMap on the settings cluster); select when creating a VM
- **Ingresses** — create/list/detail/delete HTTP Ingresses bound to a VM (companion ClusterIP Service selects `kubevirt.io/vm`)

- **Data volumes** — list, create (blank / PVC clone / HTTP), detail, delete
- **Cluster instance types** — list, create, detail, edit, delete
- **Events + YAML** on detail pages
- **URL-driven list filters** — shareable views
- Cross-links between resources
- Global auto-refresh + top loading bar
- Multi-cluster via kubeconfig **or** platform SA + impersonation

### Exposing VMs (Ingress)

For **pod-network** VMs, kmc can create a Kubernetes Ingress that routes to the virt-launcher pod through a ClusterIP Service (same CNI path as any backend pod — e.g. Calico). No VM network template changes are required.

1. Open **Ingresses → Create Ingress**
2. Pick cluster, namespace, and target VM
3. Set host / path / ports (and optional `ingressClassName`)
4. kmc creates:
   - **Service** (same name as the Ingress) with selector `kubevirt.io/vm=<vm-name>`
   - **Ingress** with backend pointing at that Service
5. Labels mark ownership: `app.kubernetes.io/managed-by=kmc`, `kmc.ianunruh.com/vm`, `kmc.ianunruh.com/target-kind=VirtualMachine`

**Requirements**

- Guest must listen on the target port (kmc does not configure guest apps)
- Caller needs RBAC to create/delete `services` and `ingresses` in the namespace
- Multus guest IPs are **not** used as backends (Service selects the pod); a soft warning is shown when the target VM is Multus-attached

**Delete** removes both the Ingress and the companion Service; the VM is left intact.

**Future:** bind one Ingress/Service to a group of VMs via label selector (same object model; only the Service selector source changes).

### VPCs (self-service Multus + VLAN)

When a cluster has `vlanPools` in `clusters.yaml` (and hypervisors expose those VLANs on the configured bridge, e.g. `br0` with VLAN filtering), users can create **VPCs** from the console:

1. **Create VPC** — pick cluster, vm-allowed namespace, name; optionally enable private IPAM (CIDR + optional gateway/DNS)
2. kmc allocates the lowest free VLAN in the pool (scan of existing VPC NAD labels + `exclude`), then creates a Multus `NetworkAttachmentDefinition` with bridge CNI + `vlan`
3. **Launch VM** — choose the new NAD (alone or with other Multus networks); if the VPC has a CIDR, IPAM works like static `ipPools`
4. **Delete VPC** — blocked while any VM still attaches to the NAD; then the NAD is removed and the VLAN returns to the free pool

**Requirements**

- TOR / underlay already carries the VLAN range; nodes have the bridge with VLAN filtering
- Caller needs RBAC to create/list/delete `network-attachment-definitions.k8s.cni.cncf.io` in the target namespace
- Pure L2 by default (VM-to-VM on the VLAN); gateway is only for guest default routes if you provide one

Static Multus networks and `ipPools` entries continue to work unchanged.

### Shared routers (DHCP + DNS)

OpenStack-style **shared routers** provide per-VPC gateway, DHCP, and DNS without changing the cluster CNI (Calico stays primary).

| Piece | Role |
| ----- | ---- |
| Router VM | Multus leg(s) on attached VPC(s) + pod NIC for the agent |
| Policy ConfigMap `kmc-router-<name>` | Interfaces, static DHCP leases, agent script (survives VM recreate) |
| In-guest agent | Watches policy → dnsmasq static `dhcp-host` + DNS |

**Flow**

1. Create a VPC with private IPAM (CIDR).
2. **Routers → Create** (or VPC detail → Create router) — attach at least one VPC. The router claims that VPC’s gateway IP.
3. Launch workload VMs on the VPC: kmc registers a static lease and configures the guest private NIC with **DHCP** (MAC-matched).
4. Guests get address / default route / DNS from the router (`<vm>.<vpc>.vpc.local`).

**External gateway + floating IPs**

- Optional **public Multus** on create, or **Enable external gateway** on the router detail page (recreates the appliance VM with a public NIC)
- SNAT (MASQUERADE) for guest egress; **floating IPs** live on the router policy and are applied by the same agent
- Requires cluster `network.podCIDR` / `serviceCIDR` (and CA) so the agent can reach the apiserver over the pod NIC

```yaml
network:
  podCIDR: 10.19.0.0/16
  serviceCIDR: 10.20.0.0/16
  # dnsIP: 10.20.0.10   # optional
```

On create (or when enabling external), kmc provisions:

- ConfigMap `kmc-router-<name>` with `policy.json` + `agent.py` (self-update target)
- ServiceAccount + Role/RoleBinding (get/list/watch/patch that ConfigMap)
- Long-lived SA token embedded in cloud-init for the agent

The policy ConfigMap is **not** owned by the router VM: floating IP associations
and leases survive deleting and recreating the appliance. IPAM keeps public
addresses reserved via the policy document. Recreating a router reuses the
existing policy, updates NIC metadata, and re-stamps floating IPs onto the new
VM. The control plane is removed when the router is deleted.

**Disassociate vs release:** Disassociating a floating IP unmaps it from the
private target but **keeps** the public address held (secondary IP stays on the
router; IPAM still reserves it). **Release** removes the policy entry so the
address returns to the public pool. Held addresses can be re-associated later
without re-allocating.

**In-guest agent** (`app/vpcs/kmc-router-agent.py`, Python 3 stdlib only):

- Bootstrap copy is written by cloud-init; runtime source of truth is ConfigMap `agent.py`
- Watches the policy ConfigMap and applies DHCP/DNS, SNAT, and 1:1 DNAT/SNAT floating IPs
- On each apply: rewrites static `dhcp-host` entries, **stops** dnsmasq, prunes the lease DB to MAC+IP pairs still in policy, then starts dnsmasq — so deleting a VM and recreating it can reuse the IPAM address with a new MAC (without this, dnsmasq keeps the old lease and logs `not using configured address … because it is leased to <old-mac>`)
- Heartbeats via `kmc.ianunruh.com/agent-heartbeat-at` (~30s); kmc marks the agent **Stale** if the heartbeat is older than 90s
- When kmc updates `agent.py`, the agent rewrites itself and re-execs

**UI**

- **Routers** — create / detail; enable external gateway; leases and floating IPs
- **Floating IPs** nav — list/filter all associations; disassociate / release
- **Associate floating IP** (`/floating-ips/create`) — pick VPC (must have router + external) + target VM (or private IP)
- **VPC detail** — router pointer, floating IP table, associate / disassociate
- **VM detail** — floating IPs targeting this guest, associate (prefilled VPC) / disassociate

**Limits**

- One VPC at create (multi-VPC attach later)
- A VPC can attach to only one router (gateway IP ownership)
- Setting external later requires an SSH key (new cloud-init) and causes brief downtime

**Policy sketch** (`policy.json` in the ConfigMap): `interfaces[]` (vpc, cidr, gateway, mac, domain, dhcp), `leases[]`, `external` (multusNetwork, primaryCidr, gateway, mac, snat), `floatingIPs[]`.

### User SSH keys

Saved SSH **public** keys are stored as ConfigMaps in `kmc-system` on a single **settings cluster** (`settingsCluster` in `clusters.yaml`, or `KMC_SETTINGS_CLUSTER`, else the first registered cluster). In impersonate mode the platform SA writes these without user impersonation; kmc enforces ownership from the GitHub session.

Apply the updated `deploy/impersonator/rbac.yaml` so SA `kmc` can manage ConfigMaps in `kmc-system` (Role `kmc-settings`). Manage keys at `/ssh-keys`; create VM can select a saved key or still accept a one-off paste.

## Safety

- **kubeconfig mode:** binds as a local console with no login. Do not expose beyond localhost.
- **impersonate mode:** session cookie + GitHub OAuth. Still do not expose without TLS and a hardened deployment. Prefer smoke-test VMs when exercising delete/stop.
- Platform SA tokens and `config/clusters.yaml` are gitignored under `config/secrets/` / local overrides.

## Scripts

```bash
pnpm dev           # Vite dev server (HMR + serial console WS proxy)
pnpm build         # production build
pnpm start         # custom Node server (SSR + serial console WS)
pnpm typecheck     # typegen + tsc
pnpm lint          # eslint
pnpm format        # prettier --write
pnpm format:check  # prettier --check
pnpm check         # typecheck + lint + format:check
```

### Serial console

- UI: `/vms/:cluster/:namespace/:name/console` (xterm.js)
- Proxy: browser WebSocket → `ws(s)://…/api/vms/…/serial` → KubeVirt
  `…/virtualmachineinstances/{name}/console` (`plain.kubevirt.io`)
- Dev: Vite plugin attaches the upgrade handler on the same port as HMR
- Prod: `server.ts` (replaces `react-router-serve`)
- Requires a live VMI and `get` on the console subresource
