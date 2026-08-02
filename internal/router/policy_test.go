package router

import (
	"strings"
	"testing"
)

func TestPolicyRoundTrip(t *testing.T) {
	doc := EmptyPolicyDoc("shared", "default")
	doc.Interfaces = []PolicyInterface{{
		VPC: "app-net", CIDR: "10.40.1.0/24", Gateway: "10.40.1.1",
		MAC: "02:00:00:00:00:01", Domain: DefaultDomain("app-net"), DHCP: DefaultDHCP(),
	}}
	raw, err := MarshalPolicyDoc(&doc)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParsePolicyDoc(raw)
	if err != nil || parsed == nil {
		t.Fatalf("parse: %v", err)
	}
	if len(parsed.Interfaces) != 1 || parsed.Interfaces[0].Gateway != "10.40.1.1" {
		t.Fatalf("%+v", parsed.Interfaces)
	}
}

func TestConfigMapName(t *testing.T) {
	if ConfigMapName("shared") != "kmc-router-shared" {
		t.Fatal(ConfigMapName("shared"))
	}
}

// Regression: projected list order from apiserver List is not stable. Equality
// must ignore order so generation does not race upward every reconcile.
func TestPolicyEqualDesiredListOrder(t *testing.T) {
	a := EmptyPolicyDoc("r", "ns")
	a.Metadata.Generation = 10
	a.Leases = []PolicyLease{
		{VPC: "v", MAC: "aa", IP: "10.0.0.2", Hostname: "b", VM: "b"},
		{VPC: "v", MAC: "bb", IP: "10.0.0.3", Hostname: "a", VM: "a"},
	}
	a.FloatingIPs = []PolicyFloatingIP{
		{ID: "10.0.0.20", Public: "10.0.0.20", Prefix: 24, VPC: "v"},
		{ID: "10.0.0.10", Public: "10.0.0.10", Prefix: 24, Private: "10.0.0.2", VPC: "v"},
	}
	a.PortForwards = []PolicyPortForward{
		{ID: "10.0.0.20-tcp-22", Public: "10.0.0.20", PublicPort: 22, Private: "10.0.0.3", PrivatePort: 22, Protocol: "TCP"},
		{ID: "10.0.0.20-tcp-80", Public: "10.0.0.20", PublicPort: 80, Private: "10.0.0.3", PrivatePort: 80, Protocol: "TCP"},
	}

	b := EmptyPolicyDoc("r", "ns")
	b.Metadata.Generation = 99
	// Reverse order of every projected list.
	b.Leases = []PolicyLease{a.Leases[1], a.Leases[0]}
	b.FloatingIPs = []PolicyFloatingIP{a.FloatingIPs[1], a.FloatingIPs[0]}
	b.PortForwards = []PolicyPortForward{a.PortForwards[1], a.PortForwards[0]}

	if !PolicyEqualDesired(&a, &b) {
		t.Fatal("list order must not affect PolicyEqualDesired")
	}

	// Marshal must emit a stable sorted order so re-parse stays equal.
	rawA, err := MarshalPolicyDoc(&a)
	if err != nil {
		t.Fatal(err)
	}
	rawB, err := MarshalPolicyDoc(&b)
	if err != nil {
		t.Fatal(err)
	}
	// Generations differ in input; zero them by re-parse compare of desired fields.
	pa, err := ParsePolicyDoc(rawA)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := ParsePolicyDoc(rawB)
	if err != nil {
		t.Fatal(err)
	}
	if !PolicyEqualDesired(pa, pb) {
		t.Fatal("marshal of reordered docs should produce equal desired content")
	}
	// Sorted lease order in JSON (IP ascending).
	if !strings.Contains(rawA, `"ip": "10.0.0.2"`) || !strings.Contains(rawA, `"ip": "10.0.0.3"`) {
		t.Fatalf("unexpected leases in marshal:\n%s", rawA)
	}
	idx2 := strings.Index(rawA, `"ip": "10.0.0.2"`)
	idx3 := strings.Index(rawA, `"ip": "10.0.0.3"`)
	if idx2 < 0 || idx3 < 0 || idx2 > idx3 {
		t.Fatalf("leases not sorted by IP in marshal:\n%s", rawA)
	}
}

// Regression: empty projected lists are nil in Go; stored policy uses [] after
// parse. Equality must treat those as the same so policy generation stays put.
func TestPolicyEqualDesiredNilVsEmptySlices(t *testing.T) {
	a := EmptyPolicyDoc("r", "ns")
	a.Metadata.Generation = 5
	a.Interfaces = []PolicyInterface{{
		VPC: "v", CIDR: "10.0.0.0/24", Gateway: "10.0.0.1",
		MAC: "02:00:00:00:00:01", Domain: "v.vpc.local", DHCP: DefaultDHCP(),
	}}
	a.External = &PolicyExternal{
		MultusNetwork: "external",
		PrimaryCIDR:   "10.30.0.2/24",
		Gateway:       "10.30.0.1",
		MAC:           "02:00:00:00:00:02",
		SNAT:          true,
	}
	// Simulate re-render: nil projected lists (json null) vs parse-normalized [].
	b := a
	b.Metadata.Generation = 999
	b.Leases = nil
	b.FloatingIPs = nil
	b.PortForwards = nil

	if !PolicyEqualDesired(&a, &b) {
		t.Fatal("nil vs empty list fields should be equal (ignoring generation)")
	}

	raw, err := MarshalPolicyDoc(&b)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, `"leases": null`) ||
		strings.Contains(raw, `"floatingIPs": null`) ||
		strings.Contains(raw, `"portForwards": null`) {
		t.Fatalf("marshal should emit empty arrays, got:\n%s", raw)
	}
	parsed, err := ParsePolicyDoc(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !PolicyEqualDesired(&a, parsed) {
		t.Fatal("round-trip through marshal/parse should remain equal")
	}
}
