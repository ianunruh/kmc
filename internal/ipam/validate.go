package ipam

import (
	"fmt"
	"net"
	"strings"
)

// ValidateIPv4Address checks that s is a dotted-quad IPv4 address (not a CIDR).
func ValidateIPv4Address(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return fmt.Errorf("address is required")
	}
	if strings.Contains(s, "/") {
		return fmt.Errorf("address must not include a prefix (got %q)", s)
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return fmt.Errorf("invalid IP address %q", s)
	}
	v4 := ip.To4()
	if v4 == nil {
		return fmt.Errorf("address must be IPv4 (got %q)", s)
	}
	// Require canonical dotted-quad form (rejects IPv4-mapped IPv6 strings, etc.).
	if v4.String() != s {
		return fmt.Errorf("address must be canonical IPv4 form %q (got %q)", v4.String(), s)
	}
	return nil
}

// ValidatePrefixLength checks that prefix is a valid IPv4 CIDR length.
func ValidatePrefixLength(prefix int32) error {
	if prefix < 0 || prefix > 32 {
		return fmt.Errorf("prefixLength must be between 0 and 32 (got %d)", prefix)
	}
	return nil
}

// AddressObjectName returns the recommended IPAddress metadata.name for an IPv4 address.
func AddressObjectName(address string) string {
	return strings.ReplaceAll(strings.TrimSpace(address), ".", "-")
}
