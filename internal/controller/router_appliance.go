package controller

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	authenticationv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	rt "github.com/ianunruh/kmc/internal/router"
	"github.com/ianunruh/kmc/internal/router/agent"
)

var virtualMachineGVK = schema.GroupVersionKind{
	Group:   "kubevirt.io",
	Version: "v1",
	Kind:    "VirtualMachine",
}

func newVMUnstructured(namespace, name string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(virtualMachineGVK)
	u.SetNamespace(namespace)
	u.SetName(name)
	return u
}

// ensureRouterAppliance creates/updates the KubeVirt VM + cloud-init secret.
// Requires ClusterPodCIDRs / ClusterServiceCIDRs on the reconciler.
func (r *RouterReconciler) ensureRouterAppliance(
	ctx context.Context,
	obj *kmcv1alpha1.Router,
	ifaces []resolvedInterface,
	ext *resolvedExternal,
) (vmReady bool, vmStatus string, vmMissing bool, err error) {
	if len(r.ClusterPodCIDRs) == 0 && len(r.ClusterServiceCIDRs) == 0 {
		return false, "", false, fmt.Errorf("cluster pod/service CIDRs not configured (set --cluster-pod-cidrs / --cluster-service-cidrs)")
	}

	token, err := r.mintRouterAgentToken(ctx, obj)
	if err != nil {
		return false, "", false, err
	}
	apiServer := r.APIServerURL
	if apiServer == "" {
		apiServer = inClusterAPIServerURL()
	}
	caData, err := r.loadClusterCAData()
	if err != nil {
		return false, "", false, err
	}

	userData := buildRouterCloudInit(routerCloudInitInput{
		SSHPublicKeys:   obj.Spec.Appliance.SSHPublicKeys,
		KnownMultusMACs: collectMACs(ifaces, ext),
		PodCIDRs:        r.ClusterPodCIDRs,
		ServiceCIDRs:    r.ClusterServiceCIDRs,
		Namespace:       obj.Namespace,
		PolicyConfigMap: rt.ConfigMapName(obj.Name),
		APIServer:       apiServer,
		CAData:          caData,
		AgentToken:      token,
		AgentScript:     agent.Script,
	})

	secretName := rt.CloudInitSecretName(obj.Name)
	if err := r.ensureCloudInitSecret(ctx, obj, secretName, userData); err != nil {
		return false, "", false, err
	}

	vm := newVMUnstructured(obj.Namespace, obj.Name)
	err = r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: obj.Name}, vm)
	if apierrors.IsNotFound(err) {
		body, buildErr := r.buildRouterVM(obj, ifaces, ext, secretName)
		if buildErr != nil {
			return false, "", true, buildErr
		}
		if err := controllerutil.SetControllerReference(obj, body, r.Scheme); err != nil {
			return false, "", true, err
		}
		if err := r.Create(ctx, body); err != nil {
			return false, "", true, fmt.Errorf("create VirtualMachine: %w", err)
		}
		return false, "Created", false, nil
	}
	if err != nil {
		return false, "", false, err
	}

	// Update Multus interfaces for attach/detach (hotplug when possible).
	if err := r.syncRouterVMNetworks(ctx, vm, obj, ifaces, ext); err != nil {
		return false, vmPrintableStatus(vm), false, err
	}

	ready := vmIsReady(vm)
	return ready, vmPrintableStatus(vm), false, nil
}

func collectMACs(ifaces []resolvedInterface, ext *resolvedExternal) []string {
	var macs []string
	for _, iface := range ifaces {
		if iface.MAC != "" {
			macs = append(macs, iface.MAC)
		}
	}
	if ext != nil && ext.MAC != "" {
		macs = append(macs, ext.MAC)
	}
	return macs
}

func (r *RouterReconciler) mintRouterAgentToken(ctx context.Context, obj *kmcv1alpha1.Router) (string, error) {
	saName := rt.ServiceAccountName(obj.Name)
	tr := &authenticationv1.TokenRequest{
		Spec: authenticationv1.TokenRequestSpec{
			ExpirationSeconds: ptr.To[int64](60 * 60 * 24 * 365),
		},
	}
	sa := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: saName, Namespace: obj.Namespace}}
	if err := r.Client.SubResource("token").Create(ctx, sa, tr); err != nil {
		// Fallback for fake clients / environments without TokenRequest subresource:
		// return empty and let cloud-init use projected SA token if available later.
		// For production this must succeed.
		return "", fmt.Errorf("TokenRequest for %s/%s: %w", obj.Namespace, saName, err)
	}
	if tr.Status.Token == "" {
		return "", fmt.Errorf("TokenRequest returned empty token")
	}
	return tr.Status.Token, nil
}

