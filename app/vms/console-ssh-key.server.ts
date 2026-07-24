/**
 * Platform console SSH keypair for browser terminals.
 *
 * Public half is injected into cloud-init authorized_keys on VM create.
 * Private half stays in a kmc-system Secret and is used only server-side
 * when proxying SSH over the KubeVirt portforward subresource.
 *
 * Private key is stored in OpenSSH format (`BEGIN OPENSSH PRIVATE KEY`) because
 * ssh2 cannot parse PKCS#8 Ed25519 (`BEGIN PRIVATE KEY`).
 *
 * Stored on the settings cluster (same as user SSH key ConfigMaps).
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { ApiException, type V1Secret } from "@kubernetes/client-node";
import {
  getSettingsClusterClients,
  getSettingsClusterId,
} from "~/lib/k8s/clients.server";

const SETTINGS_NAMESPACE = "kmc-system";
export const PLATFORM_CONSOLE_SECRET_NAME = "kmc-console-ssh";

const KEY_PRIVATE = "id_ed25519";
const KEY_PUBLIC = "id_ed25519.pub";

const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
const LABEL_RESOURCE = "kmc.ianunruh.com/resource";

const OPENSSH_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_END = "-----END OPENSSH PRIVATE KEY-----";

/** Guest user for browser SSH (Ubuntu cloud images default). */
export function getConsoleSshUser(): string {
  const fromEnv = process.env.KMC_CONSOLE_SSH_USER?.trim();
  return fromEnv || "ubuntu";
}

export type PlatformConsoleKeyPair = {
  /** OpenSSH private key PEM (`BEGIN OPENSSH PRIVATE KEY`). */
  privateKeyPem: string;
  publicKeyOpenSsh: string;
};

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

function writeUint32BE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function sshString(data: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  return Buffer.concat([writeUint32BE(buf.length), buf]);
}

function b64urlToBuffer(s: string): Buffer {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return Buffer.from(b64, "base64");
}

/**
 * Encode an Ed25519 SPKI public key as OpenSSH authorized_keys line.
 * SPKI for Ed25519 ends with the raw 32-byte public key.
 */
export function ed25519SpkiToOpenSsh(spkiDer: Buffer, comment = "kmc-console"): string {
  if (spkiDer.length < 32) {
    throw new Error("Invalid Ed25519 SPKI public key");
  }
  const raw = spkiDer.subarray(spkiDer.length - 32);
  const keyType = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([
    writeUint32BE(keyType.length),
    keyType,
    writeUint32BE(raw.length),
    raw,
  ]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

/** OpenSSH public key line from an Ed25519 KeyObject. */
export function ed25519PublicKeyToOpenSsh(
  publicKey: KeyObject,
  comment = "kmc-console",
): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("Ed25519 public JWK missing x");
  const raw = b64urlToBuffer(jwk.x);
  if (raw.length !== 32) throw new Error("Invalid Ed25519 public key length");
  const keyType = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([sshString(keyType), sshString(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

/**
 * Encode an Ed25519 private KeyObject as unencrypted OpenSSH private key PEM.
 * Required by ssh2 (PKCS#8 `BEGIN PRIVATE KEY` is rejected for Ed25519).
 */
export function ed25519PrivateKeyToOpenSsh(
  privateKey: KeyObject,
  comment = "kmc-console",
): string {
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string; x?: string };
  if (!jwk.d || !jwk.x) {
    throw new Error("Ed25519 private JWK missing d/x");
  }
  const seed = b64urlToBuffer(jwk.d);
  const pub = b64urlToBuffer(jwk.x);
  if (seed.length !== 32 || pub.length !== 32) {
    throw new Error("Invalid Ed25519 JWK component length");
  }

  const keyType = Buffer.from("ssh-ed25519");
  const pubBlob = Buffer.concat([sshString(keyType), sshString(pub)]);
  // OpenSSH wire form: 32-byte seed || 32-byte public
  const privMaterial = Buffer.concat([seed, pub]);

  const check = randomBytes(4);
  let privSection = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(pub),
    sshString(privMaterial),
    sshString(comment),
  ]);
  // Pad to 8-byte boundary with 1,2,3,…
  const padLen = (8 - (privSection.length % 8)) % 8;
  if (padLen > 0) {
    const pad = Buffer.alloc(padLen);
    for (let i = 0; i < padLen; i++) pad[i] = i + 1;
    privSection = Buffer.concat([privSection, pad]);
  }

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "utf8"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    writeUint32BE(1),
    sshString(pubBlob),
    sshString(privSection),
  ]);

  const b64 = body.toString("base64");
  const lines = b64.match(/.{1,70}/g)?.join("\n") ?? b64;
  return `${OPENSSH_BEGIN}\n${lines}\n${OPENSSH_END}\n`;
}

/** True when the private key block is OpenSSH format (ssh2-compatible for Ed25519). */
export function isOpenSshPrivateKey(pem: string): boolean {
  return pem.includes(OPENSSH_BEGIN);
}

/**
 * Generate a new platform keypair (OpenSSH private + OpenSSH public).
 */
export function generatePlatformConsoleKeyPair(): PlatformConsoleKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = ed25519PrivateKeyToOpenSsh(privateKey);
  const publicKeyOpenSsh = ed25519PublicKeyToOpenSsh(publicKey);
  // Sanity: Node can still load public; private is OpenSSH-only for ssh2
  createPublicKey(publicKey);
  if (!isOpenSshPrivateKey(privateKeyPem)) {
    throw new Error("Generated private key is not OpenSSH format");
  }
  return { privateKeyPem, publicKeyOpenSsh };
}

