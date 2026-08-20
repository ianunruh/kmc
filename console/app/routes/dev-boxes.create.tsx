import {
  ActionIcon,
  Alert,
  Button,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconDice, IconPlus } from "@tabler/icons-react";
import { useEffect, useMemo } from "react";
import { Link, redirect, useFetcher, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/dev-boxes.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { devBoxesListPath, validateDns1123Label, vmTabPath } from "~/lib/format";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { listSshKeysOrEmpty } from "~/ssh-keys/ssh-keys.server";
import {
  instanceTypeSelectData,
  preferredInstanceTypeName,
} from "~/instancetypes/options";
import { listClusters } from "~/vms/vms.server";
import { createDevBox } from "~/devboxes/devboxes.server";
import { suggestDevBoxName } from "~/devboxes/names";
import {
  DEVBOX_TEMPLATES,
  DEFAULT_DEVBOX_DISK_SIZE,
  isDevBoxTemplateId,
  templateSelectData,
} from "~/devboxes/options";
import type { ClusterCatalog } from "~/lib/types";
import { tracedLoader } from "~/lib/request-traces.server";
import { getSearchParam } from "~/lib/search-params";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create Dev Box · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  const session = getRequestSession();
  const { keys: sshKeys, error: sshKeysError } = await listSshKeysOrEmpty(
    session?.user ?? null,
  );
  const url = new URL(request.url);
  return {
    clusters: await listClusters(),
    sshKeys: sshKeys.map((k) => ({
      id: k.id,
      name: k.name,
      publicKey: k.publicKey,
      fingerprint: k.fingerprint,
    })),
    sshKeysError: sshKeysError ?? null,
    signedIn: Boolean(session?.user),
    ownerLogin: session?.user?.githubLogin ?? null,
    suggestedName: suggestDevBoxName(),
    prefill: {
      cluster: getSearchParam(url.searchParams, "cluster") ?? "",
      namespace: getSearchParam(url.searchParams, "namespace") ?? "",
    },
  };
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const template = String(form.get("template") ?? "").trim();
  const instanceType = String(form.get("instanceType") ?? "").trim();
  const diskSize = String(form.get("diskSize") ?? "").trim();
  const storageClass = String(form.get("storageClass") ?? "").trim() || undefined;
  const sshKeyMode = String(form.get("sshKeyMode") ?? "paste").trim();
  const savedSshKeyId = String(form.get("savedSshKeyId") ?? "").trim();
  let sshPublicKey = String(form.get("sshPublicKey") ?? "").trim();
  const repoUrl = String(form.get("repoUrl") ?? "").trim() || undefined;

  const nameErr = validateDns1123Label(name);
  if (nameErr) return { error: `Name: ${nameErr}` };
  if (!cluster) return { error: "cluster is required" };
  if (!namespace) return { error: "namespace is required" };
  if (!isDevBoxTemplateId(template)) {
    return { error: "template must be ubuntu, ubuntu-docker, or ubuntu-docker-code" };
  }

  if (sshKeyMode === "saved") {
    if (!savedSshKeyId) return { error: "Select an SSH key" };
    const session = getRequestSession();
    if (!session?.user) {
      return { error: "Sign in to use a saved SSH key, or paste a key instead" };
    }
    const { keys, error: listErr } = await listSshKeysOrEmpty(session.user);
    if (listErr) return { error: `Could not load SSH keys: ${listErr}` };
    const match = keys.find((k) => k.id === savedSshKeyId);
    if (!match) return { error: "Selected SSH key was not found" };
    sshPublicKey = match.publicKey;
  }
  if (!sshPublicKey) return { error: "SSH public key is required" };

  try {
    const created = await createDevBox({
      cluster,
      namespace,
      name,
      template,
      instanceType: instanceType || undefined,
      diskSize: diskSize || undefined,
      storageClass,
      sshPublicKey,
      repoUrl,
    });
    return redirect(vmTabPath(created, "access"));
  } catch (err) {
    return {
      error: logServerError("devbox.create", err, { cluster, namespace, name }),
    };
  }
}

