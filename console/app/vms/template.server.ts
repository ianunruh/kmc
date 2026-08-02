import type { CreateVmRequest } from "~/lib/types";
import { createVmDiskSource } from "~/lib/types";
import { KMC_ANN_DISK_SIZE } from "~/lib/k8s/constants";
import {
  buildNetworkData,
  buildRouterNetworkData,
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
export function interfaceNameForAttachment(index: number, multusCount: number): string {
  if (multusCount <= 1) return "default";
  return `net${index}`;
}

/** KubeVirt interface/network name for the optional pod NIC alongside Multus. */
export const POD_NETWORK_NAME = "pod";

export type BuildNetworkSpecOpts = {
  /**
   * When true and Multus attachments are present, also attach the pod network
   * (masquerade) as the **first** interface/network name `pod`. Keeps
   * KubeVirt port-forward / browser Terminal working (dials interfaces[0]) and
   * lets shared routers reach the apiserver from the guest agent.
   */
  includePodNetwork?: boolean;
  /**
   * Guest MAC for the masquerade interface when dual-homed. Netplan matches
   * the pod NIC by this MAC (not name en*).
   */
  podMacAddress?: string;
};

/**
 * Build domain interfaces + template networks for Multus multi-attach, pod-only,
 * or Multus + pod (dual-home).
 * When allocations include a MAC for a Multus interface name, stamp it on the iface.
 * With includePodNetwork, pod/masquerade is listed first so status.interfaces[0]
 * is cluster-routable for port-forward.
 */
export function buildNetworkSpec(
  multusNames: string[],
  allocations: AllocatedIp[] = [],
  opts?: BuildNetworkSpecOpts,
): {
  interfaces: Array<Record<string, unknown>>;
  networks: Array<Record<string, unknown>>;
} {
  if (multusNames.length === 0) {
    // Masquerade is KubeVirt's preferred pod-network binding (NAT via virt-launcher).
    return {
      interfaces: [{ name: "default", masquerade: {} }],
      networks: [{ name: "default", pod: {} }],
    };
  }

  const allocByNetwork = new Map(
    allocations.filter((a) => a.networkName).map((a) => [a.networkName!, a] as const),
  );

  const interfaces: Array<Record<string, unknown>> = [];
  const networks: Array<Record<string, unknown>> = [];

  // Pod first when dual-homed: KubeVirt port-forward dials interfaces[0].IP.
  if (opts?.includePodNetwork) {
    const podIface: Record<string, unknown> = {
      name: POD_NETWORK_NAME,
      masquerade: {},
    };
    const podMac = opts.podMacAddress?.trim();
    if (podMac) {
      podIface.macAddress = podMac;
    }
    interfaces.push(podIface);
    networks.push({ name: POD_NETWORK_NAME, pod: {} });
  }

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

export type BindAllocationsOpts = {
  /**
   * Dual-home Multus + pod: always stamp Multus MACs so netplan can match by MAC.
   * The pod NIC is matched by its own stamped MAC (not leftover en*).
   */
  forceMac?: boolean;
};

/**
 * Pair Multus attachments with IPAM results: assign KubeVirt network names and MACs
 * so netplan can match multi-NIC guests.
 */
export function bindAllocationsToNetworks(
  multusNames: string[],
  rawAllocations: Array<AllocatedIp | null>,
  opts?: BindAllocationsOpts,
): AllocatedIp[] {
  const bound: AllocatedIp[] = [];
  multusNames.forEach((_multusName, index) => {
    const raw = rawAllocations[index];
    if (!raw) return;
    const networkName = interfaceNameForAttachment(index, multusNames.length);
    const multiNic = multusNames.length > 1;
    // Multi-NIC / dual-home always need MAC match; single Multus-only with
    // pool.interface may keep guest name match.
    const needsMac = opts?.forceMac || multiNic || !raw.interfaceName;
    bound.push({
      ...raw,
      // Dual-home: prefer MAC match over guest interface name (two virtio NICs).
      interfaceName: needsMac ? undefined : raw.interfaceName,
      networkName,
      macAddress: needsMac
        ? (raw.macAddress ?? generateLocalMacAddress())
        : raw.macAddress,
    });
  });
  return bound;
}

/** Resolved secondary disk ready for the VM template (create path). */
export type ResolvedExtraDisk = {
  /** Volume + disk device name (e.g. disk-1). */
  volumeName: string;
  /** Standalone DataVolume name in the VM namespace. */
  dataVolumeName: string;
};

export type BuildVmManifestOpts = {
  /** Extra labels on the VM and template (merged after defaults). */
  labels?: Record<string, string>;
  /** Extra annotations on the VM (merged after IPAM annotations). */
  annotations?: Record<string, string>;
  /**
   * Full cloud-init user-data document (including `#cloud-config`).
   * When omitted, a minimal SSH-key-only config is generated.
   * Ignored when `userDataSecretName` is set.
   */
  userData?: string;
  /**
   * Extra OpenSSH public keys merged into the default cloud-init user-data
   * (alongside `input.sshPublicKey`). Used for the platform console key.
   * Ignored when `userData` or `userDataSecretName` is set.
   */
  extraAuthorizedKeys?: string[];
  /**
   * Secret name in the VM namespace with key `userdata`.
   * Preferred for payloads over KubeVirt's 2048-byte inline userData limit.
   *
   * Referenced as cloudInitNoCloud.secretRef (KubeVirt field name; description
   * calls it UserDataSecretRef — do not use userDataSecretRef, which is pruned
   * by the CRD structural schema on current cluster versions).
   */
  userDataSecretName?: string;
  /**
   * Attach the pod network in addition to Multus (dual-home).
   * Pod is always named `pod` and listed first; Multus names stay default/netN.
   */
  includePodNetwork?: boolean;
  /**
   * Cluster pod/service CIDRs to route via the masquerade gateway on dual-home
   * guests (from clusters.yaml `network`). Without these, Multus default route
   * steals all cluster-bound traffic.
   */
  clusterCidrs?: string[];
  /**
   * Secondary data disks (scsi + hotpluggable standalone DataVolumes).
   * Pre-created by createVm before the VM is submitted.
   */
  extraDisks?: ResolvedExtraDisk[];
  /**
   * Shared router: Multus NICs keep MACs for the agent; private gateway L3 is
   * owned by kmc-router-agent. Netplan MAC-matches private Multus NICs and
   * configures pod (+ optional external Multus IP).
   */
  routerAgentOwnsPrivateL3?: boolean;
  /**
   * When routerAgentOwnsPrivateL3, Multus allocation used for public netplan
   * (external gateway). Private Multus are MAC-matched only (no addresses).
   */
  routerExternalAllocation?: AllocatedIp | null;
};

/** Stable Secret name for a VM's cloud-init user-data (same namespace as the VM). */
export function cloudInitUserDataSecretName(vmName: string): string {
  return `${vmName}-userdata`.slice(0, 63);
}

/**
 * Normalize OpenSSH public key lines (dedupe, drop empties).
 * Accepts a single key string or a list (user key + platform console key, …).
 */
export function normalizeAuthorizedKeys(
  keys: string | string[] | undefined | null,
): string[] {
  const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Minimal cloud-config that installs SSH public key(s) on the image default user.
 * Optional qemu-guest-agent package + enable (soft reboot, guest OS info).
 * Explicit `users: [default]` is more reliable across Ubuntu cloud images than
 * top-level ssh_authorized_keys alone on some releases.
 *
 * Pass the user's key plus the platform console key so browser Terminal works.
 */
export function buildSshUserData(
  sshPublicKey: string | string[],
  opts?: { installGuestAgent?: boolean },
): string {
  const keys = normalizeAuthorizedKeys(sshPublicKey);
  if (keys.length === 0) {
    throw new Error("At least one SSH public key is required for cloud-init");
  }
  const lines = [
    "#cloud-config",
    "users:",
    "  - default",
    "ssh_authorized_keys:",
    ...keys.map((k) => `  - ${k}`),
  ];
  if (opts?.installGuestAgent) {
    // Packages need egress (apt). Only install when guest agent is requested —
    // that path assumes the guest can reach external repos.
    lines.push(
      "packages:",
      "  - qemu-guest-agent",
      "  - traceroute",
      "runcmd:",
      "  - systemctl enable --now qemu-guest-agent",
    );
  }
  return lines.join("\n");
}

export function buildVirtualMachineManifest(
  input: CreateVmRequest,
  allocations: AllocatedIp[] = [],
  opts?: BuildVmManifestOpts,
) {
  const diskSource = createVmDiskSource(input);
  const start = input.start !== false;
  const multusNames = multusNetworksFromRequest(input);
  const includePodNetwork = opts?.includePodNetwork === true;
  // Stable MAC for dual-home masquerade so netplan matches by MAC (not en*).
  const podMacAddress = includePodNetwork
    ? generateLocalMacAddress()
    : undefined;
  const { interfaces, networks } = buildNetworkSpec(multusNames, allocations, {
    includePodNetwork,
    podMacAddress,
  });

  const rootDiskName =
    diskSource === "existingDataVolume" ? requireExistingDvName(input) : input.name;

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

  const defaultUserData = buildSshUserData(
    [input.sshPublicKey, ...(opts?.extraAuthorizedKeys ?? [])],
    {
      installGuestAgent: input.installGuestAgent === true,
    },
  );

  // KubeVirt admission: inline userData / networkData max 2048 bytes each.
  const cloudInitNoCloud: Record<string, unknown> = {};
  if (opts?.userDataSecretName?.trim()) {
    // CRD property is secretRef (not userDataSecretRef) — unknown fields are dropped.
    cloudInitNoCloud.secretRef = {
      name: opts.userDataSecretName.trim(),
    };
  } else {
    cloudInitNoCloud.userData = opts?.userData?.trim() || defaultUserData;
  }

  if (opts?.routerAgentOwnsPrivateL3) {
    // Private Multus: MAC match only; agent assigns gateway IPs.
    // External (if any) still gets public IP + default route from netplan.
    const external = opts.routerExternalAllocation ?? null;
    const privateMultus = allocations.filter((a) => {
      if (!external?.macAddress) return true;
      return a.macAddress?.toLowerCase() !== external.macAddress.toLowerCase();
    });
    cloudInitNoCloud.networkData = buildRouterNetworkData({
      clusterCidrs: includePodNetwork ? opts?.clusterCidrs : undefined,
      privateMultus,
      external,
      podMacAddress,
    });
  } else if (allocations.length > 0) {
    cloudInitNoCloud.networkData = buildNetworkData(allocations, {
      // Masquerade needs guest DHCP on the pod NIC so port-forward can land.
      includePodDhcp: includePodNetwork,
      // Specific routes so guest→pod/service does not follow Multus default.
      clusterCidrs: includePodNetwork ? opts?.clusterCidrs : undefined,
      podMacAddress,
    });
  }

  const volumes: unknown[] = [
    {
      name: "root",
      dataVolume: { name: rootDiskName },
    },
    {
      name: "cloudinit",
      cloudInitNoCloud,
    },
  ];

  // Secondary data disks: scsi + hotpluggable so Storage-tab detach works later.
  for (const extra of opts?.extraDisks ?? []) {
    const volumeName = extra.volumeName.trim();
    const dataVolumeName = extra.dataVolumeName.trim();
    if (!volumeName || !dataVolumeName) continue;
    disks.push({
      name: volumeName,
      disk: { bus: "scsi" },
    });
    volumes.push({
      name: volumeName,
      dataVolume: { name: dataVolumeName, hotpluggable: true },
    });
  }

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

  const extraLabels = opts?.labels ?? {};
  const vmLabels: Record<string, string> = {
    "kubevirt.io/vm": input.name,
    "app.kubernetes.io/managed-by": "kmc",
    ...extraLabels,
  };

  // Root disk is always a pre-created DataVolume (see createVm / ensureRootDataVolumeFromImage).
  // Do not use dataVolumeTemplates — those tie DV lifecycle to the VM and cascade-delete on remove.
  if (diskSource === "image") {
    const image = input.image;
    const diskSize = input.diskSize?.trim();
    if (!image?.name?.trim() || !diskSize) {
      throw new Error(
        "buildVirtualMachineManifest: image mode requires image.name and diskSize",
      );
    }
  }

  const spec: Record<string, unknown> = {
    runStrategy: start ? "Always" : "Halted",
    template: {
      metadata: {
        labels: { ...vmLabels },
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

  const annotations: Record<string, string> = {
    ...(allocations.length > 0 ? ipamAnnotations(allocations) : {}),
    ...(opts?.annotations ?? {}),
  };
  // Standalone root DV has no dataVolumeTemplates — stamp size for list/detail UI.
  if (diskSource === "image" && input.diskSize?.trim()) {
    annotations[KMC_ANN_DISK_SIZE] = input.diskSize.trim();
  }

  return {
    apiVersion: "kubevirt.io/v1",
    kind: "VirtualMachine",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: vmLabels,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
    spec,
  };
}

function requireExistingDvName(input: CreateVmRequest): string {
  const n = input.existingDataVolumeName?.trim();
  if (!n) {
    throw new Error(
      "buildVirtualMachineManifest: existingDataVolume mode requires existingDataVolumeName",
    );
  }
  return n;
}
