import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("auth/github", "routes/auth.github.ts"),
  route("auth/callback", "routes/auth.callback.ts"),
  route("auth/logout", "routes/auth.logout.ts"),
  route("me", "routes/me.tsx"),
  route("ssh-keys", "routes/ssh-keys.tsx"),

  route("vms/create", "routes/vms.create.tsx"),
  route(
    "vms/:cluster/:namespace/:name/edit",
    "routes/vms.$cluster.$namespace.$name.edit.tsx",
  ),
  route(
    "vms/:cluster/:namespace/:name/console",
    "routes/vms.$cluster.$namespace.$name.console.tsx",
  ),
  route(
    "vms/:cluster/:namespace/:name/terminal",
    "routes/vms.$cluster.$namespace.$name.terminal.tsx",
  ),
  route("vms/:cluster/:namespace/:name", "routes/vms.$cluster.$namespace.$name.tsx", [
    index("routes/vms.$cluster.$namespace.$name._index.tsx"),
    route("networking", "routes/vms.$cluster.$namespace.$name.networking.tsx"),
    route("storage", "routes/vms.$cluster.$namespace.$name.storage.tsx"),
    route("events", "routes/vms.$cluster.$namespace.$name.events.tsx"),
    route("yaml", "routes/vms.$cluster.$namespace.$name.yaml.tsx"),
  ]),

  route("datavolumes", "routes/datavolumes._index.tsx"),
  route("datavolumes/create", "routes/datavolumes.create.tsx"),
  route(
    "datavolumes/:cluster/:namespace/:name",
    "routes/datavolumes.$cluster.$namespace.$name.tsx",
    [
      index("routes/datavolumes.$cluster.$namespace.$name._index.tsx"),
      route("events", "routes/datavolumes.$cluster.$namespace.$name.events.tsx"),
      route("yaml", "routes/datavolumes.$cluster.$namespace.$name.yaml.tsx"),
    ],
  ),

  route("databases", "routes/databases._index.tsx"),
  route("databases/create", "routes/databases.create.tsx"),
  route(
    "databases/:cluster/:namespace/:name/terminal",
    "routes/databases.$cluster.$namespace.$name.terminal.tsx",
  ),
  route(
    "databases/:cluster/:namespace/:name",
    "routes/databases.$cluster.$namespace.$name.tsx",
    [
      index("routes/databases.$cluster.$namespace.$name._index.tsx"),
      route("access", "routes/databases.$cluster.$namespace.$name.access.tsx"),
      route("events", "routes/databases.$cluster.$namespace.$name.events.tsx"),
      route("yaml", "routes/databases.$cluster.$namespace.$name.yaml.tsx"),
    ],
  ),

  route("images", "routes/images._index.tsx"),
  route("images/create", "routes/images.create.tsx"),
  route("images/:cluster/:name/edit", "routes/images.$cluster.$name.edit.tsx"),
  route("images/:cluster/:name", "routes/images.$cluster.$name.tsx", [
    index("routes/images.$cluster.$name._index.tsx"),
    route("events", "routes/images.$cluster.$name.events.tsx"),
    route("yaml", "routes/images.$cluster.$name.yaml.tsx"),
  ]),

  route("ingresses", "routes/ingresses._index.tsx"),
  route("ingresses/create", "routes/ingresses.create.tsx"),
  route(
    "ingresses/:cluster/:namespace/:name/edit",
    "routes/ingresses.$cluster.$namespace.$name.edit.tsx",
  ),
  route(
    "ingresses/:cluster/:namespace/:name",
    "routes/ingresses.$cluster.$namespace.$name.tsx",
    [
      index("routes/ingresses.$cluster.$namespace.$name._index.tsx"),
      route("events", "routes/ingresses.$cluster.$namespace.$name.events.tsx"),
      route("yaml", "routes/ingresses.$cluster.$namespace.$name.yaml.tsx"),
    ],
  ),

  route("load-balancers", "routes/load-balancers._index.tsx"),
  route("load-balancers/create", "routes/load-balancers.create.tsx"),
  route(
    "load-balancers/:cluster/:namespace/:name/edit",
    "routes/load-balancers.$cluster.$namespace.$name.edit.tsx",
  ),
  route(
    "load-balancers/:cluster/:namespace/:name",
    "routes/load-balancers.$cluster.$namespace.$name.tsx",
    [
      index("routes/load-balancers.$cluster.$namespace.$name._index.tsx"),
      route("events", "routes/load-balancers.$cluster.$namespace.$name.events.tsx"),
      route("yaml", "routes/load-balancers.$cluster.$namespace.$name.yaml.tsx"),
    ],
  ),

  route("vpcs", "routes/vpcs._index.tsx"),
  route("vpcs/create", "routes/vpcs.create.tsx"),
  route(
    "vpcs/:cluster/:namespace/:name/edit",
    "routes/vpcs.$cluster.$namespace.$name.edit.tsx",
  ),
  route("vpcs/:cluster/:namespace/:name", "routes/vpcs.$cluster.$namespace.$name.tsx", [
    index("routes/vpcs.$cluster.$namespace.$name._index.tsx"),
    route("vms", "routes/vpcs.$cluster.$namespace.$name.vms.tsx"),
    route("yaml", "routes/vpcs.$cluster.$namespace.$name.yaml.tsx"),
  ]),

  route("routers", "routes/routers._index.tsx"),
  route("routers/create", "routes/routers.create.tsx"),
  route(
    "routers/:cluster/:namespace/:name",
    "routes/routers.$cluster.$namespace.$name.tsx",
    [
      index("routes/routers.$cluster.$namespace.$name._index.tsx"),
      route("leases", "routes/routers.$cluster.$namespace.$name.leases.tsx"),
      route("yaml", "routes/routers.$cluster.$namespace.$name.yaml.tsx"),
    ],
  ),

  route("floating-ips", "routes/floating-ips._index.tsx"),
  route("floating-ips/create", "routes/floating-ips.create.tsx"),

  route("port-forwards", "routes/port-forwards._index.tsx"),
  route("port-forwards/create", "routes/port-forwards.create.tsx"),

  route("namespaces", "routes/namespaces._index.tsx"),
  route("namespaces/create", "routes/namespaces.create.tsx"),
  route("namespaces/:cluster/:name/edit", "routes/namespaces.$cluster.$name.edit.tsx"),
  route("namespaces/:cluster/:name", "routes/namespaces.$cluster.$name.tsx", [
    index("routes/namespaces.$cluster.$name._index.tsx"),
    route("yaml", "routes/namespaces.$cluster.$name.yaml.tsx"),
  ]),

  route("topology", "routes/topology._index.tsx"),

  route("instancetypes", "routes/instancetypes._index.tsx"),
  route("instancetypes/create", "routes/instancetypes.create.tsx"),
  route("instancetypes/:cluster/:name", "routes/instancetypes.$cluster.$name.tsx", [
    index("routes/instancetypes.$cluster.$name._index.tsx"),
    route("yaml", "routes/instancetypes.$cluster.$name.yaml.tsx"),
  ]),
  route(
    "instancetypes/:cluster/:name/edit",
    "routes/instancetypes.$cluster.$name.edit.tsx",
  ),

  route("api/catalog/:cluster", "routes/api.catalog.$cluster.ts"),
  route("api/networks/:cluster", "routes/api.networks.$cluster.ts"),
  route("api/datavolumes/:cluster", "routes/api.datavolumes.$cluster.ts"),
  route("api/router-attachable/:cluster", "routes/api.router-attachable.$cluster.ts"),
  route("api/vms/:cluster", "routes/api.vms.$cluster.ts"),
  route(
    "api/vms/:cluster/:namespace/:name/metrics",
    "routes/api.vms.$cluster.$namespace.$name.metrics.ts",
  ),
  route(
    "api/databases/:cluster/:namespace/:name/metrics",
    "routes/api.databases.$cluster.$namespace.$name.metrics.ts",
  ),
] satisfies RouteConfig;
