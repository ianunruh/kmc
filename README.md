# kmc — multi-cluster KubeVirt console

Local web console for listing and managing KubeVirt virtual machines across Kubernetes clusters. Single React Router app (loaders, actions, resource routes) talking to your kubeconfig contexts.

## Stack

- React Router 8 (framework mode, SSR)
- TypeScript + Vite
- Mantine (dark) + Geist Mono
- `@kubernetes/client-node` (server-only)

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

| Env | Default | Description |
|---|---|---|
| `KMC_CONTEXTS` | `prod-sjc1,homelab` | Comma-separated kube contexts |
| `KMC_IMAGE_NAMESPACE` | `vm-images` | Namespace scanned for golden image PVCs |

## Features (MVP)

- List VMs across clusters (poll every 10s)
- Create VM (full page) — clone PVC image, size, network, SSH key
- Stop / start / delete with confirmation on delete
- Namespace required on create (no default)

## Safety

This binds as a local console with **no authentication**. Do not expose it beyond localhost. Prefer smoke-test VMs over long-lived production workloads when exercising delete/stop.

## Scripts

```bash
pnpm dev        # dev server
pnpm build      # production build
pnpm start      # serve build
pnpm typecheck  # typegen + tsc
```
