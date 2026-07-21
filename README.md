# kmc — multi-cluster KubeVirt console

Local web console for listing and managing KubeVirt virtual machines across Kubernetes clusters. Single React Router app (loaders, actions, resource routes) talking to your kubeconfig contexts.

## Stack

- React Router 8 (framework mode, SSR)
- TypeScript + Vite
- Mantine (dark) + Geist Mono
- `@kubernetes/client-node` (server-only)

## Layout

```
app/
  routes/           # React Router route modules (default exports required by RR)
  lib/              # shared utils (errors, format, refresh, k8s clients/catalog)
  ui/               # shared UI primitives (kebab-case, named exports)
  shell/            # app chrome, refresh control, loading bar
  vms/              # VM feature (components + server)
  datavolumes/      # DataVolume server module
  instancetypes/    # cluster instance type server module
```

## Prerequisites

- Node 22+
- pnpm
- Working `kubectl` against your clusters (OIDC/exec auth is fine)

Default contexts: `prod-sjc1`, `homelab`.

## Setup

```bash
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173).

## Config

| Env                   | Default             | Description                             |
| --------------------- | ------------------- | --------------------------------------- |
| `KMC_CONTEXTS`        | `prod-sjc1,homelab` | Comma-separated kube contexts           |
| `KMC_IMAGE_NAMESPACE` | `vm-images`         | Namespace scanned for golden image PVCs |

## Features (MVP)

- **Virtual machines** — list, create, detail, stop/start/delete
- **Data volumes** — list, create (blank / PVC clone / HTTP), detail, delete
- **Cluster instance types** — list, create, detail, edit, delete
- **Events + YAML** on detail pages (shared `EventsPanel` / `YamlPanel`)
- **URL-driven list filters** (`?q=&cluster=&namespace=&status=` / `phase=`) — shareable views
- Cross-links between VMs, DataVolumes, instance types, and filtered lists
- Shared list/form UI primitives under `app/ui/`
- Global auto-refresh + top loading bar
- Multi-cluster via kubeconfig contexts (`KMC_CONTEXTS`)

## Safety

This binds as a local console with **no authentication**. Do not expose it beyond localhost. Prefer smoke-test VMs over long-lived production workloads when exercising delete/stop.

## Scripts

```bash
pnpm dev           # dev server
pnpm build         # production build
pnpm start         # serve build
pnpm typecheck     # typegen + tsc
pnpm lint          # eslint
pnpm format        # prettier --write
pnpm format:check  # prettier --check
pnpm check         # typecheck + lint + format:check
```
