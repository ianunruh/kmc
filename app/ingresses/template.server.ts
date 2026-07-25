import type { CreateIngressRequest } from "~/lib/types";
import {
  KMC_LABEL_INGRESS,
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_MANAGED_BY,
  KMC_TARGET_KIND_VM,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";

export function ownershipLabels(input: {
  name: string;
  vmName: string;
}): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_VM]: input.vmName,
    [KMC_LABEL_TARGET_KIND]: KMC_TARGET_KIND_VM,
    [KMC_LABEL_INGRESS]: input.name,
  };
}

/**
 * Ingress-only manifest. Companion Service is created via app/backends.
 * @param serviceName defaults to ingress name (1:1 v1 convention)
 */
export function buildIngressManifest(
  input: CreateIngressRequest,
  serviceName?: string,
) {
  const servicePort = input.servicePort ?? 80;
  const path = input.path?.trim() || "/";
  const pathType = input.pathType ?? "Prefix";
  const labels = ownershipLabels({ name: input.name, vmName: input.vmName });
  const backendService = serviceName?.trim() || input.name;

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
      rules: [
        {
          host: input.host.trim(),
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