func (r *RouterReconciler) loadClusterCAData() (string, error) {
	if r.ClusterCAData != "" {
		return r.ClusterCAData, nil
	}
	path := "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read cluster CA: %w", err)
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

func inClusterAPIServerURL() string {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" {
		return "https://kubernetes.default.svc"
	}
	if port == "" {
		port = "443"
	}
	// IPv6 hosts need brackets
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("https://%s:%s", host, port)
}

func (r *RouterReconciler) ensureCloudInitSecret(ctx context.Context, obj *kmcv1alpha1.Router, secretName, userData string) error {
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: secretName, Namespace: obj.Namespace},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sec, func() error {
		sec.Labels = mergeLabels(sec.Labels, routerApplianceLabels(obj.Name))
		sec.Type = corev1.SecretTypeOpaque
		if sec.Data == nil {
			sec.Data = map[string][]byte{}
		}
		sec.Data["userdata"] = []byte(userData)
		return controllerutil.SetControllerReference(obj, sec, r.Scheme)
	})
	return err
}

func (r *RouterReconciler) buildRouterVM(
	obj *kmcv1alpha1.Router,
	ifaces []resolvedInterface,
	ext *resolvedExternal,
	secretName string,
) (*unstructured.Unstructured, error) {
	app := obj.Spec.Appliance
	runStrategy := strings.TrimSpace(app.RunStrategy)
	if runStrategy == "" {
		runStrategy = "Always"
	}

	// Networks: pod first, then VPC Multus, then optional external.
	networks := []interface{}{
		map[string]interface{}{
			"name": "pod",
			"pod":  map[string]interface{}{},
		},
	}
	interfaces := []interface{}{
		map[string]interface{}{
			"name": "pod",
			"masquerade": map[string]interface{}{},
		},
	}

	for i, iface := range ifaces {
		netName := fmt.Sprintf("vpc%d", i)
		networks = append(networks, map[string]interface{}{
			"name": netName,
			"multus": map[string]interface{}{
				"networkName": iface.VPC,
			},
		})
		interfaces = append(interfaces, map[string]interface{}{
			"name":       netName,
			"bridge":     map[string]interface{}{},
			"macAddress": iface.MAC,
		})
	}
	if ext != nil {
		networks = append(networks, map[string]interface{}{
			"name": "external",
			"multus": map[string]interface{}{
				"networkName": ext.MultusNetwork,
			},
		})
		interfaces = append(interfaces, map[string]interface{}{
			"name":       "external",
			"bridge":     map[string]interface{}{},
			"macAddress": ext.MAC,
		})
	}

	// Domain resources
	domain := map[string]interface{}{
		"devices": map[string]interface{}{
			"disks": []interface{}{
				map[string]interface{}{
					"name": "root",
					"disk": map[string]interface{}{"bus": "virtio"},
				},
				map[string]interface{}{
					"name": "cloudinit",
					"disk": map[string]interface{}{"bus": "virtio"},
				},
			},
			"interfaces": interfaces,
		},
	}
	if strings.TrimSpace(app.InstanceType) == "" {
		domain["cpu"] = map[string]interface{}{"cores": int64(*app.CPUCores)}
		domain["resources"] = map[string]interface{}{
			"requests": map[string]interface{}{
				"memory": app.Memory,
			},
		}
	}

	// IPAM annotations for Multus allocations (console parity).
	ann := map[string]string{}
	var ipv4Parts []string
	for _, iface := range ifaces {
		ipv4Parts = append(ipv4Parts, fmt.Sprintf("%s/%d", iface.Gateway, iface.Prefix))
	}
	if ext != nil {
		ipv4Parts = append(ipv4Parts, ext.PrimaryCIDR)
	}
	if len(ipv4Parts) > 0 {
		ann["kmc.ianunruh.com/ipv4"] = strings.Join(ipv4Parts, ",")
	}

	dvName := obj.Name + "-root"
	imageNS := app.Image.Namespace
	imageName := app.Image.Name

	// Match console ensureRootDataVolumeFromImage: Block volumeMode is required
	// for CSI clones from golden-image PVCs on ceph-block-* (source is Block).
	// Omitting volumeMode defaults to Filesystem → IncompatibleVolumeModes and
	// a stuck CloneInProgress DV.
	storage := map[string]interface{}{
		"accessModes": []interface{}{"ReadWriteOnce"},
		"volumeMode":  "Block",
		"resources": map[string]interface{}{
			"requests": map[string]interface{}{
				"storage": app.DiskSize,
			},
		},
	}
	if sc := strings.TrimSpace(app.StorageClass); sc != "" {
		storage["storageClassName"] = sc
	}
	dvTemplate := map[string]interface{}{
		"metadata": map[string]interface{}{
			"name": dvName,
		},
		"spec": map[string]interface{}{
			"storage": storage,
			"source": map[string]interface{}{
				"pvc": map[string]interface{}{
					"namespace": imageNS,
					"name":      imageName,
				},
			},
		},
	}

	spec := map[string]interface{}{
		"runStrategy": runStrategy,
		"dataVolumeTemplates": []interface{}{dvTemplate},
		"template": map[string]interface{}{
			"metadata": map[string]interface{}{
				"labels":      routerApplianceLabels(obj.Name),
				"annotations": ann,
			},
			"spec": map[string]interface{}{
				"domain": domain,
				"networks": networks,
				"volumes": []interface{}{
					map[string]interface{}{
						"name": "root",
						"dataVolume": map[string]interface{}{
							"name": dvName,
						},
					},
					map[string]interface{}{
						"name": "cloudinit",
						"cloudInitNoCloud": map[string]interface{}{
							"secretRef": map[string]interface{}{
								"name": secretName,
							},
						},
					},
				},
			},
		},
	}

	if it := strings.TrimSpace(app.InstanceType); it != "" {
		spec["instancetype"] = map[string]interface{}{
			"kind": "virtualmachineclusterinstancetype",
			"name": it,
		}
	}

	u := newVMUnstructured(obj.Namespace, obj.Name)
	u.SetLabels(routerApplianceLabels(obj.Name))
	u.SetAnnotations(ann)
	u.Object["spec"] = spec
	return u, nil
}

