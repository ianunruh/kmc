package ipam

import (
	"crypto/rand"
	"fmt"
	"net"
	"strings"
)

// PoolWindow describes an IPv4 allocation window inside a CIDR.
type PoolWindow struct {
	Network *net.IPNet
	// Inclusive host range (IPv4 as 4-byte). Empty means full usable range.
	Start net.IP
	End   net.IP
	// Addresses never allocated (plus network/broadcast/gateway handled separately).
	Exclude map[string]struct{}
	// Gateway is excluded from allocation when set.
	Gateway string
}

// ParsePoolWindow builds a window from CIDR + optional start/end/exclude/gateway.
func ParsePoolWindow(cidr, gateway, start, end string, exclude []string) (*PoolWindow, error) {
	network, err := ParseIPv4CIDR(cidr)
	if err != nil {
		return nil, err
	}
	w := &PoolWindow{
		Network: network,
		Exclude: make(map[string]struct{}),
	}
	if gw := strings.TrimSpace(gateway); gw != "" {
		if err := ValidateIPv4Address(gw); err != nil {
			return nil, fmt.Errorf("gateway: %w", err)
		}
		if !ContainsIPv4(network, gw) {
			return nil, fmt.Errorf("gateway %s outside %s", gw, cidr)
		}
		w.Gateway = gw
		w.Exclude[gw] = struct{}{}
	}
	for _, ex := range exclude {
		ex = strings.TrimSpace(ex)
		if ex == "" {
			continue
		}
		if err := ValidateIPv4Address(ex); err != nil {
			return nil, fmt.Errorf("exclude %q: %w", ex, err)
		}
		w.Exclude[ex] = struct{}{}
	}
	if s := strings.TrimSpace(start); s != "" {
		if err := ValidateIPv4Address(s); err != nil {
			return nil, fmt.Errorf("start: %w", err)
		}
		if !ContainsIPv4(network, s) {
			return nil, fmt.Errorf("start %s outside %s", s, cidr)
		}
		w.Start = net.ParseIP(s).To4()
	}
	if e := strings.TrimSpace(end); e != "" {
		if err := ValidateIPv4Address(e); err != nil {
			return nil, fmt.Errorf("end: %w", err)
		}
		if !ContainsIPv4(network, e) {
			return nil, fmt.Errorf("end %s outside %s", e, cidr)
		}
		w.End = net.ParseIP(e).To4()
	}
	return w, nil
}

// PrefixLength returns the CIDR prefix length.
func (w *PoolWindow) PrefixLength() int32 {
	ones, _ := w.Network.Mask.Size()
	return int32(ones)
}

// Contains reports whether address is inside the CIDR (not necessarily allocatable).
func (w *PoolWindow) Contains(address string) bool {
	return ContainsIPv4(w.Network, address)
}

// FirstFree returns the lowest allocatable IPv4 not in used.
// used keys are canonical dotted-quad addresses.
func (w *PoolWindow) FirstFree(used map[string]struct{}) (string, bool) {
	ones, bits := w.Network.Mask.Size()
	if bits != 32 {
		return "", false
	}
	ip4 := w.Network.IP.To4()
	if ip4 == nil {
		return "", false
	}
	base := ipToUint32(ip4)
	hostBits := 32 - ones
	var size uint32
	if hostBits >= 32 {
		size = 0xffffffff
	} else {
		size = uint32(1) << uint(hostBits)
	}

	// Usable range: exclude network + broadcast for prefix <= 30.
	var first, last uint32
	if ones <= 30 {
		first = base + 1
		last = base + size - 2
	} else if ones == 31 {
		// /31 point-to-point: both addresses usable (RFC 3021)
		first = base
		last = base + 1
	} else {
		// /32
		first = base
		last = base
	}

	if w.Start != nil {
		s := ipToUint32(w.Start.To4())
		if s > first {
			first = s
		}
	}
	if w.End != nil {
		e := ipToUint32(w.End.To4())
		if e < last {
			last = e
		}
	}
	if first > last {
		return "", false
	}

	for n := first; n <= last; n++ {
		addr := uint32ToIP(n).String()
		if _, ok := w.Exclude[addr]; ok {
			continue
		}
		if _, ok := used[addr]; ok {
			continue
		}
		return addr, true
	}
	return "", false
}

func ipToUint32(ip net.IP) uint32 {
	ip = ip.To4()
	return uint32(ip[0])<<24 | uint32(ip[1])<<16 | uint32(ip[2])<<8 | uint32(ip[3])
}

func uint32ToIP(n uint32) net.IP {
	return net.IPv4(byte(n>>24), byte(n>>16), byte(n>>8), byte(n)).To4()
}

// FirstUsableHost returns the first usable host address in an IPv4 CIDR
// (network+1 for prefix <= 30; matches console default gateway rule).
func FirstUsableHost(cidr string) (string, error) {
	network, err := ParseIPv4CIDR(cidr)
	if err != nil {
		return "", err
	}
	ones, bits := network.Mask.Size()
	if bits != 32 {
		return "", fmt.Errorf("cidr must be IPv4")
	}
	ip4 := network.IP.To4()
	if ip4 == nil {
		return "", fmt.Errorf("cidr must be IPv4")
	}
	base := ipToUint32(ip4)
	var first uint32
	if ones <= 30 {
		first = base + 1
	} else {
		first = base
	}
	return uint32ToIP(first).String(), nil
}

// GenerateLocalMAC returns a locally administered unicast MAC (xx:xx:xx:xx:xx:xx).
func GenerateLocalMAC() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// Unicast (bit0 clear) + locally administered (bit1 set).
	b[0] = (b[0] & 0xfe) | 0x02
	return fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3], b[4], b[5]), nil
}
