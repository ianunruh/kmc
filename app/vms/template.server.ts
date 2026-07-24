import type { CreateVmRequest } from "~/lib/types";
import {
  buildNetworkData,
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
   * (masquerade) as interface/network name `pod`. Used by shared routers so the
   * in-guest agent can reach the apiserver.
   */
  includePodNetwork?: boolean;
};

/**
 * Build domain interfaces + template networks for Multus multi-attach, pod-only,
 * or Multus + pod (shared router).
 * When allocations include a MAC for a Multus interface name, stamp it on the iface.
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

  if (opts?.includePodNetwork) {
    interfaces.push({ name: POD_NETWORK_NAME, masquerade: {} });
    networks.push({ name: POD_NETWORK_NAME, pod: {} });
  }

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
  /**
   * Attach the pod network in addition to Multus (shared routers).
   * Multus interface names stay net0/net1/…; pod is always named `pod`.
   */
  includePodNetwork?: boolean;
};

/** Stable Secret name for a VM's cloud-init user-data (same namespace as the VM). */
export function cloudInitUserDataSecretName(vmName: string): string {
  return `${vmName}-userdata`.slice(0, 63);
}

/**
 * Minimal cloud-config that installs an SSH public key on the image default user.
 * Optional qemu-guest-agent package + enable (soft reboot, guest OS info).
 * Explicit `users: [default]` is more reliable across Ubuntu cloud images than
 * top-level ssh_authorized_keys alone on some releases.
 */