func (r *RouterReconciler) syncRouterVMNetworks(
	ctx context.Context,
	vm *unstructured.Unstructured,
	obj *kmcv1alpha1.Router,
	ifaces []resolvedInterface,
	ext *resolvedExternal,
) error {
	// Desired Multus network names.
	desired := map[string]string{} // netName -> multus NAD
	desiredMAC := map[string]string{}
	for i, iface := range ifaces {
		netName := fmt.Sprintf("vpc%d", i)
		// Prefer stable name by VPC for day-2 attach: use vpc name hashed into interface name.
		netName = multusIfaceName(iface.VPC)
		desired[netName] = iface.VPC
		desiredMAC[netName] = iface.MAC
	}
	if ext != nil {
		desired["external"] = ext.MultusNetwork
		desiredMAC["external"] = ext.MAC
	}

	networks, _, _ := unstructured.NestedSlice(vm.Object, "spec", "template", "spec", "networks")
	interfaces, _, _ := unstructured.NestedSlice(vm.Object, "spec", "template", "spec", "domain", "devices", "interfaces")

	// Index existing multus nets (skip pod).
	existingNets := map[string]map[string]interface{}{}
	var podNet map[string]interface{}
	for _, n := range networks {
		m, ok := n.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		if _, hasPod := m["pod"]; hasPod {
			podNet = m
			continue
		}
		existingNets[name] = m
	}
	existingIfaces := map[string]map[string]interface{}{}
	var podIface map[string]interface{}
	for _, n := range interfaces {
		m, ok := n.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		if name == "pod" {
			podIface = m
			continue
		}
		existingIfaces[name] = m
	}

	newNetworks := []interface{}{}
	if podNet != nil {
		newNetworks = append(newNetworks, podNet)
	} else {
		newNetworks = append(newNetworks, map[string]interface{}{
			"name": "pod",
			"pod":  map[string]interface{}{},
		})
	}
	newIfaces := []interface{}{}
	if podIface != nil {
		newIfaces = append(newIfaces, podIface)
	} else {
		newIfaces = append(newIfaces, map[string]interface{}{
			"name":       "pod",
			"masquerade": map[string]interface{}{},
		})
	}

	// Keep/add desired
	for netName, multus := range desired {
		if existing, ok := existingNets[netName]; ok {
			newNetworks = append(newNetworks, existing)
		} else {
			newNetworks = append(newNetworks, map[string]interface{}{
				"name": netName,
				"multus": map[string]interface{}{
					"networkName": multus,
				},
			})
		}
		if existing, ok := existingIfaces[netName]; ok {
			// Ensure MAC
			if mac := desiredMAC[netName]; mac != "" {
				existing["macAddress"] = mac
			}
			// Clear absent state if re-attaching
			delete(existing, "state")
			newIfaces = append(newIfaces, existing)
		} else {
			newIfaces = append(newIfaces, map[string]interface{}{
				"name":       netName,
				"bridge":     map[string]interface{}{},
				"macAddress": desiredMAC[netName],
			})
		}
	}

	// Mark removed Multus interfaces as absent (hot-unplug).
	for name, existing := range existingIfaces {
		if _, keep := desired[name]; keep {
			continue
		}
		cp := map[string]interface{}{}
		for k, v := range existing {
			cp[k] = v
		}
		cp["state"] = "absent"
		newIfaces = append(newIfaces, cp)
		if net, ok := existingNets[name]; ok {
			newNetworks = append(newNetworks, net)
		}
	}

	before := vm.DeepCopy()
	_ = unstructured.SetNestedSlice(vm.Object, newNetworks, "spec", "template", "spec", "networks")
	_ = unstructured.SetNestedSlice(vm.Object, newIfaces, "spec", "template", "spec", "domain", "devices", "interfaces")

	// Refresh IPAM annotation
	ann := vm.GetAnnotations()
	if ann == nil {
		ann = map[string]string{}
	}
	var ipv4Parts []string
	for _, iface := range ifaces {
		ipv4Parts = append(ipv4Parts, fmt.Sprintf("%s/%d", iface.Gateway, iface.Prefix))
	}
	if ext != nil {
		ipv4Parts = append(ipv4Parts, ext.PrimaryCIDR)
	}
	if len(ipv4Parts) > 0 {
		ann["kmc.ianunruh.com/ipv4"] = strings.Join(ipv4Parts, ",")
	}
	vm.SetAnnotations(ann)
	// Also template annotations
	_ = unstructured.SetNestedStringMap(vm.Object, ann, "spec", "template", "metadata", "annotations")

	return r.Patch(ctx, vm, client.MergeFrom(before))
}

