export type CloudInitGitIdentity = {
  name?: string;
  email?: string;
  githubLogin?: string;
};

export type CloudInitOpts = {
  sshPublicKeys: string | string[];
  /** Guest login used for docker group, git clone, code-server (default ubuntu). */
  sshUser?: string;
  /** qemu-guest-agent package + enable (Launch VM + Dev Box). */
  guestAgent?: boolean;
  /** Include traceroute next to guest-agent (Launch VM historical default). */
  traceroute?: boolean;
  /** git, curl, ca-certificates, build-essential. */
  basePackages?: boolean;
  docker?: boolean;
  gitIdentity?: CloudInitGitIdentity;
  /** Public https git URL only. */
  repoUrl?: string;
  codeServer?: boolean;
  /** Write /var/lib/kmc/ready after runcmd. */
  readyFile?: boolean;
};

function normalizeAuthorizedKeys(keys: string | string[] | undefined | null): string[] {
  const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

const SAFE_HTTPS_REPO = /^https:\/\/[A-Za-z0-9._~:/?#@[\]!$&'()*+,;=%-]+$/;

export function parseHttpsGitUrl(raw: string): { url: string; basename: string } {
  const url = raw.trim();
  if (!url) {
    throw new Error("repo URL is required");
  }
  if (url.startsWith("git@") || url.startsWith("ssh://")) {
    throw new Error("Only public https:// git URLs are supported");
  }
  if (!SAFE_HTTPS_REPO.test(url)) {
    throw new Error("repo URL must be a public https:// address");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("repo URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only public https:// git URLs are supported");
  }
  const leaf = parsed.pathname.split("/").filter(Boolean).pop() ?? "repo";
  const basename = leaf.replace(/\.git$/i, "") || "repo";
  if (!/^[A-Za-z0-9._-]+$/.test(basename)) {
    throw new Error("could not derive a safe directory name from the repo URL");
  }
  return { url, basename };
}

export function workspacePathForRepo(sshUser: string, repoUrl: string): string {
  const { basename } = parseHttpsGitUrl(repoUrl);
  return `/home/${sshUser}/src/${basename}`;
}

/**
 * Compose a #cloud-config document. Launch VM uses ssh (+ optional guest-agent)
 * only; Dev Boxes stack the rest. Output stays line-oriented YAML.
 */
export function buildCloudInitDocument(opts: CloudInitOpts): string {
  const keys = normalizeAuthorizedKeys(opts.sshPublicKeys);
  if (keys.length === 0) {
    throw new Error("At least one SSH public key is required for cloud-init");
  }
  const sshUser = (opts.sshUser ?? "ubuntu").trim() || "ubuntu";
  const home = `/home/${sshUser}`;
  const packages: string[] = [];
  const runcmd: string[] = [];
  const writeFiles: Array<{
    path: string;
    content: string;
    owner?: string;
    permissions?: string;
  }> = [];
  // write_files runs before users-groups. Staging under /var/lib/kmc avoids
  // mkdir /home/<user> as root (ubuntu isn't in passwd yet; chown then fails
  // and the homedir stays root-owned).
  const stagedGitconfig = "/var/lib/kmc/gitconfig";
  const stagedCodeServer = "/var/lib/kmc/code-server-config.yaml";

  if (opts.guestAgent || opts.basePackages) {
    packages.push("qemu-guest-agent");
    if (opts.traceroute !== false && (opts.guestAgent || opts.traceroute)) {
      packages.push("traceroute");
    }
    runcmd.push("systemctl enable --now qemu-guest-agent");
  }
  if (opts.basePackages) {
    packages.push("git", "curl", "ca-certificates", "build-essential");
  }
  if (opts.docker) {
    packages.push("docker.io");
    runcmd.push(`usermod -aG docker ${sshUser}`);
  }

  const ident = opts.gitIdentity;
  const hasGitconfig = Boolean(
    ident && (ident.name?.trim() || ident.email?.trim() || ident.githubLogin),
  );
  if (hasGitconfig && ident) {
    const name = ident.name?.trim() || ident.githubLogin?.trim() || sshUser;
    const email = ident.email?.trim() || "";
    const gitconfig = [
      "[user]",
      `  name = ${name}`,
      ...(email ? [`  email = ${email}`] : []),
    ].join("\n");
    writeFiles.push({
      path: stagedGitconfig,
      permissions: "0644",
      content: gitconfig,
    });
  }

  const touchesHome = hasGitconfig || Boolean(opts.repoUrl?.trim()) || Boolean(opts.codeServer);
  if (touchesHome) {
    runcmd.push(`install -d -o ${sshUser} -g ${sshUser} ${home}`);
  }
  if (hasGitconfig) {
    runcmd.push(
      `install -o ${sshUser} -g ${sshUser} -m 0644 ${stagedGitconfig} ${home}/.gitconfig`,
    );
  }

  if (opts.repoUrl?.trim()) {
    const { url, basename } = parseHttpsGitUrl(opts.repoUrl);
    runcmd.push(
      `install -d -o ${sshUser} -g ${sshUser} ${home}/src`,
      `sudo -u ${sshUser} git clone ${url} ${home}/src/${basename}`,
    );
  }

  if (opts.codeServer) {
    writeFiles.push({
      path: stagedCodeServer,
      permissions: "0644",
      content: ["bind-addr: 0.0.0.0:8080", "auth: none", "cert: false"].join("\n"),
    });
    runcmd.push(
      `install -d -o ${sshUser} -g ${sshUser} ${home}/.config/code-server`,
      `install -o ${sshUser} -g ${sshUser} -m 0644 ${stagedCodeServer} ${home}/.config/code-server/config.yaml`,
      // cloud-init runcmd has no HOME; install.sh runs with `set -u`.
      "curl -fsSL https://code-server.dev/install.sh | HOME=/root sh",
    );
  }

  if (touchesHome) {
    runcmd.push(`chown -R ${sshUser}:${sshUser} ${home}`);
  }
  if (opts.codeServer) {
    runcmd.push(`systemctl enable --now code-server@${sshUser}`);
  }

  if (opts.readyFile) {
    runcmd.push("mkdir -p /var/lib/kmc", "touch /var/lib/kmc/ready");
  }

  const lines = [
    "#cloud-config",
    "users:",
    "  - default",
    "ssh_authorized_keys:",
    ...keys.map((k) => `  - ${k}`),
  ];

  const uniquePackages = [...new Set(packages)];
  if (uniquePackages.length > 0) {
    lines.push("packages:", ...uniquePackages.map((p) => `  - ${p}`));
  }

  if (writeFiles.length > 0) {
    lines.push("write_files:");
    for (const file of writeFiles) {
      lines.push(`  - path: ${file.path}`);
      if (file.owner) lines.push(`    owner: ${file.owner}`);
      if (file.permissions) lines.push(`    permissions: "${file.permissions}"`);
      lines.push("    content: |");
      for (const row of file.content.split("\n")) {
        lines.push(`      ${row}`);
      }
    }
  }

  if (runcmd.length > 0) {
    lines.push("runcmd:", ...runcmd.map((c) => `  - ${c}`));
  }

  return lines.join("\n");
}

/**
 * Minimal cloud-config that installs SSH public key(s) on the image default user.
 * Optional qemu-guest-agent package + enable (soft reboot, guest OS info).
 */
export function buildSshUserData(
  sshPublicKey: string | string[],
  opts?: { installGuestAgent?: boolean },
): string {
  return buildCloudInitDocument({
    sshPublicKeys: sshPublicKey,
    guestAgent: opts?.installGuestAgent === true,
    traceroute: opts?.installGuestAgent === true,
  });
}