type CatalogFetcherData = ClusterCatalog;

export default function CreateDevBoxPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    clusters,
    sshKeys,
    sshKeysError,
    signedIn,
    ownerLogin,
    suggestedName,
    prefill,
  } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const catalogFetcher = useFetcher<CatalogFetcherData>();
  const submitting = navigation.state === "submitting";
  const hasSavedKeys = sshKeys.length > 0;
  const reachableClusters = clusters.filter((c) => c.reachable);
  const defaultCluster =
    (prefill.cluster && reachableClusters.some((c) => c.id === prefill.cluster)
      ? prefill.cluster
      : undefined) ??
    reachableClusters[0]?.id ??
    "";

  const form = useForm({
    initialValues: {
      cluster: defaultCluster,
      namespace: prefill.namespace,
      name: suggestedName,
      template: "ubuntu-docker",
      instanceType: "",
      diskSize: DEFAULT_DEVBOX_DISK_SIZE,
      storageClass: "",
      sshKeyMode: hasSavedKeys ? "saved" : "paste",
      savedSshKeyId: sshKeys[0]?.id ?? "",
      sshPublicKey: "",
      repoUrl: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
      template: (v) => (isDevBoxTemplateId(v) ? null : "Required"),
    },
  });

  useEffect(() => {
    if (!form.values.cluster) return;
    catalogFetcher.load(`/api/catalog/${form.values.cluster}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.cluster]);

  useEffect(() => {
    const catalog = catalogFetcher.data;
    if (!catalog) return;
    const namespaceNames = catalog.namespaces.map((n) => n.name);
    if (!form.values.namespace || !namespaceNames.includes(form.values.namespace)) {
      if (prefill.namespace && namespaceNames.includes(prefill.namespace)) {
        form.setFieldValue("namespace", prefill.namespace);
      } else {
        form.setFieldValue("namespace", namespaceNames[0] ?? "");
      }
    }
    if (!form.values.instanceType) {
      const preferred = preferredInstanceTypeName(catalog.instanceTypes);
      if (preferred) form.setFieldValue("instanceType", preferred);
    }
    if (!form.values.storageClass && catalog.defaultStorageClass) {
      form.setFieldValue("storageClass", catalog.defaultStorageClass);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogFetcher.data]);

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Create failed", actionData.error);
    }
  }, [actionData]);

  const catalog = catalogFetcher.data;
  const namespaceOptions = useMemo(
    () => (catalog?.namespaces ?? []).map((n) => n.name),
    [catalog],
  );
  const instanceTypeOptions = useMemo(
    () => instanceTypeSelectData(catalog?.instanceTypes ?? []),
    [catalog],
  );
  const storageOptions = useMemo(
    () =>
      (catalog?.storageClasses ?? []).map((sc) => ({
        value: sc.name,
        label: sc.isDefault ? `${sc.name} (default)` : sc.name,
      })),
    [catalog],
  );
  const selectedTemplate = isDevBoxTemplateId(form.values.template)
    ? DEVBOX_TEMPLATES[form.values.template]
    : DEVBOX_TEMPLATES["ubuntu-docker"];

  const onSubmit = form.onSubmit((values) => {
    submit(
      {
        cluster: values.cluster,
        namespace: values.namespace,
        name: values.name,
        template: values.template,
        instanceType: values.instanceType,
        diskSize: values.diskSize,
        storageClass: values.storageClass,
        sshKeyMode: values.sshKeyMode,
        savedSshKeyId: values.savedSshKeyId,
        sshPublicKey: values.sshPublicKey,
        repoUrl: values.repoUrl,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create Dev Box"
        description="Opinionated Ubuntu VM on the pod network, with an internal MetalLB SSH VIP"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Placement">
            {ownerLogin ? (
              <Text size="sm" c="dimmed">
                Owner {ownerLogin} will be stamped on the VM.
              </Text>
            ) : (
              <Text size="sm" c="dimmed">
                No signed-in GitHub user — owner will be unset.
              </Text>
            )}
            <Select
              label="Cluster"
              placeholder="Select cluster"
              data={reachableClusters.map((c) => c.id)}
              required
              value={form.values.cluster || null}
              error={form.errors.cluster}
              onChange={(v) => {
                form.setFieldValue("cluster", v ?? "");
                form.setFieldValue("namespace", "");
                form.setFieldValue("instanceType", "");
              }}
            />
            <Select
              label="Namespace"
              description="vm-allowed namespaces"
              placeholder="Select namespace"
              data={namespaceOptions}
              required
              searchable
              disabled={!form.values.cluster}
              value={form.values.namespace || null}
              error={form.errors.namespace}
              onChange={(v) => form.setFieldValue("namespace", v ?? "")}
            />
          </FormSection>

          <FormSection title="Box">
            <TextInput
              label="Name"
              description="DNS-1123 — suggested as color-animal-digit"
              required
              value={form.values.name}
              error={form.errors.name}
              onChange={(e) => form.setFieldValue("name", e.currentTarget.value)}
              rightSection={
                <Tooltip label="Suggest another name">
                  <ActionIcon
                    variant="subtle"
                    aria-label="Suggest another name"
                    onClick={() => form.setFieldValue("name", suggestDevBoxName())}
                  >
                    <IconDice size={16} />
                  </ActionIcon>
                </Tooltip>
              }
            />
            <Select
              label="Template"
              description={selectedTemplate.description}
              data={templateSelectData()}
              required
              value={form.values.template}
              onChange={(v) => form.setFieldValue("template", v ?? "ubuntu-docker")}
            />
            <Select
              label="Instance type"
              data={instanceTypeOptions}
              required
              searchable
              disabled={!catalog}
              value={form.values.instanceType || null}
              onChange={(v) => form.setFieldValue("instanceType", v ?? "")}
            />
            <TextInput
              label="Disk size"
              placeholder={DEFAULT_DEVBOX_DISK_SIZE}
              value={form.values.diskSize}
              onChange={(e) => form.setFieldValue("diskSize", e.currentTarget.value)}
            />
            <Select
              label="Storage class"
              data={storageOptions}
              clearable
              value={form.values.storageClass || null}
              onChange={(v) => form.setFieldValue("storageClass", v ?? "")}
            />
            <TextInput
              label="Git repository"
              description="Optional public https:// URL cloned to ~/src on first boot"
              placeholder="https://github.com/org/repo"
              value={form.values.repoUrl}
              onChange={(e) => form.setFieldValue("repoUrl", e.currentTarget.value)}
            />
          </FormSection>

          <FormSection title="SSH">
            {sshKeysError ? (
              <Alert color="yellow" title="Saved SSH keys unavailable">
                {sshKeysError}. You can still paste a one-off public key.
              </Alert>
            ) : null}
            {hasSavedKeys ? (
              <Select
                label="SSH key source"
                data={[
                  { value: "saved", label: "Saved key" },
                  { value: "paste", label: "Paste a one-off key" },
                ]}
                value={form.values.sshKeyMode}
                onChange={(v) =>
                  form.setFieldValue("sshKeyMode", v === "paste" ? "paste" : "saved")
                }
              />
            ) : null}
            {form.values.sshKeyMode === "saved" && hasSavedKeys ? (
              <Select
                label="SSH public key"
                data={sshKeys.map((k) => ({
                  value: k.id,
                  label: `${k.name} · ${k.fingerprint}`,
                }))}
                required
                value={form.values.savedSshKeyId || null}
                onChange={(v) => form.setFieldValue("savedSshKeyId", v ?? "")}
              />
            ) : (
              <Textarea
                label="SSH public key"
                description={signedIn ? undefined : "Sign in to pick a saved key instead"}
                placeholder="ssh-ed25519 AAAA…"
                minRows={3}
                required
                {...form.getInputProps("sshPublicKey")}
              />
            )}
          </FormSection>

          <FormActions>
            <Button component={Link} to={devBoxesListPath()} variant="default">
              Cancel
            </Button>
            <Button
              type="submit"
              loading={submitting}
              leftSection={<IconPlus size={16} />}
            >
              Create Dev Box
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
