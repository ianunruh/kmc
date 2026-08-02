// Package router holds pure helpers for shared-router policy documents and naming.
package router

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// PolicyAPIVersion and PolicyKind match the console RouterPolicyDoc contract.
const (
	PolicyAPIVersion = "kmc.ianunruh.com/v1alpha1"
	PolicyKind       = "RouterPolicy"

	// ConfigMapNamePrefix is used as kmc-router-<name>.
	ConfigMapNamePrefix = "kmc-router-"
	// ServiceAccountNamePrefix is used as kmc-router-<name>.
	ServiceAccountNamePrefix = "kmc-router-"
	// RoleNamePrefix is used as kmc-router-<name>.
	RoleNamePrefix = "kmc-router-"

	DefaultDHCPLeaseTime = "12h"
	ParentDNSDomain      = "vpc.local"
)

// PolicyDoc is the JSON document stored in the router policy ConfigMap (policy.json).
// Shape matches console RouterPolicyDoc so the same in-guest agent can apply it.
type PolicyDoc struct {
	APIVersion  string           `json:"apiVersion"`
	Kind        string           `json:"kind"`
	Metadata    PolicyMetadata   `json:"metadata"`
	Interfaces  []PolicyInterface `json:"interfaces"`
	External    *PolicyExternal  `json:"external"`
	Leases      []PolicyLease    `json:"leases"`
	FloatingIPs []PolicyFloatingIP `json:"floatingIPs"`
	PortForwards []PolicyPortForward `json:"portForwards"`
}

// PolicyMetadata is embedded in policy.json (not Kubernetes metadata).
type PolicyMetadata struct {
	Name       string `json:"name"`
	Namespace  string `json:"namespace"`
	Generation int64  `json:"generation"`
}

// PolicyInterface is one private VPC attachment.
type PolicyInterface struct {
	VPC     string     `json:"vpc"`
	CIDR    string     `json:"cidr"`
	Gateway string     `json:"gateway"`
	MAC     string     `json:"mac"`
	Domain  string     `json:"domain"`
	DHCP    PolicyDHCP `json:"dhcp"`
}

// PolicyDHCP configures dnsmasq for an interface.
type PolicyDHCP struct {
	Enabled       bool   `json:"enabled"`
	LeaseTime     string `json:"leaseTime"`
	Authoritative bool   `json:"authoritative,omitempty"`
}

// PolicyExternal is the optional public Multus gateway.
type PolicyExternal struct {
	MultusNetwork string `json:"multusNetwork"`
	PrimaryCIDR   string `json:"primaryCidr,omitempty"`
	Gateway       string `json:"gateway,omitempty"`
	MAC           string `json:"mac,omitempty"`
	SNAT          bool   `json:"snat,omitempty"`
}

// PolicyLease is a static DHCP lease (projected from IPAddress).
type PolicyLease struct {
	VPC      string `json:"vpc"`
	MAC      string `json:"mac"`
	IP       string `json:"ip"`
	Hostname string `json:"hostname"`
	VM       string `json:"vm,omitempty"`
}

// PolicyFloatingIP is a 1:1 public↔private mapping.
type PolicyFloatingIP struct {
	ID       string `json:"id"`
	Public   string `json:"public"`
	Prefix   int    `json:"prefix"`
	Private  string `json:"private,omitempty"`
	TargetVM string `json:"targetVm,omitempty"`
	VPC      string `json:"vpc,omitempty"`
	Protocol string `json:"protocol,omitempty"`
}

// PolicyPortForward is a port-level DNAT rule.
type PolicyPortForward struct {
	ID         string `json:"id"`
	Public     string `json:"public"`
	PublicPort int32  `json:"publicPort"`
	Private    string `json:"private"`
	PrivatePort int32 `json:"privatePort"`
	Protocol   string `json:"protocol"`
	TargetVM   string `json:"targetVm,omitempty"`
	VPC        string `json:"vpc,omitempty"`
}

// ConfigMapName returns the policy ConfigMap name for a router.
func ConfigMapName(routerName string) string {
	return ConfigMapNamePrefix + strings.TrimSpace(routerName)
}

// ServiceAccountName returns the agent ServiceAccount name.
func ServiceAccountName(routerName string) string {
	return ServiceAccountNamePrefix + strings.TrimSpace(routerName)
}

// RoleName returns the agent Role / RoleBinding name.
func RoleName(routerName string) string {
	return RoleNamePrefix + strings.TrimSpace(routerName)
}

// CloudInitSecretName returns the cloud-init user-data Secret name.
func CloudInitSecretName(routerName string) string {
	return strings.TrimSpace(routerName) + "-cloudinit"
}

// DefaultDomain returns the DHCP/DNS zone for a VPC (console parity).
func DefaultDomain(vpcName string) string {
	return strings.TrimSpace(vpcName) + "." + ParentDNSDomain
}

