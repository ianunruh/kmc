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

export function buildServiceManifest(input: CreateIngressRequest) {
  const servicePort = input.servicePort ?? 80;
  const targetPort = input.targetPort ?? servicePort;
  const labels = ownershipLabels({ name: input.name, vmName: input.vmName });

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels,
    },
    spec: {
      type: "ClusterIP",
      selector: {
        "kubevirt.io/vm": input.vmName,
      },
      ports: [
        {
          name: "http",
          protocol: "TCP",
          port: servicePort,
          targetPort,
        },
      ],
    },
  };
}

export function buildIngressManifest(input: CreateIngressRequest) {
  const servicePort = input.servicePort ?? 80;
  const path = input.path?.trim() || "/";
  const pathType = input.pathType ?? "Prefix";
  const labels = ownershipLabels({ name: input.name, vmName: input.vmName });

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
                    name: input.name,
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
