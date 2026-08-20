import { randomBytes } from "node:crypto";
import { formatError } from "~/lib/errors";
import type { ClusterId } from "~/lib/types";
import { getClusterClients } from "~/lib/k8s/clients.server";
import {
  DEX_API_GROUP,
  DEX_API_VERSION,
  DEX_DEFAULT_NAMESPACE,
  DEX_OAUTH2CLIENT_KIND,
  DEX_OAUTH2CLIENT_PLURAL,
  ENVOY_OIDC_CLIENT_SECRET_KEY,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_TENANT_NS,
  KMC_LABEL_VM,
  KMC_MANAGED_BY,
  KMC_RESOURCE_DEVBOX_IDE,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";

/**
 * Dex kubernetes storage names an OAuth2Client
 * `base32(idBytes || fnv64(empty))` (Go `hash.Hash.Sum` appends the digest).
 * GetClient looks up that name, so we must match it.
 */
const FNV64_EMPTY = Buffer.from("cbf29ce484222325", "hex");
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function dexIdToName(id: string): string {
  const payload = Buffer.concat([Buffer.from(id, "utf8"), FNV64_EMPTY]);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of payload) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function dexDevBoxClientId(namespace: string, vmName: string): string {
  return `kmc-devbox.${namespace}.${vmName}`;
}

export function ideOidcSecretName(vmName: string): string {
  return `${vmName}-ide-oidc`.slice(0, 63);
}

export function ideRedirectUrl(host: string): string {
  return `https://${host}/oauth2/callback`;
}

type DexOAuth2Client = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    resourceVersion?: string;
  };
  id?: string;
  secret?: string;
  redirectURIs?: string[];
  public?: boolean;
  name?: string;
};

function isNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return Number((err as { code: unknown }).code) === 404;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("404") || msg.toLowerCase().includes("not found");
}

function isAlreadyExists(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return Number((err as { code: unknown }).code) === 409;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("already exists") || msg.includes("409");
}

function ideLabels(namespace: string, vmName: string): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_DEVBOX_IDE,
    [KMC_LABEL_VM]: vmName,
    [KMC_LABEL_TENANT_NS]: namespace,
  };
}

function newClientSecret(): string {
  return randomBytes(24).toString("base64url");
}

