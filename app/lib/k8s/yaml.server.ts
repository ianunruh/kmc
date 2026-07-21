import { stringify } from "yaml";
import type { ClusterId } from "~/lib/types";
import { getClusterClients } from "./clients.server";

export interface GetCustomObjectYamlOptions {
  cluster: ClusterId;
  group: string;
  version: string;
  plural: string;
  name: string;
  /** Omit for cluster-scoped resources */
  namespace?: string;
}

/**
 * Fetch a custom resource and return cleaned YAML for display.
 */
export async function getCustomObjectYaml(
  opts: GetCustomObjectYamlOptions,
): Promise<string> {
  const { cluster, group, version, plural, name, namespace } = opts;
  const { custom } = getClusterClients(cluster);

  const obj = namespace
    ? await custom.getNamespacedCustomObject({
        group,
        version,
        namespace,
        plural,
        name,
      })
    : await custom.getClusterCustomObject({
        group,
        version,
        plural,
        name,
      });

  return toResourceYaml(obj);
}

/**
 * Serialize a Kubernetes-like object to YAML, stripping noisy server fields.
 * Safe to call from loaders with any plain object.
 */
export function toResourceYaml(obj: unknown): string {
  const cleaned = stripNoisyFields(structuredCloneSafe(obj));
  return (
    stringify(cleaned, {
      lineWidth: 120,
    }).trimEnd() + "\n"
  );
}

function structuredCloneSafe(obj: unknown): unknown {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(obj);
    } catch {
      // fall through
    }
  }
  return JSON.parse(JSON.stringify(obj ?? null));
}

function stripNoisyFields(input: unknown): unknown {
  if (input == null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(stripNoisyFields);

  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === "managedFields") continue;
    if (
      key === "metadata" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const md = { ...(value as Record<string, unknown>) };
      delete md.managedFields;
      // Drop self-links / generation noise that kubectl also often omits in apply-ready YAML
      delete md.generation;
      out.metadata = stripNoisyFields(md);
      continue;
    }
    out[key] = stripNoisyFields(value);
  }

  return out;
}
