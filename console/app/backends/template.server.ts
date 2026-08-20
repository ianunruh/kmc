import type { CreateBackendRequest } from "~/lib/types";
import {
  KMC_LABEL_RESOURCE,
  KMC_MANAGED_BY,
  KMC_RESOURCE_BACKEND,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import {
  membershipAnnotations,
  membershipLabels,
  resolveServiceSelector,
} from "./membership";

/** Ownership + membership labels for a kmc backend Service. */
export function backendOwnershipLabels(
  input: Pick<CreateBackendRequest, "membership" | "extraLabels" | "extraAnnotations">,
): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_BACKEND,
    ...membershipLabels(input.membership),
    ...(input.extraLabels ?? {}),
  };
}

export function buildServiceManifest(input: CreateBackendRequest) {
  const serviceType = input.serviceType ?? "ClusterIP";
  const selector = resolveServiceSelector(input.membership);
  const labels = backendOwnershipLabels(input);
  const annotations = {
    ...membershipAnnotations(input.membership),
    ...(input.extraAnnotations ?? {}),
  };

  if (!input.ports.length) {
    throw new Error("backend requires at least one port");
  }
  if (Object.keys(selector).length === 0) {
    throw new Error("backend selector cannot be empty");
  }

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
    spec: {
      type: serviceType,
      // Local matches common MetalLB/BGP clusters and avoids broken return-path
      // hairpins seen with Cluster policy (TCP connects, HTTP hangs).
      ...(serviceType === "LoadBalancer"
        ? { externalTrafficPolicy: "Local" as const }
        : {}),
      selector,
      ports: input.ports.map((p, i) => ({
        name: p.name?.trim() || `port-${i}`,
        protocol: p.protocol ?? "TCP",
        port: p.port,
        targetPort: p.targetPort,
      })),
    },
  };
}