export function buildSshUserData(
  sshPublicKey: string,
  opts?: { installGuestAgent?: boolean },
): string {
  const key = sshPublicKey.trim();
  const lines = [
    "#cloud-config",
    "users:",
    "  - default",
    "ssh_authorized_keys:",
    `  - ${key}`,
  ];
  if (opts?.installGuestAgent) {
    lines.push(
      "packages:",
      "  - qemu-guest-agent",
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
  const start = input.start !== false;
  const imageNs = input.image.namespace || "vm-images";
  const diskName = input.name;
  const multusNames = multusNetworksFromRequest(input);
  const { interfaces, networks } = buildNetworkSpec(multusNames, allocations, {
    includePodNetwork: opts?.includePodNetwork === true,
  });

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

  const defaultUserData = buildSshUserData(input.sshPublicKey, {
    installGuestAgent: input.installGuestAgent === true,
  });

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

  // CDI `storage` (not legacy `pvc`) — fills volumeMode/accessModes from StorageProfile when omitted.
  const dataVolumeSpec: Record<string, unknown> = {
    source: {
      pvc: {
        namespace: imageNs,
        name: input.image.name,
      },
    },
    storage: {
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

/** Indent a script body for cloud-init `content: |` under write_files (6 spaces). */
function yamlLiteralScriptBody(script: string): string {
  return script
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

/**
 * cloud-init user-data for a shared VPC router:
 * - One or more Multus private NICs (gateway IP per VPC, MAC-matched)
 * - Optional public Multus (external gateway: default route + MASQUERADE)
 * - Pod NIC: DHCP, cluster routes only (agent → apiserver)
 * - dnsmasq + kmc-router-agent for DHCP/DNS (+ floating IPs when external)
 */
export function buildRouterUserData(input: {
  sshPublicKey: string;
  /** Ordered private Multus MACs (same order as VPC interfaces). */
  privateMacs: string[];
  /** Public Multus MAC when external gateway is enabled. */
  publicMac?: string;
  podCIDRs: string[];
  serviceCIDRs: string[];
  dnsIP?: string;
  namespace: string;
  policyConfigMap: string;
  apiServer: string;
  caData: string;
  agentToken: string;
}): string {
  const privateMacs = input.privateMacs.map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (privateMacs.length === 0) {
    throw new Error("buildRouterUserData requires at least one private MAC");
  }
  const publicMac = input.publicMac?.trim().toLowerCase() || "";
  const clusterCidrs = [
    ...input.podCIDRs.map((c) => c.trim()).filter(Boolean),
    ...input.serviceCIDRs.map((c) => c.trim()).filter(Boolean),
  ];

  const setupScript = [
    "#!/bin/bash",
    "set -euo pipefail",
    `PRIVATE_MACS="${privateMacs.join(" ")}"`,
    `PUBLIC_MAC="${publicMac}"`,
    `CLUSTER_CIDRS="${clusterCidrs.join(" ")}"`,
    "if_by_mac() {",
    '  local want="$1"',
    "  local path iface mac",
    "  for path in /sys/class/net/*; do",
    '    iface=$(basename "$path")',
    '    [[ "$iface" == "lo" ]] && continue',
    '    [[ -f "$path/address" ]] || continue',
    '    mac=$(tr "[:upper:]" "[:lower:]" < "$path/address")',
    '    if [[ "$mac" == "$want" ]]; then',
    '      echo "$iface"',
    "      return 0",
    "    fi",
    "  done",
    "  return 1",
    "}",
    "PRIVATE_IFS=()",
    "for mac in $PRIVATE_MACS; do",
    '  iface=$(if_by_mac "$mac") || { echo "kmc-router: private NIC not found for $mac" >&2; exit 1; }',
    '  PRIVATE_IFS+=("$iface")',
    "done",
    'PUBLIC_IF=""',
    'if [[ -n "$PUBLIC_MAC" ]]; then',
    '  PUBLIC_IF=$(if_by_mac "$PUBLIC_MAC") || { echo "kmc-router: public NIC not found for $PUBLIC_MAC" >&2; exit 1; }',
    "fi",
    'POD_IF=""',
    "for path in /sys/class/net/*; do",
    '  iface=$(basename "$path")',
    '  [[ "$iface" == "lo" ]] && continue',
    '  skip=0',
    '  for p in "${PRIVATE_IFS[@]}"; do [[ "$iface" == "$p" ]] && skip=1 && break; done',
    '  [[ -n "$PUBLIC_IF" && "$iface" == "$PUBLIC_IF" ]] && skip=1',
    '  [[ "$skip" -eq 1 ]] && continue',
    '  POD_IF="$iface"',
    "  break",
    "done",
    'if [[ -z "$POD_IF" ]]; then',
    '  echo "kmc-router: pod NIC not found" >&2',
    "  exit 1",
    "fi",
    "sysctl -w net.ipv4.ip_forward=1 >/dev/null",
    "sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null || true",
    'sysctl -w "net.ipv4.conf.${POD_IF}.rp_filter=2" >/dev/null || true',
    'for iface in "${PRIVATE_IFS[@]}"; do',
    '  sysctl -w "net.ipv4.conf.${iface}.rp_filter=2" >/dev/null || true',
    "done",
    'if [[ -n "$PUBLIC_IF" ]]; then',
    '  sysctl -w "net.ipv4.conf.${PUBLIC_IF}.rp_filter=2" >/dev/null || true',
    "fi",
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
    "# Allow forwarding between private VPC interfaces",
    'for a in "${PRIVATE_IFS[@]}"; do',
    '  for b in "${PRIVATE_IFS[@]}"; do',
    '    [[ "$a" == "$b" ]] && continue',
    '    iptables -C FORWARD -i "$a" -o "$b" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$a" -o "$b" -j ACCEPT',
    "  done",
    "done",
    'if [[ -n "$PUBLIC_IF" ]]; then',
    '  iptables -t nat -C POSTROUTING -o "$PUBLIC_IF" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o "$PUBLIC_IF" -j MASQUERADE',
    '  for a in "${PRIVATE_IFS[@]}"; do',
    '    iptables -C FORWARD -i "$a" -o "$PUBLIC_IF" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$a" -o "$PUBLIC_IF" -j ACCEPT',
    '    iptables -C FORWARD -i "$PUBLIC_IF" -o "$a" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$PUBLIC_IF" -o "$a" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    "  done",
    "fi",
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

  return [
    "#cloud-config",
    "users:",
    "  - default",
    "ssh_authorized_keys:",
    `  - ${input.sshPublicKey.trim()}`,
    "package_update: true",
    "packages:",
    "  - qemu-guest-agent",
    "  - python3",
    "  - iptables",
    "  - dnsmasq",
    "  - iputils-arping",
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
    "      Description=kmc VPC router setup (forwarding + pod routes + dnsmasq)",
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
