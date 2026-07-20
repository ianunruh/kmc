import {
  type RouteConfig,
  index,
  route,
} from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("vms/create", "routes/vms.create.tsx"),
  route("api/catalog/:cluster", "routes/api.catalog.$cluster.ts"),
  route("api/networks/:cluster", "routes/api.networks.$cluster.ts"),
] satisfies RouteConfig;
