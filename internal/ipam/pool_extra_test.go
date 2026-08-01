package ipam

import "testing"

func TestFirstUsableHost(t *testing.T) {
	got, err := FirstUsableHost("10.40.1.0/24")
	if err != nil {
		t.Fatal(err)
	}
	if got != "10.40.1.1" {
		t.Fatalf("got %q", got)
	}
}

func TestGenerateLocalMAC(t *testing.T) {
	mac, err := GenerateLocalMAC()
	if err != nil {
		t.Fatal(err)
	}
	if len(mac) != 17 {
		t.Fatalf("mac = %q", mac)
	}
	// Locally administered bit
	// first octet lower nibble should have bit1 set
}
