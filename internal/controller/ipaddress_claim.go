package controller

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/ipam"
)

const maxIPAddressAllocateAttempts = 64

// listUsedAddressesByPool returns every IPAddress.spec.address that references
// the given poolRef (cluster-wide). Used by FloatingIP, Router, and future guest IPAM.
func listUsedAddressesByPool(ctx context.Context, c client.Client, poolKind, poolName string) (map[string]struct{}, error) {
	used := make(map[string]struct{})
	var list kmcv1alpha1.IPAddressList
	if err := c.List(ctx, &list); err != nil {
		return nil, err
	}
	for i := range list.Items {
		ip := &list.Items[i]
		if ip.Spec.PoolRef.Kind != poolKind || ip.Spec.PoolRef.Name != poolName {
			continue
		}
		if addr := strings.TrimSpace(ip.Spec.Address); addr != "" {
			used[addr] = struct{}{}
		}
	}
	return used, nil
}

// claimedByFunc reports whether an existing IPAddress is already owned by the caller.
type claimedByFunc func(*kmcv1alpha1.IPAddress) bool

// createClaimFunc creates an IPAddress lease for address/prefix.
// Should return apierrors.IsAlreadyExists on name conflict.
type createClaimFunc func(ctx context.Context, address string, prefix int32) error

// allocateIPAddressFromWindow picks preferred (if set) or FirstFree and creates
// the claim. Create-race is HTTP 409 on the address-derived object name.
// isOurs allows reclaiming an address already owned by the parent object.
func allocateIPAddressFromWindow(
	ctx context.Context,
	c client.Client,
	namespace string,
	window *ipam.PoolWindow,
	poolKind, poolName string,
	preferred string,
	used map[string]struct{},
	isOurs claimedByFunc,
	create createClaimFunc,
) (address string, prefix int32, err error) {
	if window == nil {
		return "", 0, fmt.Errorf("pool window is required")
	}
	prefix = window.PrefixLength()
	if used == nil {
		used = make(map[string]struct{})
	}

	preferred = strings.TrimSpace(preferred)
	if preferred != "" {
		if err := ipam.ValidateIPv4Address(preferred); err != nil {
			return "", 0, err
		}
		if !window.Contains(preferred) {
			return "", 0, fmt.Errorf("address %s is outside pool %s/%s", preferred, poolKind, poolName)
		}
		name := ipam.AddressObjectName(preferred)
		var existing kmcv1alpha1.IPAddress
		if getErr := c.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &existing); getErr == nil {
			if isOurs != nil && isOurs(&existing) {
				return preferred, existing.Spec.PrefixLength, nil
			}
			return "", 0, fmt.Errorf("address %s is already claimed", preferred)
		} else if !apierrors.IsNotFound(getErr) {
			return "", 0, getErr
		}
		if _, taken := used[preferred]; taken {
			return "", 0, fmt.Errorf("address %s is already claimed", preferred)
		}
		if err := create(ctx, preferred, prefix); err != nil {
			if apierrors.IsAlreadyExists(err) {
				var existing kmcv1alpha1.IPAddress
				if getErr := c.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &existing); getErr == nil &&
					isOurs != nil && isOurs(&existing) {
					return preferred, existing.Spec.PrefixLength, nil
				}
				return "", 0, fmt.Errorf("address %s is already claimed", preferred)
			}
			return "", 0, err
		}
		return preferred, prefix, nil
	}

	for i := 0; i < maxIPAddressAllocateAttempts; i++ {
		free, ok := window.FirstFree(used)
		if !ok {
			return "", 0, fmt.Errorf("%s %q exhausted", poolKind, poolName)
		}
		if err := create(ctx, free, prefix); err != nil {
			if apierrors.IsAlreadyExists(err) {
				used[free] = struct{}{}
				// Already ours?
				name := ipam.AddressObjectName(free)
				var existing kmcv1alpha1.IPAddress
				if getErr := c.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &existing); getErr == nil &&
					isOurs != nil && isOurs(&existing) {
					return free, existing.Spec.PrefixLength, nil
				}
				continue
			}
			return "", 0, err
		}
		return free, prefix, nil
	}
	return "", 0, fmt.Errorf("%s %q: could not allocate after conflicts", poolKind, poolName)
}
