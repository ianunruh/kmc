import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateObjectBucketRequest,
  ObjectBucketCredentials,
  ObjectBucketDetail,
  ObjectBucketStatus,
  ObjectBucketSummary,
} from "~/lib/types";
import {
  KMC_LABEL_RESOURCE,
  KMC_MANAGED_BY,
  KMC_RESOURCE_OBJECT_BUCKET,
  MANAGED_BY_LABEL,
  OBC_BUCKET_PLURAL,
  OBC_CLAIM_PLURAL,
  OBC_GROUP,
  OBC_VERSION,
} from "~/lib/k8s/constants";
import { assertVmNamespaceAllowed } from "~/lib/k8s/catalog.server";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { listClusters } from "~/vms/vms.server";
import { buildObjectBucketClaimManifest } from "./template.server";

interface KubeObjectBucketClaim {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    storageClassName?: string;
    bucketName?: string;
    generateBucketName?: string;
    objectBucketName?: string;
    additionalConfig?: Record<string, string>;
  };
  status?: {
    phase?: string;
  };
}

interface KubeObjectBucket {
  metadata?: {
    name?: string;
  };
  spec?: {
    endpoint?: {
      bucketHost?: string;
      bucketPort?: number | string;
      bucketName?: string;
      region?: string;
      subRegion?: string;
    };
    storageClassName?: string;
  };
  status?: {
    phase?: string;
  };
}

function isManagedByKmc(labels?: Record<string, string>): boolean {
  if (!labels) return false;
  return (
    labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY &&
    labels[KMC_LABEL_RESOURCE] === KMC_RESOURCE_OBJECT_BUCKET
  );
}

function deriveStatus(phase?: string): ObjectBucketStatus {
  const p = (phase ?? "").trim();
  if (!p) return "Unknown";
  // Normalize common OBC phases for badges
  if (/^bound$/i.test(p)) return "Bound";
  if (/^pending$/i.test(p)) return "Pending";
  if (/^released$/i.test(p)) return "Released";
  if (/fail|error/i.test(p)) return "Failed";
  return p;
}

function mapSummary(
  cluster: ClusterId,
  c: KubeObjectBucketClaim,
): ObjectBucketSummary {
  const phase = c.status?.phase ?? "";
  return {
    cluster,
    namespace: c.metadata?.namespace ?? "default",
    name: c.metadata?.name ?? "unknown",
    status: deriveStatus(phase),
    phase: phase || "Unknown",
    bucketName:
      c.spec?.bucketName?.trim() ||
      c.spec?.generateBucketName?.trim() ||
      undefined,
    storageClass: c.spec?.storageClassName,
    objectBucketName: c.spec?.objectBucketName,
    age: c.metadata?.creationTimestamp ?? "",
    managedByKmc: isManagedByKmc(c.metadata?.labels),
  };
}

function mapDetail(
  cluster: ClusterId,
  c: KubeObjectBucketClaim,
): ObjectBucketDetail {
  const summary = mapSummary(cluster, c);
  return {
    ...summary,
    uid: c.metadata?.uid,
    labels: c.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(c.metadata?.annotations ?? {}).filter(
        ([k]) =>
          !k.startsWith("kubectl.kubernetes.io/") &&
          !k.startsWith("argocd.argoproj.io/"),
      ),
    ),
    requestedBucketName: c.spec?.bucketName?.trim() || undefined,
    generateBucketName: c.spec?.generateBucketName?.trim() || undefined,
  };
}

function decodeSecretData(
  data?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data) return out;
  for (const [key, value] of Object.entries(data)) {
    if (value == null || value === "") continue;
    try {
      out[key] = Buffer.from(value, "base64").toString("utf8");
    } catch {
      // skip undecodable keys
    }
  }
  return out;
}

