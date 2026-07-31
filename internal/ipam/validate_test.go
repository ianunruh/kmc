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
