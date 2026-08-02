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
