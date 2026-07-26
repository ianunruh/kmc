import type { CreateDatabaseRequest, DatabaseSizePreset } from "~/lib/types";
import {
  KMC_LABEL_RESOURCE,
  KMC_LABEL_SIZE,
  KMC_MANAGED_BY,
  KMC_RESOURCE_DATABASE,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import {
  DATABASE_SIZE_PRESETS,
  resolvePostgresImage,
} from "./options";

export function ownershipLabels(input: {
  name: string;
  size: DatabaseSizePreset;
}): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_DATABASE,
    [KMC_LABEL_SIZE]: input.size,
    "app.kubernetes.io/name": input.name,
    "app.kubernetes.io/component": "database",
  };
}

/**
 * Build a CloudNativePG Cluster manifest from create-form input.
 * Keeps knobs minimal — size preset drives resources + default storage.
 */
export function buildDatabaseClusterManifest(input: CreateDatabaseRequest) {
  const preset = DATABASE_SIZE_PRESETS[input.size];
  if (!preset) {
    throw new Error(`Unknown size preset: ${input.size}`);
  }

  const image = resolvePostgresImage(input.postgresVersion);
  if (!image) {
    throw new Error(
      `Unsupported Postgres version "${input.postgresVersion}". ` +
        `Choose one of: ${["17", "16", "15"].join(", ")}`,
    );
  }

  const instances = input.instances;
  if (instances !== 1 && instances !== 3) {
    throw new Error("instances must be 1 or 3");
  }

  const storageSize = input.storageSize?.trim() || preset.storageSize;
  const labels = ownershipLabels({ name: input.name, size: input.size });

  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels,
    },
    spec: {
      instances,
      imageName: image.imageName,
      // Superuser secret makes in-cluster connection straightforward (Phase 3 UX).
      enableSuperuserAccess: true,
      bootstrap: {
        initdb: {
          database: "app",
          owner: "app",
        },
      },
      storage: {
        size: storageSize,
        ...(input.storageClass?.trim()
          ? { storageClass: input.storageClass.trim() }
          : {}),
      },
      resources: {
        requests: { ...preset.resources.requests },
        limits: { ...preset.resources.limits },
      },
    },
  };
}
