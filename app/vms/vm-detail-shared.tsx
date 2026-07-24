import { useRouteLoaderData } from "react-router";
import type { VmDetail, VmVolumeInfo } from "~/lib/types";
import { dataVolumePath } from "~/lib/format";

/** Route id for the VM detail layout (parent of tab subpages). */
export const VM_DETAIL_ROUTE_ID = "routes/vms.$cluster.$namespace.$name";

export type VmDetailLoaderData = {
  vm: VmDetail;
  prometheusConfigured: boolean;
};

export function useVmDetail(): VmDetailLoaderData {
  const data = useRouteLoaderData(VM_DETAIL_ROUTE_ID) as VmDetailLoaderData | undefined;
  if (!data) {
    throw new Error("useVmDetail must be used under the VM detail layout route");
  }
  return data;
}

export function volumeHref(
  cluster: string,
  namespace: string,
  vol: VmVolumeInfo,
): string | null {
  if (!vol.linkName) return null;
  if (vol.kind !== "DataVolume" && vol.kind !== "PVC") return null;
  return dataVolumePath({ cluster, namespace, name: vol.linkName });
}

export function interestingAnnotations(
  annotations: Record<string, string>,
): [string, string][] {
  return Object.entries(annotations).filter(
    ([k]) =>
      !k.startsWith("kubectl.kubernetes.io/") &&
      !k.startsWith("kubevirt.io/latest") &&
      !k.startsWith("kubevirt.io/storage"),
  );
}

export function intentSuccessLabel(intent?: string): string {
  switch (intent) {
    case "softreboot":
      return "soft reboot";
    case "restart":
      return "hard restart";
    case "disassociate-fip":
      return "floating IP disassociate";
    case "create-snapshot":
      return "snapshot create";
    case "delete-snapshot":
      return "snapshot delete";
    case "restore-snapshot":
      return "snapshot restore";
    default:
      return intent ?? "action";
  }
}

export type VmDetailActionResult = {
  ok?: boolean;
  error?: string;
  intent?: string;
  retainDisks?: boolean;
  retainedDisks?: string[];
  snapshotName?: string;
  restoreName?: string;
};
