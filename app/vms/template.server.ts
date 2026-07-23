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
   * Secret name in the VM namespace with key `userdata`.
   * Preferred for payloads over KubeVirt's 2048-byte inline userData limit.
   *
   * Referenced as cloudInitNoCloud.secretRef (KubeVirt field name; description
   * calls it UserDataSecretRef — do not use userDataSecretRef, which is pruned
   * by the CRD structural schema on current cluster versions).
   */
  userDataSecretName?: string;
};

/** Stable Secret name for a VM's cloud-init user-data (same namespace as the VM). */
export function cloudInitUserDataSecretName(vmName: string): string {
  return `${vmName}-userdata`.slice(0, 63);
}

/**
 * Minimal cloud-config that installs an SSH public key on the image default user.
 * Explicit `users: [default]` is more reliable across Ubuntu cloud images than
 * top-level ssh_authorized_keys alone on some releases.
 */
export function buildSshUserData(sshPublicKey: string): string {
  const key = sshPublicKey.trim();
  return [
    "#cloud-config",
    "users:",
    "  - default",
    "ssh_authorized_keys:",
    `  - ${key}`,
  ].join("\n");
}

export function buildVirtualMachineManifest(
  input: CreateVmRequest,
  allocations: AllocatedIp[] = [],
  opts?: BuildVmManifestOpts,
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

  const defaultUserData = buildSshUserData(input.sshPublicKey);

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

  const extraLabels = opts?.labels ?? {};
  const vmLabels: Record<string, string> = {
    "kubevirt.io/vm": input.name,
    "app.kubernetes.io/managed-by": "kmc",
    ...extraLabels,
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

/**
 * cloud-init user-data for a dual-homed Ubuntu NAT gateway:
 * SSH key, ip_forward, MASQUERADE on the public NIC (matched by MAC).
 */
export function buildNatGatewayUserData(input: {
  sshPublicKey: string;
  privateMac: string;
  publicMac: string;
}): string {
  const privateMac = input.privateMac.trim().toLowerCase();
  const publicMac = input.publicMac.trim().toLowerCase();
  // Indent carefully: this is embedded under write_files content as a literal block.
  const script = [
    "#!/bin/bash",
    "set -euo pipefail",
    `PRIVATE_MAC="${privateMac}"`,
    `PUBLIC_MAC="${publicMac}"`,
    'if_by_mac() {',
    '  local want="$1"',
    '  local path iface mac',
    '  for path in /sys/class/net/*; do',
    '    iface=$(basename "$path")',
    '    [[ "$iface" == "lo" ]] && continue',
    '    [[ -f "$path/address" ]] || continue',
    '    mac=$(tr "[:upper:]" "[:lower:]" < "$path/address")',
    '    if [[ "$mac" == "$want" ]]; then',
    '      echo "$iface"',
    '      return 0',
    '    fi',
    '  done',
    '  return 1',
    '}',
    'PRIVATE_IF=$(if_by_mac "$PRIVATE_MAC") || { echo "kmc-nat: private NIC not found for $PRIVATE_MAC" >&2; exit 1; }',
    'PUBLIC_IF=$(if_by_mac "$PUBLIC_MAC") || { echo "kmc-nat: public NIC not found for $PUBLIC_MAC" >&2; exit 1; }',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null',
    '# Avoid strict reverse-path filter dropping multi-homed replies',
    'sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null || true',
    'sysctl -w "net.ipv4.conf.${PRIVATE_IF}.rp_filter=2" >/dev/null || true',
    'sysctl -w "net.ipv4.conf.${PUBLIC_IF}.rp_filter=2" >/dev/null || true',
    'iptables -t nat -C POSTROUTING -o "$PUBLIC_IF" -j MASQUERADE 2>/dev/null || \\',
    '  iptables -t nat -A POSTROUTING -o "$PUBLIC_IF" -j MASQUERADE',
    'iptables -C FORWARD -i "$PRIVATE_IF" -o "$PUBLIC_IF" -j ACCEPT 2>/dev/null || \\',
    '  iptables -A FORWARD -i "$PRIVATE_IF" -o "$PUBLIC_IF" -j ACCEPT',
    'iptables -C FORWARD -i "$PUBLIC_IF" -o "$PRIVATE_IF" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \\',
    '  iptables -A FORWARD -i "$PUBLIC_IF" -o "$PRIVATE_IF" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
  ].join("\n");

  // YAML literal block under `content: |` (indented 4 spaces): body needs 6.
  const scriptYaml = script
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");

  return [
    "#cloud-config",
    "users:",
    "  - default",
    "ssh_authorized_keys:",
    `  - ${input.sshPublicKey.trim()}`,
    "write_files:",
    "  - path: /etc/sysctl.d/99-kmc-nat.conf",
    "    content: |",
    "      net.ipv4.ip_forward=1",
    "      net.ipv4.conf.all.rp_filter=2",
    "  - path: /usr/local/sbin/kmc-nat-setup.sh",
    "    permissions: '0755'",
    "    content: |",
    scriptYaml,
    "  - path: /etc/systemd/system/kmc-nat.service",
    "    content: |",
    "      [Unit]",
    "      Description=kmc VPC NAT gateway (ip_forward + MASQUERADE)",
    "      After=network-online.target",
    "      Wants=network-online.target",
    "      [Service]",
    "      Type=oneshot",
    "      ExecStart=/usr/local/sbin/kmc-nat-setup.sh",
    "      RemainAfterExit=yes",
    "      [Install]",
    "      WantedBy=multi-user.target",
    "runcmd:",
    "  - sysctl --system",
    "  - systemctl daemon-reload",
    "  - systemctl enable --now kmc-nat.service",
  ].join("\n");
}