function buildEndpoint(
  host?: string,
  port?: string,
): string | undefined {
  const h = host?.trim();
  if (!h) return undefined;
  if (/^https?:\/\//i.test(h)) return h;
  const p = port?.trim();
  // Common Ceph RGW defaults: 80 → http, 443 → https
  if (!p || p === "80") return `http://${h}`;
  if (p === "443") return `https://${h}`;
  return `http://${h}:${p}`;
}

/**
 * Map OBC ConfigMap + Secret into S3 connection material.
 * ConfigMap keys: BUCKET_HOST, BUCKET_PORT, BUCKET_NAME, BUCKET_REGION, …
 * Secret keys: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 */
function mapCredentials(
  claimName: string,
  cmData: Record<string, string>,
  secretData: Record<string, string>,
): ObjectBucketCredentials {
  const bucketHost =
    cmData.BUCKET_HOST?.trim() || cmData.bucketHost?.trim() || undefined;
  const bucketPort =
    cmData.BUCKET_PORT?.trim() || cmData.bucketPort?.trim() || undefined;
  const bucketName =
    cmData.BUCKET_NAME?.trim() || cmData.bucketName?.trim() || undefined;
  return {
    secretName: claimName,
    configMapName: claimName,
    accessKeyId:
      secretData.AWS_ACCESS_KEY_ID?.trim() ||
      secretData.accessKeyId?.trim() ||
      undefined,
    secretAccessKey:
      secretData.AWS_SECRET_ACCESS_KEY ||
      secretData.secretAccessKey ||
      undefined,
    bucketHost,
    bucketPort,
    bucketName,
    bucketRegion:
      cmData.BUCKET_REGION?.trim() || cmData.bucketRegion?.trim() || undefined,
    bucketSubRegion:
      cmData.BUCKET_SUBREGION?.trim() ||
      cmData.bucketSubRegion?.trim() ||
      undefined,
    endpoint: buildEndpoint(bucketHost, bucketPort),
  };
}

async function loadCredentials(
  cluster: ClusterId,
  namespace: string,
  claimName: string,
): Promise<ObjectBucketCredentials> {
  const { core } = getClusterClients(cluster);
  const secretName = claimName;
  const configMapName = claimName;

  try {
    const [cm, secret] = await Promise.all([
      core.readNamespacedConfigMap({ name: configMapName, namespace }).catch(
        (err) => {
          throw Object.assign(err, { _kind: "ConfigMap" as const });
        },
      ),
      core.readNamespacedSecret({ name: secretName, namespace }).catch((err) => {
        throw Object.assign(err, { _kind: "Secret" as const });
      }),
    ]);

    const cmData = (cm.data ?? {}) as Record<string, string>;
    const secretData = decodeSecretData(
      secret.data as Record<string, string> | undefined,
    );
    return mapCredentials(claimName, cmData, secretData);
  } catch (err) {
    const msg = formatError(err);
    if (/not found|404/i.test(msg)) {
      return {
        secretName,
        configMapName,
        error: `ConfigMap/Secret ${namespace}/${claimName} not found yet (claim may still be provisioning)`,
      };
    }
    return {
      secretName,
      configMapName,
      error: msg,
    };
  }
}

/**
 * Prefer ConfigMap/Secret for credentials; fall back to ObjectBucket endpoint
 * for host/name when the CM is not ready.
 */
async function enrichBucketNameFromObjectBucket(
  cluster: ClusterId,
  objectBucketName: string | undefined,
  detail: ObjectBucketDetail,
): Promise<ObjectBucketDetail> {
  if (!objectBucketName?.trim()) return detail;
  try {
    const { custom } = getClusterClients(cluster);
    const ob = (await custom.getClusterCustomObject({
      group: OBC_GROUP,
      version: OBC_VERSION,
      plural: OBC_BUCKET_PLURAL,
      name: objectBucketName,
    })) as KubeObjectBucket;

    const ep = ob.spec?.endpoint;
    const bucketName = ep?.bucketName?.trim() || detail.bucketName;
    return {
      ...detail,
      bucketName,
      // If credentials exist but lack host, leave them; Access tab prefers CM.
    };
  } catch {
    return detail;
  }
}

export async function listObjectBuckets(clusterFilter?: ClusterId): Promise<{
  items: ObjectBucketSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: ObjectBucketSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const { custom } = getClusterClients(id);
        const res = (await custom.listClusterCustomObject({
          group: OBC_GROUP,
          version: OBC_VERSION,
          plural: OBC_CLAIM_PLURAL,
        })) as { items?: KubeObjectBucketClaim[] };
        for (const c of res.items ?? []) {
          items.push(mapSummary(id, c));
        }
      } catch (err) {
        if (cluster) {
          cluster.reachable = false;
          cluster.error = formatError(err);
        }
      }
    }),
  );

  items.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.name.localeCompare(b.name);
  });

  return { items, clusters };
}

export async function getObjectBucket(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<ObjectBucketDetail> {
  const { custom } = getClusterClients(cluster);
  try {
    const obj = (await custom.getNamespacedCustomObject({
      group: OBC_GROUP,
      version: OBC_VERSION,
      namespace,
      plural: OBC_CLAIM_PLURAL,
      name,
    })) as KubeObjectBucketClaim;

    let detail = mapDetail(cluster, obj);
    detail = await enrichBucketNameFromObjectBucket(
      cluster,
      detail.objectBucketName,
      detail,
    );

    const credentials = await loadCredentials(cluster, namespace, name);
    // Prefer resolved bucket name from ConfigMap when Bound
    if (credentials.bucketName) {
      detail = { ...detail, bucketName: credentials.bucketName };
    }

    return {
      ...detail,
      credentials,
    };
  } catch (err) {
    if (err instanceof Response) throw err;
    const msg = formatError(err);
    if (/not found|404/i.test(msg)) {
      throw new Response(
        `Object bucket ${namespace}/${name} not found on ${cluster}`,
        { status: 404 },
      );
    }
    throw err;
  }
}

export async function createObjectBucket(
  input: CreateObjectBucketRequest,
): Promise<ObjectBucketSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.storageClass?.trim()) throw new Error("storageClass is required");

  await assertVmNamespaceAllowed(input.cluster, input.namespace);

  const body = buildObjectBucketClaimManifest({
    ...input,
    name: input.name.trim(),
    namespace: input.namespace.trim(),
    cluster: input.cluster.trim(),
    storageClass: input.storageClass.trim(),
    bucketName: input.bucketName?.trim() || undefined,
  });

  const { custom } = getClusterClients(input.cluster);
  try {
    const created = (await custom.createNamespacedCustomObject({
      group: OBC_GROUP,
      version: OBC_VERSION,
      namespace: input.namespace,
      plural: OBC_CLAIM_PLURAL,
      body,
    })) as KubeObjectBucketClaim;
    return mapSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function deleteObjectBucket(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!namespace?.trim()) throw new Error("namespace is required");
  if (!name?.trim()) throw new Error("name is required");

  const { custom } = getClusterClients(cluster);
  try {
    await custom.deleteNamespacedCustomObject({
      group: OBC_GROUP,
      version: OBC_VERSION,
      namespace,
      plural: OBC_CLAIM_PLURAL,
      name,
    });
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}
