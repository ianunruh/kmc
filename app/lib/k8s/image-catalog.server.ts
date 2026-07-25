/**
 * Shared golden-image helpers for the cluster catalog (Launch VM pickers)
 * and the Images UI. Kept separate from app/images to avoid import cycles
 * (catalog → images → vms → catalog).
 */
import type { ClusterId, ImageInfo } from "~/lib/types";
import { getClusterClients } from "./clients.server";
import { IMAGE_PREFERENCE_LABEL } from "./constants";

/** Namespace scanned / written for golden images. */
export function getImageNamespace(): string {
  return process.env.KMC_IMAGE_NAMESPACE?.trim() || "vm-images";
}

/**
 * Bound golden-image PVCs for Launch VM / catalog pickers.
 * Import-in-progress images are excluded.
 */
export async function listReadyImages(cluster: ClusterId): Promise<ImageInfo[]> {
  const namespace = getImageNamespace();
  try {
    const { core } = getClusterClients(cluster);
    const res = await core.listNamespacedPersistentVolumeClaim({ namespace });
    return (res.items ?? [])
      .filter((pvc) => pvc.status?.phase === "Bound")
      .map((pvc) => {
        const preference = pvc.metadata?.labels?.[IMAGE_PREFERENCE_LABEL]?.trim();
        return {
          name: pvc.metadata?.name ?? "",
          namespace: pvc.metadata?.namespace ?? namespace,
          capacity:
            pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage,
          storageClass: pvc.spec?.storageClassName ?? undefined,
          preference: preference || undefined,
        } satisfies ImageInfo;
      })
      .filter((i) => i.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
