import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateDatabaseRequest,
  DatabaseDetail,
  DatabaseRoleCredentials,
  DatabaseSizePreset,
  DatabaseStatus,
  DatabaseSummary,
} from "~/lib/types";
import {
  CNPG_CLUSTER_PLURAL,
  CNPG_GROUP,
  CNPG_VERSION,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_SIZE,
  KMC_MANAGED_BY,
  KMC_RESOURCE_DATABASE,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { assertVmNamespaceAllowed } from "~/lib/k8s/catalog.server";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { listClusters } from "~/vms/vms.server";
import { isDatabaseSizePreset } from "./options";
import { buildDatabaseClusterManifest } from "./template.server";

interface KubeCnpgCluster {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    instances?: number;
    imageName?: string;
    enableSuperuserAccess?: boolean;
    storage?: {
      size?: string;
      storageClass?: string;
    };
    resources?: {
      requests?: { cpu?: string; memory?: string };
      limits?: { cpu?: string; memory?: string };
    };
    bootstrap?: {
      initdb?: {
        database?: string;
        owner?: string;
      };
    };
  };
  status?: {
    phase?: string;
    instances?: number;
    readyInstances?: number;
    currentPrimary?: string;
    targetPrimary?: string;
    writeService?: string;
    readService?: string;
    image?: string;
    instanceNames?: string[];
    instancesStatus?: {
      healthy?: string[];
    };
    pgDataImageInfo?: {
      image?: string;
      majorVersion?: number;
    };
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
  };
}

function isManagedByKmc(labels?: Record<string, string>): boolean {
  if (!labels) return false;
  return (
    labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY &&
    labels[KMC_LABEL_RESOURCE] === KMC_RESOURCE_DATABASE
  );
}

/** Pull a version-ish tag from a container image reference. */
function versionFromImage(image?: string): string | undefined {
  if (!image?.trim()) return undefined;
  const ref = image.trim();
  // digest-only or no tag
  const at = ref.lastIndexOf("@");
  const withoutDigest = at >= 0 ? ref.slice(0, at) : ref;
  const slash = withoutDigest.lastIndexOf("/");
  const name = slash >= 0 ? withoutDigest.slice(slash + 1) : withoutDigest;
  const colon = name.lastIndexOf(":");
  if (colon < 0) return undefined;
  const tag = name.slice(colon + 1).trim();
  return tag || undefined;
}

function deriveStatus(c: KubeCnpgCluster): DatabaseStatus {
  const ready = c.status?.conditions?.find((cond) => cond.type === "Ready");
  if (ready?.status === "True") return "Ready";
  if (ready?.status === "False") {
    const reason = (ready.reason ?? "").toLowerCase();
    if (reason.includes("fail") || reason.includes("error")) return "Failed";
    return "NotReady";
  }

  const phase = c.status?.phase ?? "";
  if (/healthy/i.test(phase)) return "Ready";
  if (/fail|error|unrecoverable/i.test(phase)) return "Failed";
  if (
    /setting up|creating|waiting|initializ|bootstrapping|upgrading|switchover|fencing/i.test(
      phase,
    )
  ) {
    return "Provisioning";
  }
  if (!phase) return "Unknown";
  return phase;
}

function mapSummary(cluster: ClusterId, c: KubeCnpgCluster): DatabaseSummary {
  const imageName = c.status?.image ?? c.spec?.imageName;
  const postgresVersion =
    versionFromImage(imageName) ??
    (c.status?.pgDataImageInfo?.majorVersion != null
      ? String(c.status.pgDataImageInfo.majorVersion)
      : undefined);

  const instances = c.status?.instances ?? c.spec?.instances ?? 0;
  const readyInstances = c.status?.readyInstances ?? 0;

  return {
    cluster,
    namespace: c.metadata?.namespace ?? "default",
    name: c.metadata?.name ?? "unknown",
    status: deriveStatus(c),
    phase: c.status?.phase ?? "Unknown",
    instances,
    readyInstances,
    postgresVersion,
    imageName,
    storageSize: c.spec?.storage?.size,
    storageClass: c.spec?.storage?.storageClass,
    currentPrimary: c.status?.currentPrimary,
    age: c.metadata?.creationTimestamp ?? "",
    managedByKmc: isManagedByKmc(c.metadata?.labels),
  };
}