export async function ensureDevBoxOidcClient(input: {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  host: string;
  dexNamespace?: string;
}): Promise<{ clientID: string; secretName: string }> {
  const dexNs = input.dexNamespace?.trim() || DEX_DEFAULT_NAMESPACE;
  const clientID = dexDevBoxClientId(input.namespace, input.vmName);
  const crName = dexIdToName(clientID);
  const redirectURI = ideRedirectUrl(input.host);
  const secretName = ideOidcSecretName(input.vmName);
  const labels = ideLabels(input.namespace, input.vmName);
  const { custom, core } = getClusterClients(input.cluster);

  let existing: DexOAuth2Client | undefined;
  try {
    existing = (await custom.getNamespacedCustomObject({
      group: DEX_API_GROUP,
      version: DEX_API_VERSION,
      namespace: dexNs,
      plural: DEX_OAUTH2CLIENT_PLURAL,
      name: crName,
    })) as DexOAuth2Client;
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(
        `Could not read Dex OAuth2Client ${dexNs}/${crName}: ${formatError(err)}. ` +
          `Grant get/create/delete on oauth2clients.dex.coreos.com in namespace ${dexNs}.`,
        { cause: err },
      );
    }
  }

  const secret = existing?.secret?.trim() || newClientSecret();
  const body: DexOAuth2Client = {
    apiVersion: `${DEX_API_GROUP}/${DEX_API_VERSION}`,
    kind: DEX_OAUTH2CLIENT_KIND,
    metadata: {
      name: crName,
      namespace: dexNs,
      labels,
      ...(existing?.metadata?.resourceVersion
        ? { resourceVersion: existing.metadata.resourceVersion }
        : {}),
    },
    id: clientID,
    secret,
    redirectURIs: [redirectURI],
    public: false,
    name: `${input.namespace}/${input.vmName} IDE`,
  };

  const urisMatch =
    existing?.redirectURIs?.length === 1 && existing.redirectURIs[0] === redirectURI;
  const idMatch = existing?.id === clientID && existing.secret === secret;
  if (!existing) {
    try {
      await custom.createNamespacedCustomObject({
        group: DEX_API_GROUP,
        version: DEX_API_VERSION,
        namespace: dexNs,
        plural: DEX_OAUTH2CLIENT_PLURAL,
        body,
      });
    } catch (err) {
      if (!isAlreadyExists(err)) {
        throw new Error(
          `Failed to create Dex OAuth2Client in ${dexNs}: ${formatError(err)}. ` +
            `Grant create on oauth2clients.dex.coreos.com in namespace ${dexNs}.`,
          { cause: err },
        );
      }
    }
  } else if (!urisMatch || !idMatch) {
    try {
      await custom.replaceNamespacedCustomObject({
        group: DEX_API_GROUP,
        version: DEX_API_VERSION,
        namespace: dexNs,
        plural: DEX_OAUTH2CLIENT_PLURAL,
        name: crName,
        body,
      });
    } catch (err) {
      throw new Error(
        `Failed to update Dex OAuth2Client ${dexNs}/${crName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  const secretBody = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace: input.namespace,
      labels,
    },
    type: "Opaque",
    stringData: { [ENVOY_OIDC_CLIENT_SECRET_KEY]: secret },
  };

  try {
    const current = await core.readNamespacedSecret({
      name: secretName,
      namespace: input.namespace,
    });
    const existingB64 = current.data?.[ENVOY_OIDC_CLIENT_SECRET_KEY];
    const wantB64 = Buffer.from(secret, "utf8").toString("base64");
    if (existingB64 !== wantB64) {
      await core.replaceNamespacedSecret({
        name: secretName,
        namespace: input.namespace,
        body: {
          ...secretBody,
          metadata: {
            ...secretBody.metadata,
            resourceVersion: current.metadata?.resourceVersion,
          },
        },
      });
    }
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(
        `Could not write OIDC client secret ${input.namespace}/${secretName}: ${formatError(err)}`,
        { cause: err },
      );
    }
    try {
      await core.createNamespacedSecret({
        namespace: input.namespace,
        body: secretBody,
      });
    } catch (createErr) {
      if (!isAlreadyExists(createErr)) {
        throw new Error(
          `Failed to create OIDC client secret ${input.namespace}/${secretName}: ${formatError(createErr)}`,
          { cause: createErr },
        );
      }
    }
  }

  return { clientID, secretName };
}

export async function deleteDevBoxOidcClient(input: {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  dexNamespace?: string;
}): Promise<void> {
  const dexNs = input.dexNamespace?.trim() || DEX_DEFAULT_NAMESPACE;
  const clientID = dexDevBoxClientId(input.namespace, input.vmName);
  const crName = dexIdToName(clientID);
  const secretName = ideOidcSecretName(input.vmName);
  const { custom, core } = getClusterClients(input.cluster);

  try {
    await custom.deleteNamespacedCustomObject({
      group: DEX_API_GROUP,
      version: DEX_API_VERSION,
      namespace: dexNs,
      plural: DEX_OAUTH2CLIENT_PLURAL,
      name: crName,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      console.error("deleteDevBoxOidcClient OAuth2Client:", formatError(err));
    }
  }

  for (const name of [secretName, "gateway-sso-oidc"]) {
    try {
      const secret = await core.readNamespacedSecret({
        name,
        namespace: input.namespace,
      });
      const labels = secret.metadata?.labels ?? {};
      const ours =
        labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY &&
        labels[KMC_LABEL_RESOURCE] === KMC_RESOURCE_DEVBOX_IDE;
      if (name === secretName || ours) {
        await core.deleteNamespacedSecret({ name, namespace: input.namespace });
      }
    } catch (err) {
      if (!isNotFound(err)) {
        console.error(`deleteDevBoxOidcClient secret ${name}:`, formatError(err));
      }
    }
  }
}
