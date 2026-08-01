package controller

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/router"
	"github.com/ianunruh/kmc/internal/router/agent"
)

// ensureRouterControlPlane creates/updates SA, Role, RoleBinding, and policy ConfigMap.
// It does not mint tokens (that happens when building appliance cloud-init).
func (r *RouterReconciler) ensureRouterControlPlane(ctx context.Context, obj *kmcv1alpha1.Router, doc *router.PolicyDoc) error {
	ns := obj.Namespace
	name := obj.Name
	labels := routerManagedLabels(name)
	saName := router.ServiceAccountName(name)
	roleName := router.RoleName(name)
	cmName := router.ConfigMapName(name)

	// ServiceAccount
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: saName, Namespace: ns},
	}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, sa, func() error {
		sa.Labels = mergeLabels(sa.Labels, labels)
		return controllerutil.SetControllerReference(obj, sa, r.Scheme)
	}); err != nil {
		return fmt.Errorf("serviceaccount: %w", err)
	}

	// Role — get/update/patch the policy CM by name; list/watch configmaps.
	role := &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: ns},
	}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, role, func() error {
		role.Labels = mergeLabels(role.Labels, labels)
		role.Rules = []rbacv1.PolicyRule{
			{
				APIGroups:     []string{""},
				Resources:     []string{"configmaps"},
				ResourceNames: []string{cmName},
				Verbs:         []string{"get", "update", "patch"},
			},
			{
				APIGroups: []string{""},
				Resources: []string{"configmaps"},
				Verbs:     []string{"list", "watch"},
			},
		}
		return controllerutil.SetControllerReference(obj, role, r.Scheme)
	}); err != nil {
		return fmt.Errorf("role: %w", err)
	}

	// RoleBinding
	rb := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: ns},
	}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, rb, func() error {
		rb.Labels = mergeLabels(rb.Labels, labels)
		rb.RoleRef = rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "Role",
			Name:     roleName,
		}
		rb.Subjects = []rbacv1.Subject{{
			Kind:      "ServiceAccount",
			Name:      saName,
			Namespace: ns,
		}}
		return controllerutil.SetControllerReference(obj, rb, r.Scheme)
	}); err != nil {
		return fmt.Errorf("rolebinding: %w", err)
	}

	// Policy ConfigMap
	policyJSON, err := router.MarshalPolicyDoc(doc)
	if err != nil {
		return err
	}
	script := agent.Script
	if !strings.HasSuffix(script, "\n") {
		script += "\n"
	}

	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: cmName, Namespace: ns},
	}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, cm, func() error {
		cm.Labels = mergeLabels(cm.Labels, labels)
		if cm.Annotations == nil {
			cm.Annotations = map[string]string{}
		}
		if _, ok := cm.Annotations[kmcv1alpha1.AnnotationAgentStatus]; !ok {
			cm.Annotations[kmcv1alpha1.AnnotationAgentStatus] = "Pending"
		}
		if cm.Data == nil {
			cm.Data = map[string]string{}
		}
		cm.Data[kmcv1alpha1.RouterPolicyDataKey] = policyJSON
		cm.Data[kmcv1alpha1.RouterAgentScriptKey] = script
		return controllerutil.SetControllerReference(obj, cm, r.Scheme)
	}); err != nil {
		return fmt.Errorf("configmap: %w", err)
	}
	return nil
}

func (r *RouterReconciler) deleteRouterControlPlane(ctx context.Context, obj *kmcv1alpha1.Router) error {
	ns := obj.Namespace
	name := obj.Name
	// ConfigMap
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: router.ConfigMapName(name), Namespace: ns}}
	if err := r.Delete(ctx, cm); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	// RoleBinding
	rb := &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: router.RoleName(name), Namespace: ns}}
	if err := r.Delete(ctx, rb); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	// Role
	role := &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: router.RoleName(name), Namespace: ns}}
	if err := r.Delete(ctx, role); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	// ServiceAccount
	sa := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: router.ServiceAccountName(name), Namespace: ns}}
	if err := r.Delete(ctx, sa); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

func mergeLabels(existing, add map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range existing {
		out[k] = v
	}
	for k, v := range add {
		out[k] = v
	}
	return out
}

func agentStatusFromConfigMap(cm *corev1.ConfigMap) *kmcv1alpha1.RouterAgentStatus {
	if cm == nil {
		return nil
	}
	ann := cm.Annotations
	if ann == nil {
		return nil
	}
	status := strings.TrimSpace(ann[kmcv1alpha1.AnnotationAgentStatus])
	if status == "" &&
		ann[kmcv1alpha1.AnnotationAgentHeartbeatAt] == "" &&
		ann[kmcv1alpha1.AnnotationAgentVersion] == "" {
		return nil
	}
	return &kmcv1alpha1.RouterAgentStatus{
		Status:             status,
		ObservedGeneration: strings.TrimSpace(ann[kmcv1alpha1.AnnotationAgentObservedGeneration]),
		LastError:          strings.TrimSpace(ann[kmcv1alpha1.AnnotationAgentLastError]),
		AppliedAt:          strings.TrimSpace(ann[kmcv1alpha1.AnnotationAgentAppliedAt]),
		HeartbeatAt:        strings.TrimSpace(ann[kmcv1alpha1.AnnotationAgentHeartbeatAt]),
		Version:            strings.TrimSpace(ann[kmcv1alpha1.AnnotationAgentVersion]),
	}
}
