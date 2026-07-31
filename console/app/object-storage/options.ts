import type { StorageClassInfo } from "~/lib/types";
import { OBJECT_BUCKET_PROVISIONER_HINT } from "~/lib/k8s/constants";

/**
 * True when a StorageClass provisions ObjectBucketClaims
 * (Rook Ceph RGW / lib-bucket-provisioner style).
 */
export function isObjectBucketStorageClass(
  sc: Pick<StorageClassInfo, "provisioner" | "name">,
): boolean {
  const p = sc.provisioner?.toLowerCase() ?? "";
  if (p.includes(OBJECT_BUCKET_PROVISIONER_HINT)) return true;
  // Name heuristic for clusters that omit provisioner in catalog payloads
  return /object/.test(sc.name.toLowerCase()) && /ceph|rook|rgw|s3/.test(sc.name.toLowerCase());
}

/** Prefer a Ceph object class when present; otherwise first bucket SC. */
export function pickDefaultObjectStorageClass(
  storageClasses: StorageClassInfo[],
): string | undefined {
  const buckets = storageClasses.filter(isObjectBucketStorageClass);
  if (buckets.length === 0) return undefined;
  const preferred =
    buckets.find((sc) => /ceph-object/i.test(sc.name)) ??
    buckets.find((sc) => sc.isDefault) ??
    buckets[0];
  return preferred?.name;
}
