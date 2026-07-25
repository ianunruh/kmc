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
import { getRouterAgentScript } from "~/vpcs/router-agent-script";

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
    interfaces.push({ name: POD_NETWORK_NAME, masquerade: {} });
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
   * Dual-home Multus + pod: always stamp Multus MACs so netplan can match by
   * MAC (and set-name), leaving the pod NIC for dhcp4 match on en*.
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
   * owned by kmc-router-agent. Netplan still set-names private Multus NICs and
   * configures pod (+ optional external Multus IP).
   */
  routerAgentOwnsPrivateL3?: boolean;
  /**
   * When routerAgentOwnsPrivateL3, Multus allocation used for public netplan
   * (external gateway). Private Multus use set-name only (no addresses).
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
  const { interfaces, networks } = buildNetworkSpec(multusNames, allocations, {
    includePodNetwork,
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
    // Private Multus: set-name by MAC only; agent assigns gateway IPs.
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
    });
  } else if (allocations.length > 0) {
    cloudInitNoCloud.networkData = buildNetworkData(allocations, {
      // Masquerade needs guest DHCP on the pod NIC so port-forward can land.
      includePodDhcp: includePodNetwork,
      // Specific routes so guest→pod/service does not follow Multus default.
      clusterCidrs: includePodNetwork ? opts?.clusterCidrs : undefined,
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

/** Indent a script body for cloud-init `content: |` under write_files (6 spaces). */
function yamlLiteralScriptBody(script: string): string {
  return script
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

/**
 * cloud-init user-data for a shared VPC router:
 * - Multus NICs present at L2 (MACs for agent match); private L3 is agent-owned
 * - Optional public Multus: netplan default route (until external hotplug)
 * - Pod NIC: DHCP + cluster routes (agent → apiserver)
 * - dnsmasq package + kmc-router-agent for DHCP/DNS/SNAT/FIPs + private L3
 */
export function buildRouterUserData(input: {
  /** User key and optional platform console key(s). */
  sshPublicKey: string | string[];
  /**
   * Known Multus MACs at first boot (private + optional public). Used only to
   * exclude them when discovering the pod NIC. Agent owns private L3/FORWARD.
   */
  knownMultusMacs?: string[];
  podCIDRs: string[];
  serviceCIDRs: string[];
  dnsIP?: string;
  namespace: string;
  policyConfigMap: string;
  apiServer: string;
  caData: string;
  agentToken: string;
}): string {
  const knownMacs = (input.knownMultusMacs ?? [])
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  const clusterCidrs = [
    ...input.podCIDRs.map((c) => c.trim()).filter(Boolean),
    ...input.serviceCIDRs.map((c) => c.trim()).filter(Boolean),
  ];

  // Bootstrap only: pod reachability + packages. Private Multus L3, inter-VPC
  // FORWARD, SNAT, and FIPs are fully owned by kmc-router-agent.
  const setupScript = [
    "#!/bin/bash",
    "set -euo pipefail",
    `KNOWN_MACS="${knownMacs.join(" ")}"`,
    `CLUSTER_CIDRS="${clusterCidrs.join(" ")}"`,
    "is_known_mac() {",
    '  local iface="$1" mac',
    '  [[ -f "/sys/class/net/${iface}/address" ]] || return 1',
    '  mac=$(tr "[:upper:]" "[:lower:]" < "/sys/class/net/${iface}/address")',
    '  for m in $KNOWN_MACS; do [[ "$mac" == "$m" ]] && return 0; done',
    "  return 1",
    "}",
    'POD_IF=""',
    "for path in /sys/class/net/*; do",
    '  iface=$(basename "$path")',
    '  [[ "$iface" == "lo" ]] && continue',
    '  if is_known_mac "$iface"; then continue; fi',
    '  POD_IF="$iface"',
    "  break",
    "done",
    // Fallback: first en* if MAC list empty or incomplete at early boot
    'if [[ -z "$POD_IF" ]]; then',
    "  for path in /sys/class/net/en*; do",
    '    [[ -e "$path" ]] || continue',
    '    POD_IF=$(basename "$path")',
    "    break",
    "  done",
    "fi",
    'if [[ -z "$POD_IF" ]]; then',
    '  echo "kmc-router: pod NIC not found" >&2',
    "  exit 1",
    "fi",
    "sysctl -w net.ipv4.ip_forward=1 >/dev/null",
    "sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null || true",
    'sysctl -w "net.ipv4.conf.${POD_IF}.rp_filter=2" >/dev/null || true',
    "for i in $(seq 1 60); do",
    '  if ip -4 -o addr show dev "$POD_IF" | grep -q "inet "; then break; fi',
    '  command -v dhclient >/dev/null 2>&1 && dhclient -1 "$POD_IF" 2>/dev/null || true',
    "  sleep 2",
    "done",
    'ip route del default dev "$POD_IF" 2>/dev/null || true',
    "POD_GW=$(ip -4 route show dev \"$POD_IF\" 2>/dev/null | awk '/^default/ {print $3; exit}')",
    'if [[ -z "${POD_GW:-}" ]]; then POD_GW=10.0.2.1; fi',
    "for cidr in $CLUSTER_CIDRS; do",
    '  ip route replace "$cidr" via "$POD_GW" dev "$POD_IF" || true',
    "done",
    "# Never forward via pod NIC",
    'iptables -C FORWARD -i "$POD_IF" -j DROP 2>/dev/null || iptables -I FORWARD 1 -i "$POD_IF" -j DROP',
    'iptables -C FORWARD -o "$POD_IF" -j DROP 2>/dev/null || iptables -I FORWARD 1 -o "$POD_IF" -j DROP',
    "# dnsmasq: avoid conflicting with systemd-resolved stub on 127.0.0.53",
    "mkdir -p /var/lib/kmc/dnsmasq.d /etc/dnsmasq.d",
    "systemctl disable --now systemd-resolved 2>/dev/null || true",
    "rm -f /etc/resolv.conf",
    "echo 'nameserver 1.1.1.1' > /etc/resolv.conf",
    "systemctl enable dnsmasq 2>/dev/null || true",
    "systemctl restart dnsmasq 2>/dev/null || systemctl start dnsmasq 2>/dev/null || true",
  ].join("\n");

  const caB64 = input.caData.replace(/\s+/g, "");
  const kubeconfig = [
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    "- cluster:",
    `    certificate-authority: /etc/kmc/ca.crt`,
    `    server: ${input.apiServer.replace(/\/$/, "")}`,
    "  name: cluster",
    "contexts:",
    "- context:",
    "    cluster: cluster",
    `    namespace: ${input.namespace}`,
    "    user: agent",
    "  name: agent",
    "current-context: agent",
    "users:",
    "- name: agent",
    "  user:",
    `    token: ${input.agentToken.trim()}`,
  ].join("\n");

  const envFile = [
    `KMC_NAMESPACE=${input.namespace}`,
    `KMC_POLICY_CM=${input.policyConfigMap}`,
    `KMC_APISERVER=${input.apiServer.replace(/\/$/, "")}`,
    "KUBECONFIG=/etc/kmc/kubeconfig",
    "KMC_CA_FILE=/etc/kmc/ca.crt",
    "KMC_AGENT_PATH=/usr/local/sbin/kmc-router-agent",
    "KMC_ENV_FILE=/etc/kmc/router-agent.env",
    "KMC_POLICY_KEY=policy.json",
    "KMC_AGENT_KEY=agent.py",
    "KMC_HEARTBEAT_SECONDS=30",
    "KMC_RESYNC_SECONDS=300",
  ].join("\n");

  const agentScriptYaml = yamlLiteralScriptBody(getRouterAgentScript());
  const setupScriptYaml = yamlLiteralScriptBody(setupScript);
  const kubeconfigYaml = yamlLiteralScriptBody(kubeconfig);
  const envFileYaml = yamlLiteralScriptBody(envFile);
  const caB64Yaml = yamlLiteralScriptBody(caB64);

  const authorizedKeys = normalizeAuthorizedKeys(input.sshPublicKey);
  if (authorizedKeys.length === 0) {
    throw new Error("buildRouterUserData requires at least one SSH public key");
  }

  return [
    "#cloud-config",
    "users:",
    "  - default",
    "ssh_authorized_keys:",
    ...authorizedKeys.map((k) => `  - ${k}`),
    "package_update: true",
    "packages:",
    "  - qemu-guest-agent",
    "  - python3",
    "  - iptables",
    "  - dnsmasq",
    "  - iputils-arping",
    "  - traceroute",
    "write_files:",
    "  - path: /etc/sysctl.d/99-kmc-router.conf",
    "    content: |",
    "      net.ipv4.ip_forward=1",
    "      net.ipv4.conf.all.rp_filter=2",
    "  - path: /etc/kmc/ca.crt.b64",
    "    permissions: '0600'",
    "    content: |",
    caB64Yaml,
    "  - path: /etc/kmc/kubeconfig",
    "    permissions: '0600'",
    "    content: |",
    kubeconfigYaml,
    "  - path: /etc/kmc/router-agent.env",
    "    permissions: '0600'",
    "    content: |",
    envFileYaml,
    "  - path: /usr/local/sbin/kmc-router-setup.sh",
    "    permissions: '0755'",
    "    content: |",
    setupScriptYaml,
    "  - path: /usr/local/sbin/kmc-router-agent",
    "    permissions: '0755'",
    "    content: |",
    agentScriptYaml,
    "  - path: /etc/systemd/system/kmc-router.service",
    "    content: |",
    "      [Unit]",
    "      Description=kmc VPC router setup (pod routes + dnsmasq package)",
    "      After=network-online.target",
    "      Wants=network-online.target",
    "      [Service]",
    "      Type=oneshot",
    "      ExecStart=/usr/local/sbin/kmc-router-setup.sh",
    "      RemainAfterExit=yes",
    "      [Install]",
    "      WantedBy=multi-user.target",
    "  - path: /etc/systemd/system/kmc-router-agent.service",
    "    content: |",
    "      [Unit]",
    "      Description=kmc VPC router policy agent (DHCP/DNS/SNAT/floating IPs)",
    "      After=kmc-router.service network-online.target",
    "      Requires=kmc-router.service",
    "      Wants=network-online.target",
    "      [Service]",
    "      Type=simple",
    "      EnvironmentFile=-/etc/kmc/router-agent.env",
    "      ExecStart=/usr/bin/python3 /usr/local/sbin/kmc-router-agent",
    "      Restart=on-failure",
    "      RestartSec=5",
    "      [Install]",
    "      WantedBy=multi-user.target",
    "runcmd:",
    "  - mkdir -p /etc/kmc /var/lib/kmc /var/lib/kmc/dnsmasq.d",
    "  - base64 -d /etc/kmc/ca.crt.b64 > /etc/kmc/ca.crt",
    "  - chmod 600 /etc/kmc/ca.crt /etc/kmc/kubeconfig /etc/kmc/router-agent.env",
    "  - systemctl enable --now qemu-guest-agent",
    "  - sysctl --system",
    "  - systemctl daemon-reload",
    "  - systemctl enable --now kmc-router.service",
    "  - systemctl enable --now kmc-router-agent.service",
  ].join("\n");
}
