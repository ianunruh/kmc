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
  route("vms/:cluster/:namespace/:name", "routes/vms.$cluster.$namespace.$name.tsx"),

  route("datavolumes", "routes/datavolumes._index.tsx"),
  route("datavolumes/create", "routes/datavolumes.create.tsx"),
  route(
    "datavolumes/:cluster/:namespace/:name",
    "routes/datavolumes.$cluster.$namespace.$name.tsx",
  ),

  route("ingresses", "routes/ingresses._index.tsx"),
  route("ingresses/create", "routes/ingresses.create.tsx"),
  route(
    "ingresses/:cluster/:namespace/:name",
    "routes/ingresses.$cluster.$namespace.$name.tsx",
  ),

  route("vpcs", "routes/vpcs._index.tsx"),
  route("vpcs/create", "routes/vpcs.create.tsx"),
  route(
    "vpcs/:cluster/:namespace/:name/edit",
    "routes/vpcs.$cluster.$namespace.$name.edit.tsx",
  ),
  route(
    "vpcs/:cluster/:namespace/:name/nat-gateway",
    "routes/vpcs.$cluster.$namespace.$name.nat-gateway.tsx",
  ),
  route("vpcs/:cluster/:namespace/:name", "routes/vpcs.$cluster.$namespace.$name.tsx"),

  route("topology", "routes/topology._index.tsx"),

  route("instancetypes", "routes/instancetypes._index.tsx"),
  route("instancetypes/create", "routes/instancetypes.create.tsx"),
  route("instancetypes/:cluster/:name", "routes/instancetypes.$cluster.$name.tsx"),
  route(
    "instancetypes/:cluster/:name/edit",
    "routes/instancetypes.$cluster.$name.edit.tsx",
  ),

  route("api/catalog/:cluster", "routes/api.catalog.$cluster.ts"),
  route("api/networks/:cluster", "routes/api.networks.$cluster.ts"),
  route("api/vms/:cluster", "routes/api.vms.$cluster.ts"),
  route(
    "api/vms/:cluster/:namespace/:name/metrics",
    "routes/api.vms.$cluster.$namespace.$name.metrics.ts",
  ),
] satisfies RouteConfig;