// EmptyPolicyDoc returns a minimal policy document.
func EmptyPolicyDoc(routerName, namespace string) PolicyDoc {
	return PolicyDoc{
		APIVersion: PolicyAPIVersion,
		Kind:       PolicyKind,
		Metadata: PolicyMetadata{
			Name:       strings.TrimSpace(routerName),
			Namespace:  strings.TrimSpace(namespace),
			Generation: 1,
		},
		Interfaces:   []PolicyInterface{},
		External:     nil,
		Leases:       []PolicyLease{},
		FloatingIPs:  []PolicyFloatingIP{},
		PortForwards: []PolicyPortForward{},
	}
}

// ParsePolicyDoc unmarshals policy.json; returns nil, nil when raw is empty.
func ParsePolicyDoc(raw string) (*PolicyDoc, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var doc PolicyDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return nil, fmt.Errorf("parse policy.json: %w", err)
	}
	if doc.APIVersion == "" {
		doc.APIVersion = PolicyAPIVersion
	}
	if doc.Kind == "" {
		doc.Kind = PolicyKind
	}
	if doc.Interfaces == nil {
		doc.Interfaces = []PolicyInterface{}
	}
	if doc.Leases == nil {
		doc.Leases = []PolicyLease{}
	}
	if doc.FloatingIPs == nil {
		doc.FloatingIPs = []PolicyFloatingIP{}
	}
	if doc.PortForwards == nil {
		doc.PortForwards = []PolicyPortForward{}
	}
	return &doc, nil
}

// MarshalPolicyDoc returns pretty-printed JSON (console uses 2-space indent).
// Empty lists are emitted as [] (never null) so re-parse + re-render is stable.
// Projected list fields are sorted for deterministic generation fingerprints.
func MarshalPolicyDoc(doc *PolicyDoc) (string, error) {
	if doc == nil {
		return "", fmt.Errorf("policy doc is nil")
	}
	normalizePolicySlices(doc)
	sortPolicyLists(doc)
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", err
	}
	return string(b) + "\n", nil
}

// normalizePolicySlices ensures list fields are non-nil so JSON uses [] not null.
func normalizePolicySlices(doc *PolicyDoc) {
	if doc == nil {
		return
	}
	if doc.Interfaces == nil {
		doc.Interfaces = []PolicyInterface{}
	}
	if doc.Leases == nil {
		doc.Leases = []PolicyLease{}
	}
	if doc.FloatingIPs == nil {
		doc.FloatingIPs = []PolicyFloatingIP{}
	}
	if doc.PortForwards == nil {
		doc.PortForwards = []PolicyPortForward{}
	}
}

// PortForwardID builds a stable id for a port-forward rule.
func PortForwardID(publicAddr, protocol string, publicPort int32) string {
	return fmt.Sprintf("%s-%s-%d", strings.TrimSpace(publicAddr), strings.ToLower(strings.TrimSpace(protocol)), publicPort)
}

// FloatingIPID builds a stable id for a floating IP entry (public address).
func FloatingIPID(publicAddr string) string {
	return strings.TrimSpace(publicAddr)
}

// DefaultDHCP returns the console-default DHCP block for an interface.
func DefaultDHCP() PolicyDHCP {
	return PolicyDHCP{
		Enabled:       true,
		LeaseTime:     DefaultDHCPLeaseTime,
		Authoritative: true,
	}
}

// PolicyEqualDesired compares control-plane-owned sections (ignores generation).
// Used to decide whether to bump policy generation.
//
// Normalizes nil vs empty slices and sorts projected list fields so apiserver
// List order cannot look like a desired change (which races generation upward:
// ConfigMap write → agent apply → annotation watch → reconcile → bump).
func PolicyEqualDesired(a, b *PolicyDoc) bool {
	if a == nil || b == nil {
		return a == b
	}
	ac := *a
	bc := *b
	ac.Metadata.Generation = 0
	bc.Metadata.Generation = 0
	normalizePolicySlices(&ac)
	normalizePolicySlices(&bc)
	// Defensive: compare in sorted order even if a caller forgot to sort on write.
	sortPolicyLists(&ac)
	sortPolicyLists(&bc)
	aj, _ := json.Marshal(ac)
	bj, _ := json.Marshal(bc)
	return string(aj) == string(bj)
}

// sortPolicyLists sorts leases / floatingIPs / portForwards for stable compare.
func sortPolicyLists(doc *PolicyDoc) {
	if doc == nil {
		return
	}
	if len(doc.Leases) > 1 {
		sort.Slice(doc.Leases, func(i, j int) bool {
			if doc.Leases[i].VPC != doc.Leases[j].VPC {
				return doc.Leases[i].VPC < doc.Leases[j].VPC
			}
			if doc.Leases[i].IP != doc.Leases[j].IP {
				return doc.Leases[i].IP < doc.Leases[j].IP
			}
			return doc.Leases[i].MAC < doc.Leases[j].MAC
		})
	}
	if len(doc.FloatingIPs) > 1 {
		sort.Slice(doc.FloatingIPs, func(i, j int) bool {
			return doc.FloatingIPs[i].Public < doc.FloatingIPs[j].Public
		})
	}
	if len(doc.PortForwards) > 1 {
		sort.Slice(doc.PortForwards, func(i, j int) bool {
			return doc.PortForwards[i].ID < doc.PortForwards[j].ID
		})
	}
}
