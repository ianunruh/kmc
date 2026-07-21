import { createHash, randomBytes } from "node:crypto";
import { ApiException, type V1ConfigMap } from "@kubernetes/client-node";
import type { SessionUser } from "~/lib/auth/types";
import {
  getSettingsClusterClients,
  getSettingsClusterId,
} from "~/lib/k8s/clients.server";

export type SshKey = {
  id: string;
  name: string;
  publicKey: string;
  createdAt: string;
};

export type SshKeyView = SshKey & {
  fingerprint: string;
};

const SETTINGS_NAMESPACE = "kmc-system";
const KEYS_DATA_FIELD = "keys.json";
const MAX_KEYS = 20;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_NAME_LEN = 64;
const CONFLICT_RETRIES = 3;

const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
const LABEL_RESOURCE = "kmc.ianunruh.com/resource";
const LABEL_OWNER = "kmc.ianunruh.com/owner";
const ANN_OWNER_EMAIL = "kmc.ianunruh.com/owner-email";

const KEY_TYPE_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/;

export function getSshKeysSettingsCluster(): string {
  return getSettingsClusterId();
}

/** DNS-1123 slug for ConfigMap name suffix. */
export function ownerSlug(githubLogin: string): string {
  const lower = githubLogin.trim().toLowerCase();
  let slug = lower
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 40) {
    const h = createHash("sha256").update(githubLogin).digest("hex").slice(0, 16);
    slug = `u-${h}`;
  }
  return slug;
}

export function configMapNameForOwner(githubLogin: string): string {
  return `kmc-ssh-keys-${ownerSlug(githubLogin)}`;
}

/**
 * OpenSSH-style SHA256 fingerprint of the key material (base64 body).
 */
export function fingerprintPublicKey(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2) return "—";
  try {
    const raw = Buffer.from(parts[1]!, "base64");
    if (raw.length === 0) return "—";
    const hash = createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
    return `SHA256:${hash}`;
  } catch {
    return "—";
  }
}

export function validatePublicKey(raw: string): string | null {
  const key = raw.trim().replace(/\r\n/g, "\n");
  if (!key) return "SSH public key is required";
  if (key.includes("\n")) return "SSH public key must be a single line";
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    return `SSH public key must be ≤ ${MAX_KEY_BYTES} bytes`;
  }
  if (key.startsWith("-----BEGIN")) {
    return "Paste an OpenSSH public key (ssh-ed25519 / ssh-rsa …), not a private key block";
  }
  if (!KEY_TYPE_RE.test(key)) {
    return "Unrecognized SSH public key format (expected ssh-ed25519 AAAA… or similar)";
  }
  return null;
}

export function validateKeyName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Name is required";
  if (name.length > MAX_NAME_LEN) return `Name must be ≤ ${MAX_NAME_LEN} characters`;
  return null;
}

function newKeyId(): string {
  return `sk_${randomBytes(8).toString("hex")}`;
}

function parseKeys(cm: V1ConfigMap | null): SshKey[] {
  if (!cm?.data?.[KEYS_DATA_FIELD]) return [];
  try {
    const parsed = JSON.parse(cm.data[KEYS_DATA_FIELD]) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SshKey[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      const name = typeof rec.name === "string" ? rec.name : "";
      const publicKey = typeof rec.publicKey === "string" ? rec.publicKey : "";
      const createdAt = typeof rec.createdAt === "string" ? rec.createdAt : "";
      if (!id || !name || !publicKey) continue;
      out.push({ id, name, publicKey, createdAt: createdAt || new Date(0).toISOString() });
    }
    return out;
  } catch {
    return [];
  }
}

function toViews(keys: SshKey[]): SshKeyView[] {
  return keys.map((k) => ({
    ...k,
    fingerprint: fingerprintPublicKey(k.publicKey),
  }));
}

function isApiCode(err: unknown, code: number): boolean {
  if (err instanceof ApiException) return err.code === code;
  if (err && typeof err === "object" && "code" in err) {
    return Number((err as { code: unknown }).code) === code;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 404) {
    return msg.includes("404") || msg.toLowerCase().includes("not found");
  }
  if (code === 409) {
    return msg.includes("409") || msg.toLowerCase().includes("conflict");
  }
  return msg.includes(String(code));
}

async function readConfigMap(
  name: string,
): Promise<V1ConfigMap | null> {
  const { core } = getSettingsClusterClients();
  try {
    return await core.readNamespacedConfigMap({
      name,
      namespace: SETTINGS_NAMESPACE,
    });
  } catch (err) {
    if (isApiCode(err, 404)) return null;
    throw err;
  }
}