function sizePresetFromLabels(
  labels?: Record<string, string>,
): DatabaseSizePreset | undefined {
  const raw = labels?.[KMC_LABEL_SIZE]?.trim();
  if (raw && isDatabaseSizePreset(raw)) return raw;
  return undefined;
}

function mapDetail(cluster: ClusterId, c: KubeCnpgCluster): DatabaseDetail {
  const summary = mapSummary(cluster, c);
  const name = summary.name;
  const writeService = c.status?.writeService ?? `${name}-rw`;
  const readService = c.status?.readService ?? `${name}-r`;
  const instances = summary.instances;

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
    conditions: (c.status?.conditions ?? []).map((cond) => ({
      type: cond.type ?? "Unknown",
      status: cond.status ?? "Unknown",
      reason: cond.reason,
      message: cond.message,
      lastTransitionTime: cond.lastTransitionTime,
    })),
    writeService,
    readService,
    readOnlyService: instances > 1 ? `${name}-ro` : undefined,
    targetPrimary: c.status?.targetPrimary,
    enableSuperuserAccess: c.spec?.enableSuperuserAccess,
    databaseName: c.spec?.bootstrap?.initdb?.database,
    owner: c.spec?.bootstrap?.initdb?.owner,
    cpuRequest: c.spec?.resources?.requests?.cpu,
    memoryRequest: c.spec?.resources?.requests?.memory,
    cpuLimit: c.spec?.resources?.limits?.cpu,
    memoryLimit: c.spec?.resources?.limits?.memory,
    instanceNames: c.status?.instanceNames,
    healthyInstances: c.status?.instancesStatus?.healthy,
    sizePreset: sizePresetFromLabels(c.metadata?.labels),
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

function hostFqdn(host: string | undefined, namespace: string): string | undefined {
  const h = host?.trim();
  if (!h) return undefined;
  if (h.includes(".")) return h;
  return `${h}.${namespace}.svc`;
}

/**
 * Map a CNPG connection Secret (type kubernetes.io/basic-auth) into credentials.
 * Keys: user/username, password, host, port, dbname, uri, fqdn-uri.
 */
function mapCredentialsFromSecret(
  role: "app" | "superuser",
  secretName: string,
  namespace: string,
  data: Record<string, string>,
): DatabaseRoleCredentials {
  const host = data.host?.trim() || undefined;
  const username =
    data.username?.trim() || data.user?.trim() || undefined;
  return {
    role,
    secretName,
    host,
    hostFqdn: hostFqdn(host, namespace),
    port: data.port?.trim() || "5432",
    database: data.dbname?.trim() || undefined,
    username,
    password: data.password || undefined,
    uri: data.uri?.trim() || undefined,
    fqdnUri: data["fqdn-uri"]?.trim() || undefined,
  };
}

async function readRoleCredentials(
  cluster: ClusterId,
  namespace: string,
  secretName: string,
  role: "app" | "superuser",
): Promise<DatabaseRoleCredentials> {
  const { core } = getClusterClients(cluster);
  try {
    const secret = await core.readNamespacedSecret({
      name: secretName,
      namespace,
    });
    const data = decodeSecretData(
      secret.data as Record<string, string> | undefined,
    );
    return mapCredentialsFromSecret(role, secretName, namespace, data);
  } catch (err) {
    const msg = formatError(err);
    if (/not found|404/i.test(msg)) {
      return {
        role,
        secretName,
        error: `Secret ${namespace}/${secretName} not found yet`,
      };
    }
    return {
      role,
      secretName,
      error: msg,
    };
  }
}

/**
 * Load app (+ optional superuser) connection secrets for a Cluster.
 * Failures are soft — detail still renders without credentials.
 */
async function loadDatabaseCredentials(
  cluster: ClusterId,
  namespace: string,
  name: string,
  enableSuperuserAccess: boolean | undefined,
): Promise<{
  appCredentials: DatabaseRoleCredentials;
  superuserCredentials?: DatabaseRoleCredentials;
}> {
  const appName = `${name}-app`;
  const superuserName = `${name}-superuser`;

  if (enableSuperuserAccess) {
    const [appCredentials, superuserCredentials] = await Promise.all([
      readRoleCredentials(cluster, namespace, appName, "app"),
      readRoleCredentials(cluster, namespace, superuserName, "superuser"),
    ]);
    return { appCredentials, superuserCredentials };
  }

  const appCredentials = await readRoleCredentials(
    cluster,
    namespace,
    appName,
    "app",
  );
  return { appCredentials };
}

export async function listDatabases(clusterFilter?: ClusterId): Promise<{
  items: DatabaseSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: DatabaseSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const { custom } = getClusterClients(id);
        const res = (await custom.listClusterCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          plural: CNPG_CLUSTER_PLURAL,
        })) as { items?: KubeCnpgCluster[] };
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

