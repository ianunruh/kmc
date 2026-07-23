import type { CreateVmRequest } from "~/lib/types";
import {
  buildNetworkData,
  generateLocalMacAddress,
  ipamAnnotations,
  type AllocatedIp,
} from "~/lib/ipam/pools.server";

/** Multus NAD names from the create request (order preserved). */
export function multusNetworksFromRequest(input: CreateVmRequest): string[] {
  const names: string[] = [];
  for (const n of input.networks ?? []) {
    const name = n.multusNetworkName?.trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * KubeVirt network/interface name for attachment index.
 * Single Multus keeps historical `default`; multi-attach uses net0, net1, …
 */
export function interfaceNameForAttachment(
  index: number,
  multusCount: number,
): string {
  if (multusCount <= 1) return "default";
  return `net${index}`;
}

/**
 * Build domain interfaces + template networks for Multus multi-attach or pod-only.
 * When allocations include a MAC for a Multus interface name, stamp it on the iface.
 */
export function buildNetworkSpec(
  multusNames: string[],
  allocations: AllocatedIp[] = [],
): {
  interfaces: Array<Record<string, unknown>>;
  networks: Array<Record<string, unknown>>;
} {
  if (multusNames.length === 0) {
    return {
      interfaces: [{ name: "default", bridge: {} }],
      networks: [{ name: "default", pod: {} }],
    };
  }

  const allocByNetwork = new Map(
    allocations
      .filter((a) => a.networkName)
      .map((a) => [a.networkName!, a] as const),
  );

  const interfaces: Array<Record<string, unknown>> = [];
  const networks: Array<Record<string, unknown>> = [];

  multusNames.forEach((multusNetworkName, index) => {
    const name = interfaceNameForAttachment(index, multusNames.length);
    const alloc = allocByNetwork.get(name);
    const iface: Record<string, unknown> = {
      name,
      bridge: {},
    };
    if (alloc?.macAddress) {
      iface.macAddress = alloc.macAddress;
    }
    interfaces.push(iface);
    networks.push({
      name,
      multus: { networkName: multusNetworkName },
    });
  });

  return { interfaces, networks };
}

/**
 * Pair Multus attachments with IPAM results: assign KubeVirt network names and MACs
 * so netplan can match multi-NIC guests.
 */
export function bindAllocationsToNetworks(
  multusNames: string[],
  rawAllocations: Array<AllocatedIp | null>,
): AllocatedIp[] {
  const bound: AllocatedIp[] = [];
  multusNames.forEach((_multusName, index) => {
    const raw = rawAllocations[index];
    if (!raw) return;
    const networkName = interfaceNameForAttachment(index, multusNames.length);
    const multiNic = multusNames.length > 1;
    // Multi-NIC always needs MAC match; single-NIC with pool.interface keeps name match.
    const needsMac = multiNic || !raw.interfaceName;
    bound.push({
      ...raw,
      networkName,
      macAddress: needsMac
        ? (raw.macAddress ?? generateLocalMacAddress())
        : raw.macAddress,
    });
  });
  return bound;
}

export function buildVirtualMachineManifest(
  input: CreateVmRequest,
  allocations: AllocatedIp[] = [],
) {
  const start = input.start !== false;
  const imageNs = input.image.namespace || "vm-images";
  const diskName = input.name;
  const multusNames = multusNetworksFromRequest(input);
  const { interfaces, networks } = buildNetworkSpec(multusNames, allocations);

  const disks: unknown[] = [
    {
      name: "root",
      disk: { bus: "virtio" },
    },
    {
      name: "cloudinit",
      disk: { bus: "virtio" },
    },
  ];

  const cloudInitNoCloud: Record<string, string> = {
    userData: [
      "#cloud-config",
      "ssh_authorized_keys:",
      `  - ${input.sshPublicKey.trim()}`,
    ].join("\n"),
  };

  if (allocations.length > 0) {
    cloudInitNoCloud.networkData = buildNetworkData(allocations);
  }

  const volumes: unknown[] = [
    {
      name: "root",
      dataVolume: { name: diskName },
    },
    {
      name: "cloudinit",
      cloudInitNoCloud,
    },
  ];

  const domain: Record<string, unknown> = {
    devices: {
      disks,
      interfaces,
    },
    machine: { type: "q35" },
    resources: {},
  };

  if (!input.instanceType) {
    domain.cpu = { cores: input.cpuCores ?? 1 };
    domain.resources = {
      requests: {
        memory: input.memory ?? "1Gi",
      },
    };
  }

  const dataVolumeSpec: Record<string, unknown> = {
    source: {
      pvc: {
        namespace: imageNs,
        name: input.image.name,
      },
    },
    pvc: {
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Block",
      resources: {
        requests: {
          storage: input.diskSize,
        },
      },
      ...(input.storageClass ? { storageClassName: input.storageClass } : {}),
    },
  };

  const spec: Record<string, unknown> = {
    runStrategy: start ? "Always" : "Halted",
    dataVolumeTemplates: [
      {
        metadata: {
          name: diskName,
          labels: {
            "kubevirt.io/vm": input.name,
            "app.kubernetes.io/managed-by": "kmc",
          },
        },
        spec: dataVolumeSpec,
      },
    ],
    template: {
      metadata: {
        labels: {
          "kubevirt.io/vm": input.name,
          "app.kubernetes.io/managed-by": "kmc",
        },
      },
      spec: {
        architecture: "amd64",
        domain,
        networks,
        volumes,
      },
    },
  };

  if (input.instanceType) {
    spec.instancetype = {
      kind: "VirtualMachineClusterInstancetype",
      name: input.instanceType,
    };
  }

  if (input.preference) {
    spec.preference = {
      kind: "VirtualMachineClusterPreference",
      name: input.preference,
    };
  }

  const annotations: Record<string, string> =
    allocations.length > 0 ? ipamAnnotations(allocations) : {};

  return {
    apiVersion: "kubevirt.io/v1",
    kind: "VirtualMachine",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        "kubevirt.io/vm": input.name,
        "app.kubernetes.io/managed-by": "kmc",
      },
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
    spec,
  };
}