// multusIfaceName builds a DNS1123-ish interface name from a VPC name.
func multusIfaceName(vpc string) string {
	vpc = strings.ToLower(strings.TrimSpace(vpc))
	// KubeVirt interface names: alphanumeric
	vpc = strings.ReplaceAll(vpc, "-", "")
	if len(vpc) > 20 {
		vpc = vpc[:20]
	}
	if vpc == "" {
		vpc = "vpc"
	}
	return "m" + vpc
}

func (r *RouterReconciler) deleteRouterAppliance(ctx context.Context, obj *kmcv1alpha1.Router) error {
	vm := newVMUnstructured(obj.Namespace, obj.Name)
	if err := r.Delete(ctx, vm); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	sec := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
		Name:      rt.CloudInitSecretName(obj.Name),
		Namespace: obj.Namespace,
	}}
	if err := r.Delete(ctx, sec); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

func vmPrintableStatus(vm *unstructured.Unstructured) string {
	if vm == nil {
		return ""
	}
	s, _, _ := unstructured.NestedString(vm.Object, "status", "printableStatus")
	return s
}

func vmIsReady(vm *unstructured.Unstructured) bool {
	if vm == nil {
		return false
	}
	ready, found, _ := unstructured.NestedBool(vm.Object, "status", "ready")
	return found && ready
}

// --- cloud-init ---

type routerCloudInitInput struct {
	SSHPublicKeys   []string
	KnownMultusMACs []string
	PodCIDRs        []string
	ServiceCIDRs    []string
	Namespace       string
	PolicyConfigMap string
	APIServer       string
	CAData          string // base64
	AgentToken      string
	AgentScript     string
}

