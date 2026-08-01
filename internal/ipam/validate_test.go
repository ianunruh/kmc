package ipam

import "testing"

func TestValidateIPv4Address(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in      string
		wantErr bool
	}{
		{"10.40.1.20", false},
		{"0.0.0.0", false},
		{"255.255.255.255", false},
		{"", true},
		{"10.40.1.20/24", true},
		{"not-an-ip", true},
		{"2001:db8::1", true},
		{" 10.40.1.20 ", false},
	}
	for _, tc := range cases {
		err := ValidateIPv4Address(tc.in)
		if tc.wantErr && err == nil {
			t.Errorf("ValidateIPv4Address(%q) = nil, want error", tc.in)
		}
		if !tc.wantErr && err != nil {
			t.Errorf("ValidateIPv4Address(%q) = %v, want nil", tc.in, err)
		}
	}
}

func TestValidatePrefixLength(t *testing.T) {
	t.Parallel()
	if err := ValidatePrefixLength(24); err != nil {
		t.Fatal(err)
	}
	if err := ValidatePrefixLength(-1); err == nil {
		t.Fatal("expected error for -1")
	}
	if err := ValidatePrefixLength(33); err == nil {
		t.Fatal("expected error for 33")
	}
}

func TestAddressObjectName(t *testing.T) {
	t.Parallel()
	if got := AddressObjectName("10.40.1.20"); got != "10-40-1-20" {
		t.Fatalf("got %q", got)
	}
}

func TestValidateVLANRange(t *testing.T) {
	t.Parallel()
	if err := ValidateVLANRange(3000, 3100); err != nil {
		t.Fatal(err)
	}
	if err := ValidateVLANRange(0, 10); err == nil {
		t.Fatal("expected error for start 0")
	}
	if err := ValidateVLANRange(100, 50); err == nil {
		t.Fatal("expected error for start > end")
	}
}

func TestValidateVLANExclude(t *testing.T) {
	t.Parallel()
	if err := ValidateVLANExclude(3000, 3100, []int32{3000, 3050}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateVLANExclude(3000, 3100, []int32{2999}); err == nil {
		t.Fatal("expected error for out-of-range exclude")
	}
}

func TestFirstFreeVLAN(t *testing.T) {
	t.Parallel()
	used := map[int32]struct{}{3000: {}, 3001: {}}
	v, ok := FirstFreeVLAN(3000, 3100, used)
	if !ok || v != 3002 {
		t.Fatalf("got %d ok=%v", v, ok)
	}
	full := map[int32]struct{}{1: {}, 2: {}}
	if _, ok := FirstFreeVLAN(1, 2, full); ok {
		t.Fatal("expected exhausted")
	}
}

func TestValidateIPv4CIDR(t *testing.T) {
	t.Parallel()
	if err := ValidateIPv4CIDR("10.40.1.0/24"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateIPv4CIDR("not-a-cidr"); err == nil {
		t.Fatal("expected error")
	}
	net, err := ParseIPv4CIDR("10.40.1.0/24")
	if err != nil {
		t.Fatal(err)
	}
	if !ContainsIPv4(net, "10.40.1.10") {
		t.Fatal("expected contains")
	}
	if ContainsIPv4(net, "10.41.0.1") {
		t.Fatal("expected not contains")
	}
}

func TestValidatePortAndProtocol(t *testing.T) {
	t.Parallel()
	if err := ValidatePort(80); err != nil {
		t.Fatal(err)
	}
	if err := ValidatePort(0); err == nil {
		t.Fatal("expected error")
	}
	if err := ValidateProtocolTCPUDP("tcp"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateProtocolTCPUDP("SCTP"); err == nil {
		t.Fatal("expected error")
	}
}
