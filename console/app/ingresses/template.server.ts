import type { BackendMembership, CreateIngressRequest } from "~/lib/types";
import {
  KMC_LABEL_INGRESS,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_MANAGED_BY,
  KMC_RESOURCE_INGRESS,
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
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_INGRESS,
    [KMC_LABEL_INGRESS]: input.name,
    ...(input.membership ? membershipLabels(input.membership) : {}),
  };
}

/**
 * Ingress-only manifest. Companion Service is created via app/backends unless
 * `serviceName` points at an existing backend (expose-existing).
 * @param serviceName defaults to ingress name (1:1 convention)
 */
export function buildIngressManifest(
  input: CreateIngressRequest,
  serviceName?: string,
) {
  const servicePort = input.servicePort ?? 80;
  const path = input.path?.trim() || "/";
  const pathType = input.pathType ?? "Prefix";
  const labels = ownershipLabels({
    name: input.name,
    membership: input.membership,
  });
  const backendService =
    serviceName?.trim() ||
    input.existingServiceName?.trim() ||
    input.name;
  const host = input.host.trim();
  const tlsSecret = input.tlsSecretName?.trim();

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels,
    },
    spec: {
      ...(input.ingressClassName?.trim()
        ? { ingressClassName: input.ingressClassName.trim() }
        : {}),
      ...(tlsSecret
        ? {
            tls: [
              {
                hosts: [host],
                secretName: tlsSecret,
              },
            ],
          }
        : {}),
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path,
                pathType,
                backend: {
                  service: {
                    name: backendService,
                    port: { number: servicePort },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
}

/** Human-readable membership label for Ingress list/detail. */
export function membershipModeDisplay(
  kind: string | undefined,
): string | undefined {
  if (kind === KMC_TARGET_KIND_VM) return "Single VM";
  if (kind === KMC_TARGET_KIND_LABELS) return "Label selector";
  if (kind === KMC_TARGET_KIND_GROUP) return "VM group";
  return undefined;
}

export function vmNameFromIngressLabels(
  labels: Record<string, string> | undefined,
): string | undefined {
  if (!labels) return undefined;
  if (labels[KMC_LABEL_TARGET_KIND] === KMC_TARGET_KIND_VM) {
    return labels[KMC_LABEL_VM];
  }
  return labels[KMC_LABEL_VM]; // only set for single-vm ownership
}
