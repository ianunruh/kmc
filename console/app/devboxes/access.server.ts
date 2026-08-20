import { formatError } from "~/lib/errors";
import type { ClusterId } from "~/lib/types";
import { createLoadBalancer, deleteLoadBalancer } from "~/backends/backends.server";
import { createHttpRoute, deleteHttpRoute } from "~/httproutes/httproutes.server";
import {
  getClusterDevboxConfig,
  type ClusterDevboxConfig,
} from "~/lib/k8s/cluster-config.server";
import { getClusterClients } from "~/lib/k8s/clients.server";
import {
  ENVOY_GATEWAY_GROUP,
  ENVOY_GATEWAY_VERSION,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VM,
  KMC_MANAGED_BY,
  KMC_RESOURCE_DEVBOX_IDE,
  KMC_RESOURCE_DEVBOX_SSH,
  MANAGED_BY_LABEL,
  METALLB_ADDRESS_POOL_ANNOTATION,
  SECURITY_POLICY_PLURAL,
} from "~/lib/k8s/constants";
import { singleVmMembership } from "~/backends/membership";
import { deleteDevBoxOidcClient, ensureDevBoxOidcClient } from "./dex-oidc.server";

export function sshServiceName(vmName: string): string {
  return `${vmName}-ssh`.slice(0, 63);
}

export function ideRouteName(vmName: string): string {
  return `${vmName}-ide`.slice(0, 63);
}

export function ideHostFor(
  cfg: NonNullable<ClusterDevboxConfig["envoy"]>,
  vmName: string,
  namespace: string,
): string {
  return cfg.hostTemplate
    .replaceAll("%name%", vmName)
    .replaceAll("%namespace%", namespace);
}

export type DevBoxAccessInfo = {
  accessIpv4?: string;
  sshService?: string;
  ideHost?: string;
  ideRoute?: string;
  envoyConfigured: boolean;
  metallbConfigured: boolean;
  warning?: string;
};

function isNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return Number((err as { code: unknown }).code) === 404;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("404") || msg.toLowerCase().includes("not found");
}

