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
  vms/ datavolumes/ instancetypes/
config/
  clusters.example.yaml
  clusters.yaml     # local (gitignored) — apiServer + SA tokens
  secrets/          # local (gitignored) — platform SA tokens
deploy/impersonator/  # cluster-side SA + impersonate RBAC
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

| Mode                     | `KMC_AUTH_MODE`       | Behavior                                                                                                                       |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **kubeconfig** (default) | `kubeconfig` or unset | Uses local kubeconfig. Optional GitHub login only for `/me` identity preview.                                                  |
| **impersonate**          | `impersonate`         | Requires GitHub login. Calls each cluster with a platform ServiceAccount and `Impersonate-User` / `Impersonate-Group` headers. |

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
```

### IPAM (scan-derived)

When a Multus network on create matches a cluster `ipPools` entry, kmc:

1. Scans cluster VMs for `kmc.io/ipv4` annotations and live VMI interface IPs in the pool CIDR
2. Picks the first free address (excluding network, broadcast, gateway, and `exclude`)
3. Annotates the VM (`kmc.io/ipv4`, `kmc.io/ipam-pool`) and injects cloud-init `networkData` (netplan static config)
4. Frees the address automatically when the VM is deleted (next create re-scans)

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

| Env                        | Default                 | Description                                                        |
| -------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `KMC_AUTH_MODE`            | `kubeconfig`            | `kubeconfig` \| `impersonate`                                      |
| `KMC_CLUSTERS_CONFIG`      | `config/clusters.yaml`  | Cluster identity registry                                          |
| `KMC_CONTEXTS`             | `prod-sjc1,homelab`     | Fallback cluster list when YAML missing (kubeconfig mode)          |
| `KMC_IMAGE_NAMESPACE`      | `vm-images`             | Namespace scanned for golden image PVCs                            |
| `KMC_SESSION_SECRET`       | —                       | ≥32 chars; HMAC key for signed session cookies (survives restarts) |
| `KMC_GITHUB_CLIENT_ID`     | —                       | GitHub OAuth App client id                                         |
| `KMC_GITHUB_CLIENT_SECRET` | —                       | GitHub OAuth App client secret                                     |
| `KMC_GITHUB_ORGS`          | —                       | Comma-separated orgs whose teams become k8s groups                 |
| `KMC_PUBLIC_URL`           | `http://localhost:5173` | Public origin (OAuth redirect)                                     |
| `KMC_USERNAME_PREFIX`      | `oidc:`                 | Match apiserver username prefix                                    |
| `KMC_GROUPS_PREFIX`        | `oidc:`                 | Match apiserver groups prefix                                      |

## Features (MVP)

- **Virtual machines** — list, create, detail, edit (labels always; size / preference / run strategy when stopped), stop/start/restart/pause/unpause/delete, **serial console** (full-page xterm via app-proxied WebSocket)
- **IPAM** — optional per-cluster IPv4 pools for Multus NADs; auto-allocate + netplan cloud-init on create

- **Data volumes** — list, create (blank / PVC clone / HTTP), detail, delete
- **Cluster instance types** — list, create, detail, edit, delete
- **Events + YAML** on detail pages
- **URL-driven list filters** — shareable views
- Cross-links between resources
- Global auto-refresh + top loading bar
- Multi-cluster via kubeconfig **or** platform SA + impersonation

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
