package router

import "testing"

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
