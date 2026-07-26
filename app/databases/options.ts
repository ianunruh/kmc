import type { DatabaseSizePreset } from "~/lib/types";

export type DatabaseSizePresetDef = {
  id: DatabaseSizePreset;
  label: string;
  description: string;
  storageSize: string;
  resources: {
    requests: { cpu: string; memory: string };
    limits: { cpu: string; memory: string };
  };
};

/** Opinionated size tiers for kmc-managed PostgreSQL clusters. */
export const DATABASE_SIZE_PRESETS: Record<
  DatabaseSizePreset,
  DatabaseSizePresetDef
> = {
  small: {
    id: "small",
    label: "Small",
    description: "0.5–1 CPU · 1–2 GiB RAM · 20 Gi storage",
    storageSize: "20Gi",
    resources: {
      requests: { cpu: "250m", memory: "1Gi" },
      limits: { cpu: "1", memory: "2Gi" },
    },
  },
  medium: {
    id: "medium",
    label: "Medium",
    description: "1–2 CPU · 2–4 GiB RAM · 50 Gi storage",
    storageSize: "50Gi",
    resources: {
      requests: { cpu: "500m", memory: "2Gi" },
      limits: { cpu: "2", memory: "4Gi" },
    },
  },
  large: {
    id: "large",
    label: "Large",
    description: "2–4 CPU · 4–8 GiB RAM · 100 Gi storage",
    storageSize: "100Gi",
    resources: {
      requests: { cpu: "1", memory: "4Gi" },
      limits: { cpu: "4", memory: "8Gi" },
    },
  },
};

export const DATABASE_SIZE_OPTIONS = (
  Object.values(DATABASE_SIZE_PRESETS) as DatabaseSizePresetDef[]
).map((p) => ({
  value: p.id,
  label: `${p.label} — ${p.description}`,
}));

/** Allowed instance counts on create (single-node vs CNPG HA). */
export const DATABASE_INSTANCE_OPTIONS = [
  { value: "1", label: "1 instance (dev / single-node)" },
  { value: "3", label: "3 instances (HA)" },
] as const;

export type DatabasePostgresImage = {
  /** Major version key used in forms (e.g. `17`). */
  version: string;
  label: string;
  imageName: string;
};

/**
 * Postgres images offered on create. Major tags float to the latest minor
 * published by CloudNativePG for that major.
 */
export const DATABASE_POSTGRES_IMAGES: DatabasePostgresImage[] = [
  {
    version: "17",
    label: "PostgreSQL 17",
    imageName: "ghcr.io/cloudnative-pg/postgresql:17",
  },
  {
    version: "16",
    label: "PostgreSQL 16",
    imageName: "ghcr.io/cloudnative-pg/postgresql:16",
  },
  {
    version: "15",
    label: "PostgreSQL 15",
    imageName: "ghcr.io/cloudnative-pg/postgresql:15",
  },
];

export const DEFAULT_DATABASE_POSTGRES_VERSION = "17";
export const DEFAULT_DATABASE_SIZE: DatabaseSizePreset = "small";
export const DEFAULT_DATABASE_INSTANCES = 1;

export function resolvePostgresImage(
  version: string,
): DatabasePostgresImage | undefined {
  return DATABASE_POSTGRES_IMAGES.find((img) => img.version === version);
}

export function isDatabaseSizePreset(value: string): value is DatabaseSizePreset {
  return value === "small" || value === "medium" || value === "large";
}
