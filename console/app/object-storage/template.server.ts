import type { CreateObjectBucketRequest } from "~/lib/types";
import {
  KMC_LABEL_RESOURCE,
  KMC_MANAGED_BY,
  KMC_RESOURCE_OBJECT_BUCKET,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";

export function ownershipLabels(input: {
  name: string;
}): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_OBJECT_BUCKET,
    "app.kubernetes.io/name": input.name,
    "app.kubernetes.io/component": "object-storage",
  };
}

/**
 * Build an ObjectBucketClaim manifest for Rook Ceph (or other OBC provisioners).
 * Uses `generateBucketName` when no exact bucket name is provided so the
 * provisioner can ensure global uniqueness.
 */
export function buildObjectBucketClaimManifest(input: CreateObjectBucketRequest) {
  const name = input.name.trim();
  const storageClass = input.storageClass.trim();
  if (!name) throw new Error("name is required");
  if (!storageClass) throw new Error("storageClass is required");

  const exactBucket = input.bucketName?.trim();
  const labels = ownershipLabels({ name });

  return {
    apiVersion: "objectbucket.io/v1alpha1",
    kind: "ObjectBucketClaim",
    metadata: {
      name,
      namespace: input.namespace.trim(),
      labels,
    },
    spec: {
      storageClassName: storageClass,
      ...(exactBucket
        ? { bucketName: exactBucket }
        : { generateBucketName: name }),
    },
  };
}
