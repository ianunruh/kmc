package main

import (
	"crypto/tls"
	"flag"
	"os"
	"strings"

	// Import all Kubernetes client auth plugins (e.g. Azure, GCP, OIDC, …)
	_ "k8s.io/client-go/plugin/pkg/client/auth"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/controller"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(kmcv1alpha1.AddToScheme(scheme))
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func main() {
	var (
		metricsAddr          string
		probeAddr            string
		enableLeaderElection bool
		secureMetrics        bool
		clusterPodCIDRs      string
		clusterServiceCIDRs  string
		apiServerURL         string
	)
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address the metric endpoint binds to.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election for controller manager.")
	flag.BoolVar(&secureMetrics, "metrics-secure", false, "If true, serve metrics via HTTPS.")
	flag.StringVar(&clusterPodCIDRs, "cluster-pod-cidrs", "", "Comma-separated cluster pod CIDRs for router appliance cloud-init routes.")
	flag.StringVar(&clusterServiceCIDRs, "cluster-service-cidrs", "", "Comma-separated cluster service CIDRs for router appliance cloud-init routes.")
	flag.StringVar(&apiServerURL, "apiserver-url", "", "Optional Kubernetes API server URL embedded in router agent kubeconfig (default: in-cluster).")
	opts := zap.Options{Development: true}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	metricsServerOptions := metricsserver.Options{
		BindAddress:   metricsAddr,
		SecureServing: secureMetrics,
	}
	if secureMetrics {
		metricsServerOptions.TLSOpts = []func(*tls.Config){func(c *tls.Config) {
			c.MinVersion = tls.VersionTLS12
		}}
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:  scheme,
		Metrics: metricsServerOptions,
		WebhookServer: webhook.NewServer(webhook.Options{
			Port: 9443,
		}),
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "kmc-controller.kmc.ianunruh.com",
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	if err := (&controller.IPAddressReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("ipaddress-controller"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "IPAddress")
		os.Exit(1)
	}
	if err := (&controller.VLANPoolReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("vlanpool-controller"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "VLANPool")
		os.Exit(1)
	}
	if err := (&controller.IPPoolReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("ippool-controller"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "IPPool")
		os.Exit(1)
	}
	if err := (&controller.VPCReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("vpc-controller"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "VPC")
		os.Exit(1)
	}
	if err := (&controller.FloatingIPReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("floatingip-controller"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "FloatingIP")
		os.Exit(1)
	}
	if err := (&controller.PortForwardReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("portforward-controller"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "PortForward")
		os.Exit(1)
	}
	if err := (&controller.RouterReconciler{
		Client:              mgr.GetClient(),
		Scheme:              mgr.GetScheme(),
		Recorder:            mgr.GetEventRecorderFor("router-controller"),
		ClusterPodCIDRs:     splitCSV(clusterPodCIDRs),
		ClusterServiceCIDRs: splitCSV(clusterServiceCIDRs),
		APIServerURL:        apiServerURL,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "Router")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}
