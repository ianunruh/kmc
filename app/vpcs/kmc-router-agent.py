#!/usr/bin/env python3
"""kmc-router-agent — reconcile DHCP/DNS (and later NAT) from a policy ConfigMap.

Stdlib only. Watches the router policy ConfigMap, renders dnsmasq static
leases per VPC interface, reports status/heartbeat, and self-updates when
the ConfigMap data key ``agent.py`` changes.

Phase 1: DHCP + DNS on private Multus interfaces (no external / floating IPs).
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import ssl
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

AGENT_VERSION = "7"

ENV_FILE = os.environ.get("KMC_ENV_FILE", "/etc/kmc/router-agent.env")
STATE_DIR = Path(os.environ.get("KMC_STATE_DIR", "/var/lib/kmc"))
AGENT_PATH = Path(os.environ.get("KMC_AGENT_PATH", "/usr/local/sbin/kmc-router-agent"))
DNSMASQ_D = Path(os.environ.get("KMC_DNSMASQ_D", "/var/lib/kmc/dnsmasq.d"))
DNSMASQ_MAIN = Path(os.environ.get("KMC_DNSMASQ_MAIN", "/etc/dnsmasq.d/kmc-router.conf"))
APPLIED_FILE = STATE_DIR / "applied-router-policy.json"
LAST_RV_FILE = STATE_DIR / "last-resource-version"
MANAGED_FLOATS_FILE = STATE_DIR / "managed-floats"

KMC_NAMESPACE = ""
KMC_POLICY_CM = ""
KUBECONFIG = "/etc/kmc/kubeconfig"
KMC_APISERVER = ""
KMC_CA_FILE = "/etc/kmc/ca.crt"
KMC_POLICY_KEY = "policy.json"
KMC_AGENT_KEY = "agent.py"
KMC_HEARTBEAT_SECONDS = 30
KMC_WATCH_TIMEOUT_SECONDS = 300
KMC_RESYNC_SECONDS = 300
KMC_RECONNECT_SECONDS = 5

_shutdown = False


def log(msg: str) -> None:
    print(f"kmc-router-agent: {msg}", file=sys.stderr, flush=True)


def load_env_file(path: str) -> None:
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = val


def apply_config_from_env() -> None:
    global KMC_NAMESPACE, KMC_POLICY_CM, KUBECONFIG, KMC_APISERVER, KMC_CA_FILE
    global KMC_POLICY_KEY, KMC_AGENT_KEY, KMC_HEARTBEAT_SECONDS
    global KMC_WATCH_TIMEOUT_SECONDS, KMC_RESYNC_SECONDS, KMC_RECONNECT_SECONDS
    global STATE_DIR, AGENT_PATH, DNSMASQ_D, DNSMASQ_MAIN, APPLIED_FILE, LAST_RV_FILE

    KMC_NAMESPACE = os.environ.get("KMC_NAMESPACE", "").strip()
    KMC_POLICY_CM = os.environ.get("KMC_POLICY_CM", "").strip()
    KUBECONFIG = os.environ.get("KUBECONFIG", "/etc/kmc/kubeconfig")
    KMC_APISERVER = os.environ.get("KMC_APISERVER", "").rstrip("/")
    KMC_CA_FILE = os.environ.get("KMC_CA_FILE", "/etc/kmc/ca.crt")
    KMC_POLICY_KEY = os.environ.get("KMC_POLICY_KEY", "policy.json")
    KMC_AGENT_KEY = os.environ.get("KMC_AGENT_KEY", "agent.py")
    KMC_HEARTBEAT_SECONDS = int(os.environ.get("KMC_HEARTBEAT_SECONDS", "30"))
    KMC_WATCH_TIMEOUT_SECONDS = int(os.environ.get("KMC_WATCH_TIMEOUT_SECONDS", "300"))
    KMC_RESYNC_SECONDS = int(os.environ.get("KMC_RESYNC_SECONDS", "300"))
    KMC_RECONNECT_SECONDS = int(os.environ.get("KMC_RECONNECT_SECONDS", "5"))
    STATE_DIR = Path(os.environ.get("KMC_STATE_DIR", "/var/lib/kmc"))
    AGENT_PATH = Path(os.environ.get("KMC_AGENT_PATH", "/usr/local/sbin/kmc-router-agent"))
    DNSMASQ_D = Path(os.environ.get("KMC_DNSMASQ_D", "/var/lib/kmc/dnsmasq.d"))
    DNSMASQ_MAIN = Path(os.environ.get("KMC_DNSMASQ_MAIN", "/etc/dnsmasq.d/kmc-router.conf"))
    APPLIED_FILE = STATE_DIR / "applied-router-policy.json"
    LAST_RV_FILE = STATE_DIR / "last-resource-version"

    missing = [
        n
        for n, v in (
            ("KMC_NAMESPACE", KMC_NAMESPACE),
            ("KMC_POLICY_CM", KMC_POLICY_CM),
            ("KMC_APISERVER", KMC_APISERVER),
        )
        if not v
    ]
    if missing:
        raise SystemExit(f"missing required config: {', '.join(missing)}")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def running_script_sha() -> str:
    try:
        return sha256_text(Path(__file__).resolve().read_text(encoding="utf-8"))
    except OSError:
        try:
            return sha256_text(AGENT_PATH.read_text(encoding="utf-8"))
        except OSError:
            return "unknown"


def token_from_kubeconfig() -> str:
    env_token = os.environ.get("KUBE_TOKEN", "").strip()
    if env_token:
        return env_token
    try:
        with open(KUBECONFIG, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("token:"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return ""


def ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=KMC_CA_FILE)


def api_request(
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    content_type: str | None = None,
    timeout: float | None = 60,
    stream: bool = False,
) -> Any:
    url = f"{KMC_APISERVER}{path}"
    headers = {
        "Authorization": f"Bearer {token_from_kubeconfig()}",
        "Accept": "application/json",
    }
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    resp = urllib.request.urlopen(req, context=ssl_context(), timeout=timeout)
    if stream:
        return resp
    raw = resp.read()
    resp.close()
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def if_by_mac(want: str) -> str | None:
    want = want.lower()
    net = Path("/sys/class/net")
    for path in net.iterdir():
        iface = path.name
        if iface == "lo":
            continue
        addr_file = path / "address"
        if not addr_file.is_file():
            continue
        mac = addr_file.read_text(encoding="utf-8").strip().lower()
        if mac == want:
            return iface
    return None


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def patch_status(
    *,
    status: str = "Ready",
    generation: str = "",
    error: str = "",
    applied: bool = False,
    heartbeat_only: bool = False,
) -> None:
    """Patch agent annotations on the policy ConfigMap.

    Prefer ``heartbeat_only`` for liveness so we do not rewrite status fields
    unnecessarily. Any annotation patch still changes resourceVersion and can
    re-fire the watch — callers must not re-apply dataplane on those events.
    """
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    ann: dict[str, str] = {
        "kmc.ianunruh.com/agent-heartbeat-at": now,
        "kmc.ianunruh.com/agent-version": running_script_sha()[:12],
    }
    if not heartbeat_only:
        ann["kmc.ianunruh.com/agent-status"] = status
        if generation:
            ann["kmc.ianunruh.com/agent-observed-generation"] = generation
        if error:
            ann["kmc.ianunruh.com/agent-last-error"] = error[:1024]
        elif status == "Ready":
            ann["kmc.ianunruh.com/agent-last-error"] = ""
        if applied:
            ann["kmc.ianunruh.com/agent-applied-at"] = now

    body = json.dumps({"metadata": {"annotations": ann}}).encode("utf-8")
    path = (
        f"/api/v1/namespaces/{urllib.parse.quote(KMC_NAMESPACE)}"
        f"/configmaps/{urllib.parse.quote(KMC_POLICY_CM)}"
    )
    try:
        api_request(
            "PATCH",
            path,
            body=body,
            content_type="application/strategic-merge-patch+json",
            timeout=30,
        )
    except Exception as e:  # noqa: BLE001
        log(f"status patch failed: {e}")


def get_configmap() -> dict[str, Any]:
    path = (
        f"/api/v1/namespaces/{urllib.parse.quote(KMC_NAMESPACE)}"
        f"/configmaps/{urllib.parse.quote(KMC_POLICY_CM)}"
    )
    return api_request("GET", path, timeout=30) or {}


def maybe_self_update(cm: dict[str, Any]) -> bool:
    data = cm.get("data") or {}
    remote = data.get(KMC_AGENT_KEY)
    if not remote or not str(remote).strip():
        return False
    remote_sha = sha256_text(remote)
    if remote_sha == running_script_sha():
        return False
    log(f"agent.py changed ({running_script_sha()[:8]} → {remote_sha[:8]}); rewriting and re-exec")
    AGENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    AGENT_PATH.write_text(remote, encoding="utf-8")
    AGENT_PATH.chmod(0o755)
    os.execv(sys.executable, [sys.executable, str(AGENT_PATH)])
    return True  # unreachable


def network_from_cidr(cidr: str) -> str:
    """Return network address string for dhcp-range (best-effort)."""
    try:
        ip_s, pref_s = cidr.split("/", 1)
        pref = int(pref_s)
        parts = [int(x) for x in ip_s.split(".")]
        if len(parts) != 4 or pref < 0 or pref > 32:
            return ip_s
        mask = (0xFFFFFFFF << (32 - pref)) & 0xFFFFFFFF if pref else 0
        n = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
        n = n & mask
        return f"{(n >> 24) & 255}.{(n >> 16) & 255}.{(n >> 8) & 255}.{n & 255}"
    except Exception:  # noqa: BLE001
        return cidr.split("/")[0]


def ensure_dnsmasq_main() -> None:
    DNSMASQ_D.mkdir(parents=True, exist_ok=True)
    DNSMASQ_MAIN.parent.mkdir(parents=True, exist_ok=True)
    # IMPORTANT: conf-dir suffixes are SKIP lists (Debian uses them to ignore
    # .dpkg-*). Do NOT pass *.conf or every real config is ignored and DHCP
    # never binds port 67.
    content = "\n".join(
        [
            "# Managed by kmc-router-agent — do not edit",
            # conf-dir suffix args are SKIP globs (not include filters).
            "conf-dir=/var/lib/kmc/dnsmasq.d",
            "bind-interfaces",
            "except-interface=lo",
            "dhcp-authoritative",
            "log-dhcp",
            # Upstream resolvers so guests can resolve the public internet
            # (router does SNAT; dnsmasq forwards recursive queries).
            "server=1.1.1.1",
            "server=1.0.0.1",
            "server=8.8.8.8",
            "no-resolv",
            "cache-size=1000",
            "",
        ]
    )
    if not DNSMASQ_MAIN.is_file() or DNSMASQ_MAIN.read_text(encoding="utf-8") != content:
        DNSMASQ_MAIN.write_text(content, encoding="utf-8")


def render_vpc_dnsmasq(
    *,
    vpc: str,
    iface: str,
    cidr: str,
    gateway: str,
    domain: str,
    lease_time: str,
    leases: list[dict[str, Any]],
) -> str:
    network = network_from_cidr(cidr)
    # Sanitize tag: dnsmasq tags should be simple tokens
    tag = "".join(c if c.isalnum() else "_" for c in vpc) or "vpc"
    lines = [
        f"# VPC {vpc} — managed by kmc-router-agent",
        f"interface={iface}",
        # Static-only pool (no dynamic free-pool). Lease time after netmask.
        f"dhcp-range=set:{tag},{network},static,255.255.255.0,{lease_time}",
        f"dhcp-option=tag:{tag},option:router,{gateway}",
        f"dhcp-option=tag:{tag},option:dns-server,{gateway}",
    ]
    # Derive netmask from cidr when possible
    try:
        pref = int(cidr.split("/", 1)[1])
        mask_int = (0xFFFFFFFF << (32 - pref)) & 0xFFFFFFFF if pref else 0
        netmask = (
            f"{(mask_int >> 24) & 255}."
            f"{(mask_int >> 16) & 255}."
            f"{(mask_int >> 8) & 255}."
            f"{mask_int & 255}"
        )
        lines[2] = f"dhcp-range=set:{tag},{network},static,{netmask},{lease_time}"
    except Exception:  # noqa: BLE001
        pass
    if domain:
        lines.append(f"dhcp-option=tag:{tag},option:domain-search,{domain}")
        lines.append(f"domain={domain},{iface}")
    lines.append("")
    for lease in leases:
        mac = str(lease.get("mac", "")).strip().lower()
        ip = str(lease.get("ip", "")).strip()
        hostname = str(lease.get("hostname", "")).strip() or "host"
        if not mac or not ip:
            continue
        lines.append(f"dhcp-host={mac},{ip},{hostname},{lease_time},set:{tag}")
        if domain:
            lines.append(f"address=/{hostname}.{domain}/{ip}")
            lines.append(f"address=/{hostname}/{ip}")
    lines.append("")
    return "\n".join(lines)


def reload_dnsmasq() -> None:
    # MUST restart (not reload/SIGHUP). dnsmasq SIGHUP only re-reads
    # dhcp-hostsfile / dhcp-hostsdir / hosts — it does NOT re-read conf-dir
    # (our per-VPC *.conf with dhcp-host + dhcp-range). A bare reload left new
    # static leases on disk while the running process still said
    # "no address available" for those MACs.
    r = run(["systemctl", "restart", "dnsmasq"], check=False)
    if r.returncode == 0:
        return
    r = run(["systemctl", "start", "dnsmasq"], check=False)
    if r.returncode != 0:
        run(["pkill", "-HUP", "dnsmasq"], check=False)
        log("dnsmasq restart/start failed; sent SIGHUP as last resort")


def iptables(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["iptables", *args], check=check)


def ensure_float_chains() -> None:
    for args in (
        ["-t", "nat", "-N", "KMC_FLOAT_PRE"],
        ["-t", "nat", "-N", "KMC_FLOAT_POST"],
        ["-N", "KMC_FLOAT_FWD"],
    ):
        iptables(*args, check=False)

    def ensure_jump(table_args: list[str], chain: str, jump: str) -> None:
        if iptables(*table_args, "-C", chain, "-j", jump, check=False).returncode == 0:
            return
        iptables(*table_args, "-I", chain, "1", "-j", jump)

    ensure_jump(["-t", "nat"], "PREROUTING", "KMC_FLOAT_PRE")
    ensure_jump(["-t", "nat"], "POSTROUTING", "KMC_FLOAT_POST")
    ensure_jump([], "FORWARD", "KMC_FLOAT_FWD")


def list_managed_floats() -> list[str]:
    if not MANAGED_FLOATS_FILE.is_file():
        return []
    return [
        ln.strip()
        for ln in MANAGED_FLOATS_FILE.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]


def set_managed_floats(floats: list[str]) -> None:
    MANAGED_FLOATS_FILE.write_text(
        ("\n".join(floats) + ("\n" if floats else "")),
        encoding="utf-8",
    )


def iface_ipv4_cidrs(iface: str) -> list[str]:
    out = run(["ip", "-4", "-o", "addr", "show", "dev", iface], check=False)
    cidrs: list[str] = []
    for line in (out.stdout or "").splitlines():
        parts = line.split()
        if "inet" in parts:
            i = parts.index("inet")
            if i + 1 < len(parts):
                cidrs.append(parts[i + 1])
    return cidrs


def send_garp(iface: str, ip: str) -> None:
    """Announce floating IP via arping (iputils-arping is installed by cloud-init)."""
    # -U: unsolicited ARP (update neighbors); -A: advertise mode on some builds
    for args in (
        ["arping", "-c", "2", "-U", "-I", iface, ip],
        ["arping", "-c", "2", "-A", "-I", iface, ip],
    ):
        r = run(args, check=False)
        if r.returncode == 0:
            return
    log(
        f"garp {ip} on {iface} failed: arping not available or failed "
        f"(install iputils-arping)"
    )


def ensure_float_addr(iface: str, pub: str) -> None:
    want = f"{pub}/32"
    existing = iface_ipv4_cidrs(iface)
    has_exact = want in existing
    for cidr in existing:
        ip = cidr.split("/")[0]
        if ip == pub and cidr != want:
            run(["ip", "addr", "del", cidr, "dev", iface], check=False)
            has_exact = False
    if not has_exact:
        run(["ip", "addr", "add", want, "dev", iface], check=False)
    run(["sysctl", "-w", f"net.ipv4.conf.{iface}.arp_notify=1"], check=False)
    send_garp(iface, pub)


def apply_external_and_floats(doc: dict[str, Any], private_ifaces: list[str]) -> None:
    """SNAT/MASQUERADE + floating IPs when external gateway is configured."""
    external = doc.get("external") or None
    floats = doc.get("floatingIPs") or []

    # Clear float chains even without external so removals stick after clearExternal.
    ensure_float_chains()
    iptables("-t", "nat", "-F", "KMC_FLOAT_PRE", check=False)
    iptables("-t", "nat", "-F", "KMC_FLOAT_POST", check=False)
    iptables("-F", "KMC_FLOAT_FWD", check=False)

    if not external or not isinstance(external, dict):
        for old in list_managed_floats():
            # Best-effort: cannot know public iface without external; skip del
            pass
        set_managed_floats([])
        return

    public_mac = str(external.get("mac", "")).strip().lower()
    snat = external.get("snat", True)
    if not public_mac:
        log("external present but no mac; skip SNAT/floats")
        return
    public_if = if_by_mac(public_mac)
    if not public_if:
        raise RuntimeError(f"public NIC not found for {public_mac}")

    # Default route should already be on public via cloud-init netplan.
    # Ensure MASQUERADE for general egress when snat enabled.
    if snat:
        if (
            iptables(
                "-t",
                "nat",
                "-C",
                "POSTROUTING",
                "-o",
                public_if,
                "-j",
                "MASQUERADE",
                check=False,
            ).returncode
            != 0
        ):
            iptables(
                "-t",
                "nat",
                "-A",
                "POSTROUTING",
                "-o",
                public_if,
                "-j",
                "MASQUERADE",
            )
        for priv in private_ifaces:
            # Egress private → public
            if (
                iptables(
                    "-C",
                    "FORWARD",
                    "-i",
                    priv,
                    "-o",
                    public_if,
                    "-j",
                    "ACCEPT",
                    check=False,
                ).returncode
                != 0
            ):
                iptables("-A", "FORWARD", "-i", priv, "-o", public_if, "-j", "ACCEPT")
            # Ingress public → private (NEW + established) for DNAT / return traffic
            if (
                iptables(
                    "-C",
                    "FORWARD",
                    "-i",
                    public_if,
                    "-o",
                    priv,
                    "-j",
                    "ACCEPT",
                    check=False,
                ).returncode
                != 0
            ):
                iptables(
                    "-A",
                    "FORWARD",
                    "-i",
                    public_if,
                    "-o",
                    priv,
                    "-j",
                    "ACCEPT",
                )

    new_floats: list[str] = []
    for f in floats:
        if not isinstance(f, dict):
            continue
        pub = str(f.get("public", "")).split("/")[0].strip()
        priv = str(f.get("private", "")).split("/")[0].strip()
        if not pub:
            continue
        new_floats.append(f"{pub}/32")
        ensure_float_addr(public_if, pub)
        if not priv:
            continue
        iptables(
            "-t",
            "nat",
            "-A",
            "KMC_FLOAT_PRE",
            "-d",
            f"{pub}/32",
            "-j",
            "DNAT",
            "--to-destination",
            priv,
        )
        iptables(
            "-t",
            "nat",
            "-A",
            "KMC_FLOAT_POST",
            "-s",
            f"{priv}/32",
            "-o",
            public_if,
            "-j",
            "SNAT",
            "--to-source",
            pub,
        )
        iptables("-A", "KMC_FLOAT_FWD", "-d", f"{priv}/32", "-j", "ACCEPT")
        iptables("-A", "KMC_FLOAT_FWD", "-s", f"{priv}/32", "-j", "ACCEPT")

    for old in list_managed_floats():
        old_ip = old.split("/")[0]
        if any(nf.split("/")[0] == old_ip for nf in new_floats):
            continue
        run(["ip", "addr", "del", old, "dev", public_if], check=False)
        run(["ip", "addr", "del", f"{old_ip}/32", "dev", public_if], check=False)

    set_managed_floats(new_floats)
    log(f"external on {public_if}: snat={snat} floats={len(new_floats)}")


def apply_policy(doc: dict[str, Any]) -> str:
    """Apply RouterPolicy; return generation string."""
    meta = doc.get("metadata") or {}
    generation = str(meta.get("generation", ""))
    interfaces = doc.get("interfaces") or []
    leases_all = doc.get("leases") or []

    ensure_dnsmasq_main()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    DNSMASQ_D.mkdir(parents=True, exist_ok=True)

    # Enable forwarding between private interfaces (multi-VPC) + external
    run(["sysctl", "-w", "net.ipv4.ip_forward=1"], check=False)

    active_vpcs: set[str] = set()
    private_ifaces: list[str] = []
    for iface_doc in interfaces:
        vpc = str(iface_doc.get("vpc", "")).strip()
        mac = str(iface_doc.get("mac", "")).strip().lower()
        cidr = str(iface_doc.get("cidr", "")).strip()
        gateway = str(iface_doc.get("gateway", "")).strip()
        domain = str(iface_doc.get("domain", "")).strip()
        dhcp = iface_doc.get("dhcp") or {}
        enabled = dhcp.get("enabled", True)
        lease_time = str(dhcp.get("leaseTime", "12h")).strip() or "12h"
        if not vpc or not mac or not cidr or not gateway:
            log(f"skip incomplete interface: {iface_doc!r}")
            continue
        if not enabled:
            continue
        iface = if_by_mac(mac)
        if not iface:
            raise RuntimeError(f"interface for VPC {vpc} MAC {mac} not found")
        private_ifaces.append(iface)
        active_vpcs.add(vpc)
        vpc_leases = [L for L in leases_all if str(L.get("vpc", "")).strip() == vpc]
        conf = render_vpc_dnsmasq(
            vpc=vpc,
            iface=iface,
            cidr=cidr,
            gateway=gateway,
            domain=domain,
            lease_time=lease_time,
            leases=vpc_leases,
        )
        path = DNSMASQ_D / f"{vpc}.conf"
        path.write_text(conf, encoding="utf-8")
        log(f"wrote {path} ({len(vpc_leases)} leases) on {iface}")

    # Remove stale per-VPC confs
    for path in DNSMASQ_D.glob("*.conf"):
        stem = path.stem
        if stem not in active_vpcs:
            path.unlink(missing_ok=True)
            log(f"removed stale {path}")

    # Inter-private FORWARD
    for a in private_ifaces:
        for b in private_ifaces:
            if a == b:
                continue
            if (
                iptables("-C", "FORWARD", "-i", a, "-o", b, "-j", "ACCEPT", check=False).returncode
                != 0
            ):
                iptables("-A", "FORWARD", "-i", a, "-o", b, "-j", "ACCEPT")

    apply_external_and_floats(doc, private_ifaces)
    reload_dnsmasq()
    return generation


def policy_fingerprint(raw: str) -> str:
    return sha256_text(raw.replace("\r\n", "\n"))


def reconcile_once(*, force: bool = False) -> None:
    """Apply policy.json when it changes; skip annotation-only watch events.

    Always GET the ConfigMap so we never trust a partial watch object. Compare
    a hash of policy.json so reformatting / annotation-only updates do not
    flush iptables DNAT (which would send FIP SSH to the router itself).
    """
    cm = get_configmap()
    if maybe_self_update(cm):
        return
    data = cm.get("data") or {}
    raw = data.get(KMC_POLICY_KEY, "") or "{}"
    if not isinstance(raw, str):
        raw = "{}"
    raw = raw.replace("\r\n", "\n")
    if not raw.endswith("\n") and raw.strip():
        # Normalize trailing newline for stable comparison
        raw_cmp = raw
    else:
        raw_cmp = raw

    fp = policy_fingerprint(raw_cmp)
    if not force and APPLIED_FILE.is_file():
        try:
            prev = APPLIED_FILE.read_text(encoding="utf-8").strip()
            # File may store fingerprint (sha256:...) or legacy raw policy body
            if prev == fp or prev == raw_cmp or prev == raw_cmp.strip():
                return
            if prev.startswith("sha256:") and prev[7:] == fp:
                return
        except OSError:
            pass

    try:
        doc = json.loads(raw_cmp) if str(raw_cmp).strip() else {}
    except json.JSONDecodeError as e:
        patch_status(status="Error", error=f"invalid policy JSON: {e}")
        raise

    generation = apply_policy(doc)
    try:
        # Store fingerprint only — smaller and stable
        APPLIED_FILE.write_text(f"sha256:{fp}\n", encoding="utf-8")
    except OSError as e:
        log(f"write applied policy failed: {e}")
    patch_status(status="Ready", generation=str(generation), applied=True)
    log(f"applied generation={generation or '?'} floats={len(doc.get('floatingIPs') or [])}")


def watch_loop() -> None:
    """Watch policy ConfigMap; re-apply only when policy.json changes.

    Heartbeat on watch timeout (not on every event) to limit annotation churn.
    """
    last_resync = 0.0
    resource_version = ""
    if LAST_RV_FILE.is_file():
        resource_version = LAST_RV_FILE.read_text(encoding="utf-8").strip()

    while not _shutdown:
        now = time.time()
        need_resync = not resource_version or (now - last_resync) >= KMC_RESYNC_SECONDS
        if need_resync:
            try:
                cm = get_configmap()
                resource_version = str(
                    (cm.get("metadata") or {}).get("resourceVersion") or ""
                )
                if resource_version:
                    LAST_RV_FILE.write_text(resource_version, encoding="utf-8")
                reconcile_once(force=True)
                last_resync = time.time()
                resource_version = str(
                    (get_configmap().get("metadata") or {}).get("resourceVersion")
                    or resource_version
                )
                if resource_version:
                    LAST_RV_FILE.write_text(resource_version, encoding="utf-8")
            except Exception as e:  # noqa: BLE001
                log(f"resync failed: {e}")
                traceback.print_exc()
                patch_status(status="Error", error=str(e))
                time.sleep(KMC_RECONNECT_SECONDS)
                continue

        watch_timeout = max(5, min(KMC_HEARTBEAT_SECONDS, KMC_WATCH_TIMEOUT_SECONDS))
        qs = urllib.parse.urlencode(
            {
                "watch": "true",
                "allowWatchBookmarks": "true",
                "timeoutSeconds": str(watch_timeout),
                "fieldSelector": f"metadata.name={KMC_POLICY_CM}",
                "resourceVersion": resource_version,
            }
        )
        path = (
            f"/api/v1/namespaces/{urllib.parse.quote(KMC_NAMESPACE)}"
            f"/configmaps?{qs}"
        )
        resp = None
        try:
            resp = api_request(
                "GET",
                path,
                timeout=watch_timeout + 60,
                stream=True,
            )
            while not _shutdown:
                line = resp.readline()
                if not line:
                    break
                line = line.decode("utf-8") if isinstance(line, bytes) else line
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                obj = event.get("object") or {}
                meta = obj.get("metadata") or {}
                new_rv = meta.get("resourceVersion")
                if new_rv:
                    resource_version = str(new_rv)
                    LAST_RV_FILE.write_text(resource_version, encoding="utf-8")
                etype = event.get("type", "")
                if etype == "BOOKMARK":
                    continue
                if etype in ("ADDED", "MODIFIED", "DELETED"):
                    # Always GET; compare policy hash — ignore annotation-only noise
                    reconcile_once(force=False)
                    last_resync = time.time()
            # Watch ended (timeout) — heartbeat without re-applying dataplane
            patch_status(heartbeat_only=True)
        except Exception as e:  # noqa: BLE001
            log(f"watch/reconcile error: {e}")
            traceback.print_exc()
            patch_status(status="Error", error=str(e))
            time.sleep(KMC_RECONNECT_SECONDS)
        finally:
            if resp is not None:
                try:
                    resp.close()
                except Exception:  # noqa: BLE001
                    pass


def on_signal(signum: int, _frame: Any) -> None:
    global _shutdown
    log(f"signal {signum}; shutting down")
    _shutdown = True


def main() -> None:
    load_env_file(ENV_FILE)
    apply_config_from_env()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    log(f"starting version={AGENT_VERSION} cm={KMC_NAMESPACE}/{KMC_POLICY_CM}")
    patch_status(status="Pending")
    try:
        reconcile_once()
    except Exception as e:  # noqa: BLE001
        log(f"initial reconcile failed: {e}")
        traceback.print_exc()
        patch_status(status="Error", error=str(e))
    watch_loop()


if __name__ == "__main__":
    main()
