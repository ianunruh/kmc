import type { CreateVmRequest } from "~/lib/types";

export function buildVirtualMachineManifest(input: CreateVmRequest) {
  const start = input.start !== false;
  const imageNs = input.image.namespace || "vm-images";
  const diskName = input.name;

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

  const volumes: unknown[] = [
    {
      name: "root",
      dataVolume: { name: diskName },
    },
    {
      name: "cloudinit",
      cloudInitNoCloud: {
        userData: [
          "#cloud-config",
          "ssh_authorized_keys:",
          `  - ${input.sshPublicKey.trim()}`,
        ].join("\n"),
      },
    },
  ];

  const domain: Record<string, unknown> = {
    devices: {
      disks,
      interfaces: [
        {
          name: "default",
          bridge: {},
        },
      ],
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

  const networks: unknown[] = input.network?.multusNetworkName
    ? [
        {
          name: "default",
          multus: { networkName: input.network.multusNetworkName },
        },
      ]
    : [
        {
          name: "default",
          pod: {},
        },
      ];

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
      ...(input.storageClass
        ? { storageClassName: input.storageClass }
        : {}),
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
    },
    spec,
  };
}
