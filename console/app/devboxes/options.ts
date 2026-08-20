export const DEVBOX_TEMPLATE_IDS = [
  "ubuntu",
  "ubuntu-docker",
  "ubuntu-docker-code",
] as const;

export type DevBoxTemplateId = (typeof DEVBOX_TEMPLATE_IDS)[number];

export type DevBoxTemplate = {
  id: DevBoxTemplateId;
  name: string;
  description: string;
  docker: boolean;
  codeServer: boolean;
  defaultDiskSize: string;
};

export const DEFAULT_DEVBOX_DISK_SIZE = "150Gi";

export const DEVBOX_TEMPLATES: Record<DevBoxTemplateId, DevBoxTemplate> = {
  ubuntu: {
    id: "ubuntu",
    name: "Ubuntu",
    description: "Guest agent, git, build-essential. Optional public repo clone.",
    docker: false,
    codeServer: false,
    defaultDiskSize: DEFAULT_DEVBOX_DISK_SIZE,
  },
  "ubuntu-docker": {
    id: "ubuntu-docker",
    name: "Ubuntu + Docker",
    description: "Ubuntu plus docker.io; your user is in the docker group.",
    docker: true,
    codeServer: false,
    defaultDiskSize: DEFAULT_DEVBOX_DISK_SIZE,
  },
  "ubuntu-docker-code": {
    id: "ubuntu-docker-code",
    name: "Ubuntu + Docker + code-server",
    description: "Docker plus code-server on :8080, published through Envoy with OIDC.",
    docker: true,
    codeServer: true,
    defaultDiskSize: DEFAULT_DEVBOX_DISK_SIZE,
  },
};

export function isDevBoxTemplateId(value: string): value is DevBoxTemplateId {
  return (DEVBOX_TEMPLATE_IDS as readonly string[]).includes(value);
}

export function templateSelectData(): Array<{ value: string; label: string }> {
  return DEVBOX_TEMPLATE_IDS.map((id) => ({
    value: id,
    label: DEVBOX_TEMPLATES[id].name,
  }));
}