function buildConfigMap(
  owner: SessionUser,
  keys: SshKey[],
  existing?: V1ConfigMap | null,
): V1ConfigMap {
  const name = configMapNameForOwner(owner.githubLogin);
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace: SETTINGS_NAMESPACE,
      labels: {
        [LABEL_MANAGED_BY]: "kmc",
        [LABEL_RESOURCE]: "user-ssh-keys",
        [LABEL_OWNER]: ownerSlug(owner.githubLogin),
      },
      annotations: {
        [ANN_OWNER_EMAIL]: owner.email,
      },
      ...(existing?.metadata?.resourceVersion
        ? { resourceVersion: existing.metadata.resourceVersion }
        : {}),
    },
    data: {
      [KEYS_DATA_FIELD]: JSON.stringify(keys),
    },
  };
}

async function writeKeys(
  owner: SessionUser,
  mutator: (current: SshKey[]) => SshKey[],
): Promise<SshKey[]> {
  const name = configMapNameForOwner(owner.githubLogin);
  const { core } = getSettingsClusterClients();

  for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
    const existing = await readConfigMap(name);
    const current = parseKeys(existing);
    const next = mutator(current);
    const body = buildConfigMap(owner, next, existing);

    try {
      if (!existing) {
        await core.createNamespacedConfigMap({
          namespace: SETTINGS_NAMESPACE,
          body,
        });
      } else {
        await core.replaceNamespacedConfigMap({
          name,
          namespace: SETTINGS_NAMESPACE,
          body,
        });
      }
      return next;
    } catch (err) {
      if (isApiCode(err, 409) && attempt < CONFLICT_RETRIES - 1) {
        continue;
      }
      // Create raced with another create → retry as replace
      if (!existing && isApiCode(err, 409) && attempt < CONFLICT_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Failed to update SSH keys after concurrent modification retries");
}

export async function listSshKeys(owner: SessionUser): Promise<SshKeyView[]> {
  const cm = await readConfigMap(configMapNameForOwner(owner.githubLogin));
  return toViews(parseKeys(cm));
}

/**
 * Soft list for VM create: returns empty on missing session store errors
 * only when caller wraps; this throws so callers can decide.
 */
export async function listSshKeysOrEmpty(
  owner: SessionUser | null | undefined,
): Promise<{ keys: SshKeyView[]; settingsCluster: string; error?: string }> {
  const settingsCluster = getSettingsClusterId();
  if (!owner) {
    return { keys: [], settingsCluster };
  }
  try {
    const keys = await listSshKeys(owner);
    return { keys, settingsCluster };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[kmc:ssh-keys] list failed", message);
    return { keys: [], settingsCluster, error: message };
  }
}

export async function addSshKey(
  owner: SessionUser,
  input: { name: string; publicKey: string },
): Promise<SshKeyView> {
  const nameErr = validateKeyName(input.name);
  if (nameErr) throw new Error(nameErr);
  const keyErr = validatePublicKey(input.publicKey);
  if (keyErr) throw new Error(keyErr);

  const name = input.name.trim();
  const publicKey = input.publicKey.trim();
  const created: SshKey = {
    id: newKeyId(),
    name,
    publicKey,
    createdAt: new Date().toISOString(),
  };

  await writeKeys(owner, (current) => {
    if (current.length >= MAX_KEYS) {
      throw new Error(`At most ${MAX_KEYS} SSH keys can be saved`);
    }
    if (current.some((k) => k.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A key named "${name}" already exists`);
    }
    if (current.some((k) => k.publicKey === publicKey)) {
      throw new Error("This public key is already saved");
    }
    return [...current, created];
  });

  return { ...created, fingerprint: fingerprintPublicKey(created.publicKey) };
}

export async function deleteSshKey(
  owner: SessionUser,
  id: string,
): Promise<void> {
  if (!id.trim()) throw new Error("Key id is required");

  const name = configMapNameForOwner(owner.githubLogin);
  const { core } = getSettingsClusterClients();

  let deletedAll = false;
  await writeKeys(owner, (current) => {
    const next = current.filter((k) => k.id !== id);
    if (next.length === current.length) {
      throw new Error("SSH key not found");
    }
    deletedAll = next.length === 0;
    return next;
  });

  // Drop empty ConfigMap to avoid clutter
  if (deletedAll) {
    try {
      await core.deleteNamespacedConfigMap({
        name,
        namespace: SETTINGS_NAMESPACE,
      });
    } catch (err) {
      if (!isApiCode(err, 404)) throw err;
    }
  }
}

export async function renameSshKey(
  owner: SessionUser,
  id: string,
  newName: string,
): Promise<SshKeyView> {
  const nameErr = validateKeyName(newName);
  if (nameErr) throw new Error(nameErr);
  const name = newName.trim();
  let result: SshKey | undefined;

  await writeKeys(owner, (current) => {
    const idx = current.findIndex((k) => k.id === id);
    if (idx < 0) throw new Error("SSH key not found");
    if (
      current.some(
        (k, i) => i !== idx && k.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new Error(`A key named "${name}" already exists`);
    }
    const next = current.map((k, i) => (i === idx ? { ...k, name } : k));
    result = next[idx];
    return next;
  });

  if (!result) throw new Error("SSH key not found");
  return {
    ...result,
    fingerprint: fingerprintPublicKey(result.publicKey),
  };
}