/**
 * If we stored PKCS#8 earlier, convert in place so the public key stays stable
 * for any guest that already has it authorized.
 */
function migratePrivateKeyToOpenSsh(privateKeyText: string): string | null {
  const trimmed = privateKeyText.trim();
  if (isOpenSshPrivateKey(trimmed)) {
    return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  }
  // PKCS#8 / SEC1 PEM that Node can load
  if (!trimmed.includes("BEGIN") || !trimmed.includes("PRIVATE KEY")) {
    return null;
  }
  try {
    const key = createPrivateKey(trimmed);
    if (key.asymmetricKeyType !== "ed25519") return null;
    return ed25519PrivateKeyToOpenSsh(key);
  } catch {
    return null;
  }
}

function parseSecret(secret: V1Secret | null): {
  pair: PlatformConsoleKeyPair;
  needsRewrite: boolean;
} | null {
  if (!secret?.data) return null;
  const privB64 = secret.data[KEY_PRIVATE];
  const pubB64 = secret.data[KEY_PUBLIC];
  if (!privB64 || !pubB64) return null;
  try {
    const privateRaw = Buffer.from(privB64, "base64").toString("utf8");
    const publicKeyOpenSsh = Buffer.from(pubB64, "base64").toString("utf8").trim();
    if (!publicKeyOpenSsh.startsWith("ssh-")) return null;

    let privateKeyPem = privateRaw.trim();
    let needsRewrite = false;

    if (!isOpenSshPrivateKey(privateKeyPem)) {
      const migrated = migratePrivateKeyToOpenSsh(privateKeyPem);
      if (!migrated) return null;
      privateKeyPem = migrated;
      needsRewrite = true;
    } else if (!privateKeyPem.endsWith("\n")) {
      privateKeyPem = `${privateKeyPem}\n`;
    }

    return {
      pair: { privateKeyPem, publicKeyOpenSsh },
      needsRewrite,
    };
  } catch {
    return null;
  }
}

async function readSecret(): Promise<V1Secret | null> {
  const { core } = getSettingsClusterClients();
  try {
    return await core.readNamespacedSecret({
      name: PLATFORM_CONSOLE_SECRET_NAME,
      namespace: SETTINGS_NAMESPACE,
    });
  } catch (err) {
    if (isApiCode(err, 404)) return null;
    throw err;
  }
}

function secretBody(pair: PlatformConsoleKeyPair, resourceVersion?: string): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: PLATFORM_CONSOLE_SECRET_NAME,
      namespace: SETTINGS_NAMESPACE,
      labels: {
        [LABEL_MANAGED_BY]: "kmc",
        [LABEL_RESOURCE]: "console-ssh",
      },
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    type: "Opaque",
    stringData: {
      [KEY_PRIVATE]: pair.privateKeyPem.endsWith("\n")
        ? pair.privateKeyPem
        : `${pair.privateKeyPem}\n`,
      [KEY_PUBLIC]: pair.publicKeyOpenSsh.endsWith("\n")
        ? pair.publicKeyOpenSsh
        : `${pair.publicKeyOpenSsh}\n`,
    },
  };
}

async function writeSecret(
  pair: PlatformConsoleKeyPair,
  existing: V1Secret | null,
): Promise<void> {
  const { core } = getSettingsClusterClients();
  const body = secretBody(pair, existing?.metadata?.resourceVersion);
  if (!existing) {
    await core.createNamespacedSecret({
      namespace: SETTINGS_NAMESPACE,
      body,
    });
  } else {
    await core.replaceNamespacedSecret({
      name: PLATFORM_CONSOLE_SECRET_NAME,
      namespace: SETTINGS_NAMESPACE,
      body,
    });
  }
}

/**
 * Load the platform console keypair, creating it on first use.
 * Migrates legacy PKCS#8 secrets to OpenSSH format (same key material).
 * Uses settings-cluster clients without user impersonation.
 */
export async function ensurePlatformConsoleKeyPair(): Promise<PlatformConsoleKeyPair> {
  const existing = await readSecret();
  const parsed = parseSecret(existing);
  if (parsed) {
    if (parsed.needsRewrite) {
      try {
        await writeSecret(parsed.pair, existing);
        console.warn(
          `[kmc:console-ssh] migrated platform key Secret to OpenSSH format ` +
            `(${SETTINGS_NAMESPACE}/${PLATFORM_CONSOLE_SECRET_NAME} on ${getSettingsClusterId()})`,
        );
      } catch (err) {
        // Still usable in-process even if rewrite fails
        console.error(
          "[kmc:console-ssh] failed to rewrite migrated key Secret:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return parsed.pair;
  }

  const pair = generatePlatformConsoleKeyPair();

  try {
    await writeSecret(pair, existing);
    console.warn(
      `[kmc:console-ssh] created platform key Secret ${SETTINGS_NAMESPACE}/${PLATFORM_CONSOLE_SECRET_NAME} on ${getSettingsClusterId()}`,
    );
    return pair;
  } catch (err) {
    // Race: another instance created it
    if (isApiCode(err, 409)) {
      const again = parseSecret(await readSecret());
      if (again) return again.pair;
    }
    throw err;
  }
}

/** Public key only (for cloud-init). Returns null if settings store is unavailable. */
export async function getPlatformConsolePublicKey(): Promise<string | null> {
  try {
    const pair = await ensurePlatformConsoleKeyPair();
    return pair.publicKeyOpenSsh;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[kmc:console-ssh] failed to load platform public key:", message);
    return null;
  }
}

/** Full keypair for the SSH proxy. Throws if unavailable. */
export async function getPlatformConsoleKeyPair(): Promise<PlatformConsoleKeyPair> {
  return ensurePlatformConsoleKeyPair();
}
