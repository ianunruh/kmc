/** Kubernetes label namespace owned by kmc. */
export const KMC_LABEL_NAMESPACE = "kmc.ianunruh.com";

/**
 * Namespaces labeled with this key (value `"true"`) appear in the launch/create
 * namespace pickers and are accepted by createVm.
 */
export const VM_ALLOWED_LABEL = `${KMC_LABEL_NAMESPACE}/vm-allowed`;

export const VM_ALLOWED_LABEL_SELECTOR = `${VM_ALLOWED_LABEL}=true`;

/**
 * Golden image PVCs labeled with this key name a VirtualMachineClusterPreference
 * applied automatically when launching a VM from that image.
 */
export const IMAGE_PREFERENCE_LABEL = `${KMC_LABEL_NAMESPACE}/cluster-preference`;