export async function getDatabase(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<DatabaseDetail> {
  const { custom } = getClusterClients(cluster);
  try {
    const obj = (await custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace,
      plural: CNPG_CLUSTER_PLURAL,
      name,
    })) as KubeCnpgCluster;
    const detail = mapDetail(cluster, obj);
    const creds = await loadDatabaseCredentials(
      cluster,
      namespace,
      name,
      detail.enableSuperuserAccess,
    );
    return {
      ...detail,
      appCredentials: creds.appCredentials,
      superuserCredentials: creds.superuserCredentials,
    };
  } catch (err) {
    if (err instanceof Response) throw err;
    const msg = formatError(err);
    if (/not found|404/i.test(msg)) {
      throw new Response(`Database ${namespace}/${name} not found on ${cluster}`, {
        status: 404,
      });
    }
    throw err;
  }
}

export async function createDatabase(
  input: CreateDatabaseRequest,
): Promise<DatabaseSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!isDatabaseSizePreset(input.size)) {
    throw new Error(`size must be small, medium, or large (got "${input.size}")`);
  }
  if (!input.postgresVersion?.trim()) {
    throw new Error("postgresVersion is required");
  }

  const instances = Number(input.instances);
  if (instances !== 1 && instances !== 3) {
    throw new Error("instances must be 1 or 3");
  }

  await assertVmNamespaceAllowed(input.cluster, input.namespace);

  const body = buildDatabaseClusterManifest({
    ...input,
    instances,
    name: input.name.trim(),
    namespace: input.namespace.trim(),
    cluster: input.cluster.trim(),
    postgresVersion: input.postgresVersion.trim(),
    storageClass: input.storageClass?.trim() || undefined,
    storageSize: input.storageSize?.trim() || undefined,
  });

  const { custom } = getClusterClients(input.cluster);
  try {
    const created = (await custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: input.namespace,
      plural: CNPG_CLUSTER_PLURAL,
      body,
    })) as KubeCnpgCluster;
    return mapSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function deleteDatabase(
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
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace,
      plural: CNPG_CLUSTER_PLURAL,
      name,
    });
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * Resolve primary pod + app credentials for an in-pod `psql` session.
 * Used by the browser terminal WebSocket proxy.
 */
export async function resolvePsqlSessionTarget(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<{
  podName: string;
  username: string;
  password: string;
  database: string;
}> {
  if (!cluster?.trim() || !namespace?.trim() || !name?.trim()) {
    throw new Error("cluster, namespace, and name are required");
  }

  const { custom } = getClusterClients(cluster);
  let obj: KubeCnpgCluster;
  try {
    obj = (await custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace,
      plural: CNPG_CLUSTER_PLURAL,
      name,
    })) as KubeCnpgCluster;
  } catch (err) {
    const msg = formatError(err);
    if (/not found|404/i.test(msg)) {
      throw new Error(`Database ${namespace}/${name} not found on ${cluster}`);
    }
    throw new Error(msg, { cause: err });
  }

  const podName =
    obj.status?.currentPrimary?.trim() ||
    obj.status?.targetPrimary?.trim() ||
    obj.status?.instanceNames?.find((n) => n?.trim())?.trim() ||
    obj.status?.instancesStatus?.healthy?.[0]?.trim();

  if (!podName) {
    throw new Error(
      `No primary instance for ${namespace}/${name} — wait until the cluster is Ready`,
    );
  }

  const appCreds = await readRoleCredentials(
    cluster,
    namespace,
    `${name}-app`,
    "app",
  );
  if (appCreds.error) {
    throw new Error(appCreds.error);
  }

  const username = appCreds.username?.trim();
  const password = appCreds.password;
  const database =
    appCreds.database?.trim() ||
    obj.spec?.bootstrap?.initdb?.database?.trim() ||
    "app";

  if (!username) {
    throw new Error(
      `App secret ${namespace}/${name}-app is missing username`,
    );
  }
  if (password == null || password === "") {
    throw new Error(
      `App secret ${namespace}/${name}-app is missing password`,
    );
  }

  return { podName, username, password, database };
}
