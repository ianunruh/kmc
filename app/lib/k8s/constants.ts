/** Kubernetes label namespace owned by kmc. */
export const KMC_LABEL_NAMESPACE = "kmc.ianunruh.com";

/** Standard ownership label value written on kmc-managed objects. */
export const KMC_MANAGED_BY = "kmc";
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";

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

/** Target VirtualMachine name for kmc-managed Service / Ingress exposure. */
export const KMC_LABEL_VM = `${KMC_LABEL_NAMESPACE}/vm`;

/**
 * What a kmc-managed Service/Ingress is bound to.
 * v1: `VirtualMachine`; future: label selector / group.
 */
export const KMC_LABEL_TARGET_KIND = `${KMC_LABEL_NAMESPACE}/target-kind`;
export const KMC_TARGET_KIND_VM = "VirtualMachine";

/** Ingress name stamped on the companion Service for reverse lookup. */
export const KMC_LABEL_INGRESS = `${KMC_LABEL_NAMESPACE}/ingress`;

/** List selector for kmc-managed Ingresses bound to a single VM. */
export const KMC_INGRESS_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_TARGET_KIND}=${KMC_TARGET_KIND_VM}`;