func buildRouterCloudInit(in routerCloudInitInput) string {
	knownMacs := make([]string, 0, len(in.KnownMultusMACs))
	for _, m := range in.KnownMultusMACs {
		if t := strings.TrimSpace(strings.ToLower(m)); t != "" {
			knownMacs = append(knownMacs, t)
		}
	}
	clusterCIDRs := append([]string{}, in.PodCIDRs...)
	clusterCIDRs = append(clusterCIDRs, in.ServiceCIDRs...)

	setupScript := strings.Join([]string{
		"#!/bin/bash",
		"set -euo pipefail",
		fmt.Sprintf(`KNOWN_MACS="%s"`, strings.Join(knownMacs, " ")),
		fmt.Sprintf(`CLUSTER_CIDRS="%s"`, strings.Join(clusterCIDRs, " ")),
		`is_known_mac() {`,
		`  local iface="$1" mac`,
		`  [[ -f "/sys/class/net/${iface}/address" ]] || return 1`,
		`  mac=$(tr "[:upper:]" "[:lower:]" < "/sys/class/net/${iface}/address")`,
		`  for m in $KNOWN_MACS; do [[ "$mac" == "$m" ]] && return 0; done`,
		`  return 1`,
		`}`,
		`POD_IF=""`,
		`for path in /sys/class/net/*; do`,
		`  iface=$(basename "$path")`,
		`  [[ "$iface" == "lo" ]] && continue`,
		`  if is_known_mac "$iface"; then continue; fi`,
		`  POD_IF="$iface"`,
		`  break`,
		`done`,
		`if [[ -z "$POD_IF" ]]; then`,
		`  for path in /sys/class/net/en*; do`,
		`    [[ -e "$path" ]] || continue`,
		`    POD_IF=$(basename "$path")`,
		`    break`,
		`  done`,
		`fi`,
		`if [[ -z "$POD_IF" ]]; then`,
		`  echo "kmc-router: pod NIC not found" >&2`,
		`  exit 1`,
		`fi`,
		`sysctl -w net.ipv4.ip_forward=1 >/dev/null`,
		`sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null || true`,
		`sysctl -w "net.ipv4.conf.${POD_IF}.rp_filter=2" >/dev/null || true`,
		`for i in $(seq 1 60); do`,
		`  if ip -4 -o addr show dev "$POD_IF" | grep -q "inet "; then break; fi`,
		`  command -v dhclient >/dev/null 2>&1 && dhclient -1 "$POD_IF" 2>/dev/null || true`,
		`  sleep 2`,
		`done`,
		`ip route del default dev "$POD_IF" 2>/dev/null || true`,
		`POD_GW=$(ip -4 route show dev "$POD_IF" 2>/dev/null | awk '/^default/ {print $3; exit}')`,
		`if [[ -z "${POD_GW:-}" ]]; then POD_GW=10.0.2.1; fi`,
		`for cidr in $CLUSTER_CIDRS; do`,
		`  ip route replace "$cidr" via "$POD_GW" dev "$POD_IF" || true`,
		`done`,
		`iptables -C FORWARD -i "$POD_IF" -j DROP 2>/dev/null || iptables -I FORWARD 1 -i "$POD_IF" -j DROP`,
		`iptables -C FORWARD -o "$POD_IF" -j DROP 2>/dev/null || iptables -I FORWARD 1 -o "$POD_IF" -j DROP`,
		`mkdir -p /var/lib/kmc/dnsmasq.d /etc/dnsmasq.d`,
		`systemctl disable --now systemd-resolved 2>/dev/null || true`,
		`rm -f /etc/resolv.conf`,
		`echo 'nameserver 1.1.1.1' > /etc/resolv.conf`,
		`systemctl enable dnsmasq 2>/dev/null || true`,
		`systemctl restart dnsmasq 2>/dev/null || systemctl start dnsmasq 2>/dev/null || true`,
	}, "\n")

	caB64 := strings.ReplaceAll(in.CAData, " ", "")
	caB64 = strings.ReplaceAll(caB64, "\n", "")

	kubeconfig := strings.Join([]string{
		"apiVersion: v1",
		"kind: Config",
		"clusters:",
		"- cluster:",
		"    certificate-authority: /etc/kmc/ca.crt",
		fmt.Sprintf("    server: %s", strings.TrimRight(in.APIServer, "/")),
		"  name: cluster",
		"contexts:",
		"- context:",
		"    cluster: cluster",
		fmt.Sprintf("    namespace: %s", in.Namespace),
		"    user: agent",
		"  name: agent",
		"current-context: agent",
		"users:",
		"- name: agent",
		"  user:",
		fmt.Sprintf("    token: %s", strings.TrimSpace(in.AgentToken)),
	}, "\n")

	envFile := strings.Join([]string{
		fmt.Sprintf("KMC_NAMESPACE=%s", in.Namespace),
		fmt.Sprintf("KMC_POLICY_CM=%s", in.PolicyConfigMap),
		fmt.Sprintf("KMC_APISERVER=%s", strings.TrimRight(in.APIServer, "/")),
		"KUBECONFIG=/etc/kmc/kubeconfig",
		"KMC_CA_FILE=/etc/kmc/ca.crt",
		"KMC_AGENT_PATH=/usr/local/sbin/kmc-router-agent",
		"KMC_ENV_FILE=/etc/kmc/router-agent.env",
		"KMC_POLICY_KEY=policy.json",
		"KMC_AGENT_KEY=agent.py",
		"KMC_HEARTBEAT_SECONDS=30",
		"KMC_RESYNC_SECONDS=300",
	}, "\n")

	keys := make([]string, 0, len(in.SSHPublicKeys))
	for _, k := range in.SSHPublicKeys {
		if t := strings.TrimSpace(k); t != "" {
			keys = append(keys, t)
		}
	}

	script := in.AgentScript
	if !strings.HasSuffix(script, "\n") {
		script += "\n"
	}

	var b strings.Builder
	b.WriteString("#cloud-config\n")
	b.WriteString("users:\n  - default\n")
	b.WriteString("ssh_authorized_keys:\n")
	for _, k := range keys {
		b.WriteString("  - ")
		b.WriteString(k)
		b.WriteByte('\n')
	}
	b.WriteString("package_update: true\n")
	b.WriteString("packages:\n")
	for _, p := range []string{"qemu-guest-agent", "python3", "iptables", "dnsmasq", "iputils-arping", "traceroute"} {
		b.WriteString("  - ")
		b.WriteString(p)
		b.WriteByte('\n')
	}
	b.WriteString("write_files:\n")
	b.WriteString("  - path: /etc/sysctl.d/99-kmc-router.conf\n")
	b.WriteString("    content: |\n")
	b.WriteString("      net.ipv4.ip_forward=1\n")
	b.WriteString("      net.ipv4.conf.all.rp_filter=2\n")
	writeFileLiteral(&b, "/etc/kmc/ca.crt.b64", caB64)
	writeFileLiteral(&b, "/etc/kmc/kubeconfig", kubeconfig)
	writeFileLiteral(&b, "/etc/kmc/router-agent.env", envFile)
	writeFileLiteral(&b, "/usr/local/sbin/kmc-router-agent", script)
	writeFileLiteral(&b, "/var/lib/cloud/scripts/per-boot/kmc-router-setup.sh", setupScript)
	b.WriteString("runcmd:\n")
	b.WriteString("  - [ bash, -c, \"base64 -d /etc/kmc/ca.crt.b64 > /etc/kmc/ca.crt\" ]\n")
	b.WriteString("  - [ chmod, \"+x\", /usr/local/sbin/kmc-router-agent ]\n")
	b.WriteString("  - [ chmod, \"+x\", /var/lib/cloud/scripts/per-boot/kmc-router-setup.sh ]\n")
	b.WriteString("  - [ /var/lib/cloud/scripts/per-boot/kmc-router-setup.sh ]\n")
	b.WriteString("  - [ bash, -c, \"systemctl enable --now qemu-guest-agent 2>/dev/null || true\" ]\n")
	// systemd unit for agent
	b.WriteString("  - [ bash, -c, \"cat >/etc/systemd/system/kmc-router-agent.service <<'UNIT'\\n[Unit]\\nDescription=kmc router agent\\nAfter=network-online.target\\nWants=network-online.target\\n[Service]\\nEnvironmentFile=/etc/kmc/router-agent.env\\nExecStart=/usr/bin/python3 /usr/local/sbin/kmc-router-agent\\nRestart=always\\nRestartSec=5\\n[Install]\\nWantedBy=multi-user.target\\nUNIT\\nsystemctl daemon-reload\\nsystemctl enable --now kmc-router-agent\" ]\n")
	return b.String()
}

func writeFileLiteral(b *strings.Builder, path, content string) {
	perm := "0644"
	if strings.HasSuffix(path, "kmc-router-agent") || strings.HasSuffix(path, ".sh") {
		perm = "0755"
	}
	b.WriteString("  - path: ")
	b.WriteString(path)
	b.WriteString("\n    permissions: \"")
	b.WriteString(perm)
	b.WriteString("\"\n    content: |\n")
	for _, line := range strings.Split(content, "\n") {
		b.WriteString("      ")
		b.WriteString(line)
		b.WriteByte('\n')
	}
}
