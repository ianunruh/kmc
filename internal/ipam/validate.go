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

// ValidateVLANID checks that vlan is a usable 802.1Q id (1–4094).
func ValidateVLANID(vlan int32) error {
	if vlan < 1 || vlan > 4094 {
		return fmt.Errorf("vlan must be between 1 and 4094 (got %d)", vlan)
	}
	return nil
}

// ValidateVLANRange checks an inclusive VLAN pool range.
func ValidateVLANRange(start, end int32) error {
	if err := ValidateVLANID(start); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	if err := ValidateVLANID(end); err != nil {
		return fmt.Errorf("end: %w", err)
	}
	if start > end {
		return fmt.Errorf("start (%d) must be <= end (%d)", start, end)
	}
	return nil
}

// ValidateVLANExclude checks exclude ids sit inside [start, end].
func ValidateVLANExclude(start, end int32, exclude []int32) error {
	for _, v := range exclude {
		if v < start || v > end {
			return fmt.Errorf("exclude vlan %d is outside pool range %d–%d", v, start, end)
		}
	}
	return nil
}

// FirstFreeVLAN returns the lowest free VLAN in [start, end] not in used.
func FirstFreeVLAN(start, end int32, used map[int32]struct{}) (int32, bool) {
	for v := start; v <= end; v++ {
		if _, ok := used[v]; !ok {
			return v, true
		}
	}
	return 0, false
}

// ParseIPv4CIDR parses an IPv4 CIDR (e.g. 10.40.1.0/24).
func ParseIPv4CIDR(s string) (*net.IPNet, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("cidr is required")
	}
	ip, network, err := net.ParseCIDR(s)
	if err != nil {
		return nil, fmt.Errorf("invalid cidr %q: %w", s, err)
	}
	if ip.To4() == nil {
		return nil, fmt.Errorf("cidr must be IPv4 (got %q)", s)
	}
	return network, nil
}

// ValidateIPv4CIDR checks that s is a valid IPv4 CIDR.
func ValidateIPv4CIDR(s string) error {
	_, err := ParseIPv4CIDR(s)
	return err
}

// ContainsIPv4 reports whether address is inside network.
func ContainsIPv4(network *net.IPNet, address string) bool {
	ip := net.ParseIP(strings.TrimSpace(address))
	if ip == nil || ip.To4() == nil || network == nil {
		return false
	}
	return network.Contains(ip)
}

// ValidatePort checks a TCP/UDP port number.
func ValidatePort(port int32) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535 (got %d)", port)
	}
	return nil
}

// ValidateProtocolTCPUDP checks protocol is TCP or UDP (case-insensitive).
func ValidateProtocolTCPUDP(protocol string) error {
	switch strings.ToUpper(strings.TrimSpace(protocol)) {
	case "TCP", "UDP":
		return nil
	default:
		return fmt.Errorf("protocol must be TCP or UDP (got %q)", protocol)
	}
}
