import type { CreateVpcRequest } from "~/lib/types";
import {
  KMC_ANN_CIDR,
  KMC_ANN_DESCRIPTION,
  KMC_ANN_DNS,
  KMC_ANN_GATEWAY,
  KMC_ANN_OWNER,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VLAN,
  KMC_LABEL_VLAN_POOL,
  KMC_MANAGED_BY,
  KMC_RESOURCE_VPC,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";

export type BuildNadInput = CreateVpcRequest & {
  vlan: number;
  vlanPoolId: string;
  bridge: string;
  /** Default DNS from vlan pool when user did not set dns */
  defaultDns?: string[];
  owner?: string;
};

/**
 * Multus NetworkAttachmentDefinition for a self-service VPC.
 * Bridge + VLAN on the hypervisor (vlan filtering on br0); no CNI IPAM.
 */
export function buildNetworkAttachmentDefinition(input: BuildNadInput) {
  const name = input.name.trim();
  const cni = {
    cniVersion: "0.3.1",
    name,
    type: "bridge",
    bridge: input.bridge,
    vlan: input.vlan,
    ipam: {},
  };

  const labels: Record<string, string> = {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_VPC,
    [KMC_LABEL_VLAN]: String(input.vlan),
    [KMC_LABEL_VLAN_POOL]: input.vlanPoolId,
  };

  const annotations: Record<string, string> = {};
  if (input.description?.trim()) {
    annotations[KMC_ANN_DESCRIPTION] = input.description.trim();
  }
  if (input.cidr?.trim()) {
    annotations[KMC_ANN_CIDR] = input.cidr.trim();
  }
  if (input.gateway?.trim()) {
    annotations[KMC_ANN_GATEWAY] = input.gateway.trim();
  }
  const dns =
    input.dns?.map((d) => d.trim()).filter(Boolean) ??
    input.defaultDns?.map((d) => d.trim()).filter(Boolean) ??
    [];
  // Only stamp DNS when IPAM is enabled (cidr present)
  if (input.cidr?.trim() && dns.length > 0) {
    annotations[KMC_ANN_DNS] = dns.join(",");
  }
  if (input.owner?.trim()) {
    annotations[KMC_ANN_OWNER] = input.owner.trim();
  }

  return {
    apiVersion: "k8s.cni.cncf.io/v1",
    kind: "NetworkAttachmentDefinition",
    metadata: {
      name,
      namespace: input.namespace,
      labels,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
    spec: {
      config: JSON.stringify(cni),
    },
  };
}
