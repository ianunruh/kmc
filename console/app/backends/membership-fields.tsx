import {
  Alert,
  MultiSelect,
  Select,
  Textarea,
} from "@mantine/core";
import type { ReactNode } from "react";
import type { BackendMembershipMode } from "~/lib/types";

export type MembershipVmOption = {
  name: string;
  status: string;
  podNetwork: boolean;
  ready: boolean;
};

export const MEMBERSHIP_MODE_OPTIONS: Array<{
  value: BackendMembershipMode;
  label: string;
}> = [
  { value: "single-vm", label: "Single VM" },
  { value: "group", label: "VM group" },
  { value: "labels", label: "Label selector" },
];

export function vmSelectData(vms: MembershipVmOption[]) {
  return vms.map((vm) => ({
    value: vm.name,
    label: `${vm.name} · ${vm.status}${vm.podNetwork ? "" : " · Multus"}`,
  }));
}

export function multusWarningVms(
  mode: BackendMembershipMode,
  vms: MembershipVmOption[],
  singleVmName: string,
  groupVmNames: string[],
): MembershipVmOption[] {
  if (mode === "single-vm") {
    const vm = vms.find((v) => v.name === singleVmName);
    return vm && !vm.podNetwork ? [vm] : [];
  }
  if (mode === "group") {
    return vms.filter((vm) => groupVmNames.includes(vm.name) && !vm.podNetwork);
  }
  return [];
}

/**
 * Shared membership picker for Ingress / Load Balancer create forms.
 */
export function BackendMembershipFields({
  membershipMode,
  onMembershipModeChange,
  namespace,
  vmName,
  onVmNameChange,
  vmNameError,
  vmNames,
  onVmNamesChange,
  vmNamesError,
  matchLabelsText,
  onMatchLabelsTextChange,
  matchLabelsError,
  vmOptions,
  vmsLoading,
}: {
  membershipMode: BackendMembershipMode;
  onMembershipModeChange: (mode: BackendMembershipMode) => void;
  namespace: string;
  vmName: string;
  onVmNameChange: (name: string) => void;
  vmNameError?: ReactNode;
  vmNames: string[];
  onVmNamesChange: (names: string[]) => void;
  vmNamesError?: ReactNode;
  matchLabelsText: string;
  onMatchLabelsTextChange: (text: string) => void;
  matchLabelsError?: ReactNode;
  vmOptions: MembershipVmOption[];
  vmsLoading: boolean;
}) {
  const selectData = vmSelectData(vmOptions);
  const multus = multusWarningVms(
    membershipMode,
    vmOptions,
    vmName,
    vmNames,
  );

  return (
    <>
      <Select
        label="Membership"
        data={MEMBERSHIP_MODE_OPTIONS}
        required
        value={membershipMode}
        onChange={(v) =>
          onMembershipModeChange((v as BackendMembershipMode) ?? "single-vm")
        }
      />

      {membershipMode === "single-vm" && (
        <Select
          label="Virtual machine"
          placeholder={namespace ? "Select VM" : "Select namespace first"}
          data={selectData}
          required
          searchable
          disabled={!namespace}
          value={vmName || null}
          error={vmNameError}
          onChange={(v) => onVmNameChange(v ?? "")}
          nothingFoundMessage={
            vmsLoading ? "Loading…" : "No VMs in this namespace"
          }
        />
      )}

      {membershipMode === "group" && (
        <MultiSelect
          label="Virtual machines"
          description="Stamps kmc.ianunruh.com/backend-group on each VM pod template. Running VMs may need a restart before endpoints appear."
          placeholder={
            namespace ? "Select one or more VMs" : "Select namespace first"
          }
          data={selectData}
          required
          searchable
          disabled={!namespace}
          value={vmNames}
          error={vmNamesError}
          onChange={onVmNamesChange}
          nothingFoundMessage={
            vmsLoading ? "Loading…" : "No VMs in this namespace"
          }
        />
      )}

      {membershipMode === "labels" && (
        <Textarea
          label="Match labels"
          description="Pod-template labels on virt-launcher (key=value, one per line or comma-separated). Labels must already exist on the VMs."
          placeholder={"app=web\ntier=frontend"}
          minRows={3}
          required
          value={matchLabelsText}
          error={matchLabelsError}
          onChange={(e) => onMatchLabelsTextChange(e.currentTarget.value)}
        />
      )}

      {multus.length > 0 && (
        <Alert color="orange" variant="light" title="Multus-only guest(s)">
          {multus.length === 1
            ? `${multus[0].name} has no pod/masquerade NIC.`
            : `${multus.length} selected VMs have no pod/masquerade NIC.`}{" "}
          Ingress and Load Balancer select virt-launcher pod IPs only — traffic
          will not reach Multus guest addresses. Dual-home the VM (include pod
          network) before creating, or use Floating IP / Port Forward on the VPC
          plane.
        </Alert>
      )}
    </>
  );
}