export async function loadDevBoxAccess(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<DevBoxAccessInfo> {
  const cfg = getClusterDevboxConfig(cluster);
  const { core } = getClusterClients(cluster);
  const sshName = sshServiceName(vmName);
  let accessIpv4: string | undefined;
  let sshService: string | undefined;
  try {
    const svc = await core.readNamespacedService({ name: sshName, namespace });
    sshService = sshName;
    const ingress = svc.status?.loadBalancer?.ingress ?? [];
    accessIpv4 =
      ingress.map((i) => i.ip?.trim() || i.hostname?.trim()).find(Boolean) || undefined;
  } catch (err) {
    if (!isNotFound(err)) {
      console.error("loadDevBoxAccess ssh service:", formatError(err));
    }
  }

  const envoy = cfg?.envoy;
  return {
    accessIpv4,
    sshService,
    ideHost: envoy ? ideHostFor(envoy, vmName, namespace) : undefined,
    ideRoute: envoy ? ideRouteName(vmName) : undefined,
    envoyConfigured: Boolean(envoy),
    metallbConfigured: Boolean(cfg?.metallb?.addressPool),
    warning: !cfg?.metallb?.addressPool
      ? "No devbox.metallb.addressPool in clusters.yaml — SSH VIP was not annotated for an internal pool."
      : undefined,
  };
}

export async function ensureDevBoxSshLoadBalancer(input: {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
}): Promise<void> {
  const cfg = getClusterDevboxConfig(input.cluster);
  const extraAnnotations: Record<string, string> = {};
  const pool = cfg?.metallb?.addressPool?.trim();
  if (pool) {
    extraAnnotations[
      cfg?.metallb?.annotationKey?.trim() || METALLB_ADDRESS_POOL_ANNOTATION
    ] = pool;
  }

  try {
    await createLoadBalancer({
      cluster: input.cluster,
      namespace: input.namespace,
      name: sshServiceName(input.vmName),
      membership: singleVmMembership(input.vmName),
      ports: [{ name: "ssh", port: 22, targetPort: 22, protocol: "TCP" }],
      extraLabels: {
        [KMC_LABEL_RESOURCE]: KMC_RESOURCE_DEVBOX_SSH,
        [KMC_LABEL_VM]: input.vmName,
      },
      extraAnnotations,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) return;
    throw err;
  }
}

export async function ensureDevBoxIdeRoute(input: {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
}): Promise<{ host: string } | { skipped: string }> {
  const cfg = getClusterDevboxConfig(input.cluster)?.envoy;
  if (!cfg) {
    return {
      skipped:
        "devbox.envoy is not configured for this cluster — created the box without an IDE URL.",
    };
  }

  const host = ideHostFor(cfg, input.vmName, input.namespace);
  const routeName = ideRouteName(input.vmName);

  const oidcClient = await ensureDevBoxOidcClient({
    cluster: input.cluster,
    namespace: input.namespace,
    vmName: input.vmName,
    host,
    dexNamespace: cfg.oidc.clientNamespace,
  });

  try {
    await createHttpRoute({
      cluster: input.cluster,
      namespace: input.namespace,
      name: routeName,
      host,
      path: "/",
      pathType: "PathPrefix",
      servicePort: 8080,
      targetPort: 8080,
      gatewayName: cfg.gatewayName,
      gatewayNamespace: cfg.gatewayNamespace,
      sectionName: cfg.sectionName,
      membership: singleVmMembership(input.vmName),
      extraLabels: {
        [KMC_LABEL_RESOURCE]: KMC_RESOURCE_DEVBOX_IDE,
        [KMC_LABEL_VM]: input.vmName,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) throw err;
  }

  const { custom } = getClusterClients(input.cluster);
  const policy = {
    apiVersion: `${ENVOY_GATEWAY_GROUP}/${ENVOY_GATEWAY_VERSION}`,
    kind: "SecurityPolicy",
    metadata: {
      name: routeName,
      namespace: input.namespace,
      labels: {
        [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
        [KMC_LABEL_RESOURCE]: KMC_RESOURCE_DEVBOX_IDE,
        [KMC_LABEL_VM]: input.vmName,
      },
    },
    spec: {
      targetRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "HTTPRoute",
          name: routeName,
        },
      ],
      oidc: {
        provider: { issuer: cfg.oidc.issuer },
        clientID: oidcClient.clientID,
        clientSecret: { name: oidcClient.secretName },
        redirectURL: `https://${host}/oauth2/callback`,
        logoutPath: "/logout",
        passThroughAuthHeader: true,
        refreshToken: true,
        cookieNames: {
          accessToken: "AccessToken",
          idToken: "IdToken",
        },
        ...(cfg.oidc.cookieDomain ? { cookieDomain: cfg.oidc.cookieDomain } : {}),
        ...(cfg.oidc.scopes?.length ? { scopes: cfg.oidc.scopes } : {}),
      },
      jwt: {
        optional: true,
        providers: [
          {
            name: "dex",
            issuer: cfg.oidc.issuer,
            extractFrom: {
              cookies: ["IdToken"],
              headers: [{ name: "Authorization", valuePrefix: "Bearer " }],
            },
            remoteJWKS: {
              uri: `${cfg.oidc.issuer.replace(/\/+$/, "")}/keys`,
            },
          },
        ],
      },
      authorization: {
        defaultAction: "Deny",
        rules: [
          {
            name: "allow-humans",
            action: "Allow",
            principal: {
              jwt: {
                provider: "dex",
                claims: [
                  {
                    name: "iss",
                    valueType: "String",
                    values: [cfg.oidc.issuer],
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };

  try {
    await custom.createNamespacedCustomObject({
      group: ENVOY_GATEWAY_GROUP,
      version: ENVOY_GATEWAY_VERSION,
      namespace: input.namespace,
      plural: SECURITY_POLICY_PLURAL,
      body: policy,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) {
      if (!isNotFound(err)) {
        throw new Error(`Failed to create SecurityPolicy: ${formatError(err)}`, {
          cause: err,
        });
      }
    } else {
      try {
        const current = (await custom.getNamespacedCustomObject({
          group: ENVOY_GATEWAY_GROUP,
          version: ENVOY_GATEWAY_VERSION,
          namespace: input.namespace,
          plural: SECURITY_POLICY_PLURAL,
          name: routeName,
        })) as { metadata?: { resourceVersion?: string } };
        await custom.replaceNamespacedCustomObject({
          group: ENVOY_GATEWAY_GROUP,
          version: ENVOY_GATEWAY_VERSION,
          namespace: input.namespace,
          plural: SECURITY_POLICY_PLURAL,
          name: routeName,
          body: {
            ...policy,
            metadata: {
              ...policy.metadata,
              resourceVersion: current.metadata?.resourceVersion,
            },
          },
        });
      } catch (replaceErr) {
        throw new Error(`Failed to update SecurityPolicy: ${formatError(replaceErr)}`, {
          cause: replaceErr,
        });
      }
    }
  }

  return { host };
}

export async function deleteDevBoxCompanions(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<void> {
  const sshName = sshServiceName(vmName);
  const ideName = ideRouteName(vmName);
  const { custom } = getClusterClients(cluster);

  try {
    await deleteLoadBalancer(cluster, namespace, sshName);
  } catch (err) {
    console.error("deleteDevBoxCompanions ssh LB:", formatError(err));
  }

  try {
    await deleteHttpRoute(cluster, namespace, ideName);
  } catch (err) {
    console.error("deleteDevBoxCompanions HTTPRoute:", formatError(err));
  }

  try {
    const { core } = getClusterClients(cluster);
    await core.deleteNamespacedService({ name: ideName, namespace });
  } catch (err) {
    if (!isNotFound(err)) {
      console.error("deleteDevBoxCompanions IDE Service:", formatError(err));
    }
  }

  try {
    await custom.deleteNamespacedCustomObject({
      group: ENVOY_GATEWAY_GROUP,
      version: ENVOY_GATEWAY_VERSION,
      namespace,
      plural: SECURITY_POLICY_PLURAL,
      name: ideName,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      console.error("deleteDevBoxCompanions SecurityPolicy:", formatError(err));
    }
  }

  const envoy = getClusterDevboxConfig(cluster)?.envoy;
  if (envoy) {
    await deleteDevBoxOidcClient({
      cluster,
      namespace,
      vmName,
      dexNamespace: envoy.oidc.clientNamespace,
    });
  }
}
