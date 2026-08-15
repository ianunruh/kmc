import type { BackendMembership, CreateHttpRouteRequest } from "~/lib/types";
import {
  KMC_LABEL_HTTP_ROUTE,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_MANAGED_BY,
  KMC_RESOURCE_HTTP_ROUTE,
  KMC_TARGET_KIND_GROUP,
  KMC_TARGET_KIND_LABELS,
  KMC_TARGET_KIND_VM,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { membershipLabels } from "~/backends/membership";

export function ownershipLabels(input: {
  name: string;
  membership?: BackendMembership;
}): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_HTTP_ROUTE,
    [KMC_LABEL_HTTP_ROUTE]: input.name,
    ...(input.membership ? membershipLabels(input.membership) : {}),
  };
}

/**
 * HTTPRoute-only manifest. Companion Service is created via app/backends unless
 * `serviceName` points at an existing backend (expose-existing).
 * @param serviceName defaults to HTTPRoute name (1:1 convention)
 */
export function buildHttpRouteManifest(
  input: CreateHttpRouteRequest,
  serviceName?: string,
) {
  const servicePort = input.servicePort ?? 80;
  const path = input.path?.trim() || "/";
  const pathType = input.pathType ?? "PathPrefix";
  const labels = ownershipLabels({
    name: input.name,
    membership: input.membership,
  });
  const backendService =
    serviceName?.trim() ||
    input.existingServiceName?.trim() ||
    input.name;
  const host = input.host.trim();
  const gatewayName = input.gatewayName.trim();
  const gatewayNamespace = input.gatewayNamespace?.trim();
  const sectionName = input.sectionName?.trim();

  return {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels,
    },
    spec: {
      parentRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: gatewayName,
          ...(gatewayNamespace ? { namespace: gatewayNamespace } : {}),
          ...(sectionName ? { sectionName } : {}),
        },
      ],
      hostnames: [host],
      rules: [
        {
          matches: [
            {
              path: {
                type: pathType,
                value: path,
              },
            },
          ],
          backendRefs: [
            {
              name: backendService,
              port: servicePort,
            },
          ],
        },
      ],
    },
  };
}

/** Human-readable membership label for HTTPRoute list/detail. */
export function membershipModeDisplay(
  kind: string | undefined,
): string | undefined {
  if (kind === KMC_TARGET_KIND_VM) return "Single VM";
  if (kind === KMC_TARGET_KIND_LABELS) return "Label selector";
  if (kind === KMC_TARGET_KIND_GROUP) return "VM group";
  return undefined;
}

export function vmNameFromHttpRouteLabels(
  labels: Record<string, string> | undefined,
): string | undefined {
  if (!labels) return undefined;
  if (labels[KMC_LABEL_TARGET_KIND] === KMC_TARGET_KIND_VM) {
    return labels[KMC_LABEL_VM];
  }
  return labels[KMC_LABEL_VM];
}
