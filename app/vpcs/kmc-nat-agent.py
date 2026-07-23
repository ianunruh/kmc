#!/usr/bin/env python3
"""kmc-nat-agent — reconcile floating IPs from a policy ConfigMap.

Stdlib only. Watches the policy ConfigMap, applies 1:1 DNAT/SNAT + secondary
public addresses, reports status/heartbeat annotations, and self-updates when
the ConfigMap data key ``agent.py`` changes.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import socket
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

AGENT_VERSION = "2"

ENV_FILE = os.environ.get("KMC_ENV_FILE", "/etc/kmc/nat-agent.env")
STATE_DIR = Path(os.environ.get("KMC_STATE_DIR", "/var/lib/kmc"))
AGENT_PATH = Path(os.environ.get("KMC_AGENT_PATH", "/usr/local/sbin/kmc-nat-agent"))
MANAGED_FLOATS_FILE = STATE_DIR / "managed-floats"
APPLIED_FILE = STATE_DIR / "applied-policy.json"
LAST_RV_FILE = STATE_DIR / "last-resource-version"

# Defaults (overridden by env file / environment)
KMC_NAMESPACE = ""
KMC_POLICY_CM = ""
KMC_PRIVATE_MAC = ""
KMC_PUBLIC_MAC = ""
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
    print(f"kmc-nat-agent: {msg}", file=sys.stderr, flush=True)


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
    global KMC_NAMESPACE, KMC_POLICY_CM, KMC_PRIVATE_MAC, KMC_PUBLIC_MAC
    global KUBECONFIG, KMC_APISERVER, KMC_CA_FILE, KMC_POLICY_KEY, KMC_AGENT_KEY
    global KMC_HEARTBEAT_SECONDS, KMC_WATCH_TIMEOUT_SECONDS, KMC_RESYNC_SECONDS
    global KMC_RECONNECT_SECONDS, STATE_DIR, AGENT_PATH
    global MANAGED_FLOATS_FILE, APPLIED_FILE, LAST_RV_FILE

    KMC_NAMESPACE = os.environ.get("KMC_NAMESPACE", "").strip()
    KMC_POLICY_CM = os.environ.get("KMC_POLICY_CM", "").strip()
    KMC_PRIVATE_MAC = os.environ.get("KMC_PRIVATE_MAC", "").strip().lower()
    KMC_PUBLIC_MAC = os.environ.get("KMC_PUBLIC_MAC", "").strip().lower()
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
    AGENT_PATH = Path(os.environ.get("KMC_AGENT_PATH", "/usr/local/sbin/kmc-nat-agent"))
    MANAGED_FLOATS_FILE = STATE_DIR / "managed-floats"
    APPLIED_FILE = STATE_DIR / "applied-policy.json"
    LAST_RV_FILE = STATE_DIR / "last-resource-version"

    missing = [
        n
        for n, v in (
            ("KMC_NAMESPACE", KMC_NAMESPACE),
            ("KMC_POLICY_CM", KMC_POLICY_CM),
            ("KMC_PRIVATE_MAC", KMC_PRIVATE_MAC),
            ("KMC_PUBLIC_MAC", KMC_PUBLIC_MAC),
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
    ctx = ssl.create_default_context(cafile=KMC_CA_FILE)
    return ctx


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
    # stream watches need long timeout; None = no socket timeout
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


def resolve_ifaces() -> tuple[str, str]:
    private_if = if_by_mac(KMC_PRIVATE_MAC)
    if not private_if:
        raise RuntimeError(f"private NIC not found for {KMC_PRIVATE_MAC}")
    public_if = if_by_mac(KMC_PUBLIC_MAC)
    if not public_if:
        raise RuntimeError(f"public NIC not found for {KMC_PUBLIC_MAC}")
    return private_if, public_if


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def iptables(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["iptables", *args], check=check)


def ensure_chains() -> None:
    for args in (
        ["-t", "nat", "-N", "KMC_FLOAT_PRE"],
        ["-t", "nat", "-N", "KMC_FLOAT_POST"],
        ["-N", "KMC_FLOAT_FWD"],
    ):
        iptables(*args, check=False)

    def ensure_jump(table_args: list[str], chain: str, jump: str, insert: bool = True) -> None:
        check_args = [*table_args, "-C", chain, "-j", jump]
        if iptables(*check_args, check=False).returncode == 0:
            return
        if insert:
            iptables(*table_args, "-I", chain, "1", "-j", jump)
        else:
            iptables(*table_args, "-A", chain, "-j", jump)

    ensure_jump(["-t", "nat"], "PREROUTING", "KMC_FLOAT_PRE")
    ensure_jump(["-t", "nat"], "POSTROUTING", "KMC_FLOAT_POST")
    ensure_jump([], "FORWARD", "KMC_FLOAT_FWD")


def list_managed_floats() -> list[str]:
    if not MANAGED_FLOATS_FILE.is_file():
        return []
    return [ln.strip() for ln in MANAGED_FLOATS_FILE.read_text(encoding="utf-8").splitlines() if ln.strip()]


def set_managed_floats(floats: list[str]) -> None:
    MANAGED_FLOATS_FILE.write_text(
        ("\n".join(floats) + ("\n" if floats else "")),
        encoding="utf-8",
    )


def iface_has_ipv4(iface: str, addr: str) -> bool:
    out = run(["ip", "-4", "addr", "show", "dev", iface], check=False)
    return addr in (out.stdout or "")


def iface_ipv4_cidrs(iface: str) -> list[str]:
    """Return IPv4 CIDRs configured on iface (e.g. ['10.30.0.2/24', '10.30.0.3/32'])."""
    out = run(["ip", "-4", "-o", "addr", "show", "dev", iface], check=False)
    cidrs: list[str] = []
    for line in (out.stdout or "").splitlines():
        parts = line.split()
        # ... inet 10.30.0.3/32 ...
        if "inet" in parts:
            i = parts.index("inet")
            if i + 1 < len(parts):
                cidrs.append(parts[i + 1])
    return cidrs


def send_garp(iface: str, ip: str) -> None:
    """Broadcast gratuitous ARP so underlay neighbors learn the float MAC."""
    try:
        import fcntl
        import struct

        sock_ioctl = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        ifr = struct.pack("256s", iface.encode()[:15])
        mac = fcntl.ioctl(sock_ioctl.fileno(), 0x8927, ifr)[18:24]  # SIOCGIFHWADDR
        sock_ioctl.close()

        sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0806))
        sock.bind((iface, 0x0806))
        eth = b"\xff" * 6 + mac + b"\x08\x06"
        # ARP reply claiming ip is at mac (gratuitous)
        arp = struct.pack("!HHBBH", 1, 0x0800, 6, 4, 2)
        arp += mac + socket.inet_aton(ip) + (b"\xff" * 6) + socket.inet_aton(ip)
        sock.send(eth + arp)
        # Also request form used by some gear
        arp_req = struct.pack("!HHBBH", 1, 0x0800, 6, 4, 1)
        arp_req += mac + socket.inet_aton(ip) + (b"\x00" * 6) + socket.inet_aton(ip)
        sock.send(eth + arp_req)
        sock.close()
    except Exception as e:  # noqa: BLE001 — best-effort
        log(f"garp {ip} on {iface} failed: {e}")


def ensure_float_addr(iface: str, pub: str) -> None:
    """Own the floating IP as a /32 on the public NIC and announce via GARP.

    Pool prefix from policy is for IPAM only — secondary floats must be /32 so
    they do not create a second connected route for the public subnet.
    """
    want = f"{pub}/32"
    existing = iface_ipv4_cidrs(iface)
    has_exact = want in existing
    # Drop non-/32 forms of the same address left by older agents
    for cidr in existing:
        ip = cidr.split("/")[0]
        if ip == pub and cidr != want:
            run(["ip", "addr", "del", cidr, "dev", iface], check=False)
            has_exact = False
    if not has_exact:
        run(["ip", "addr", "add", want, "dev", iface], check=False)
    send_garp(iface, pub)


def apply_policy_json(policy_raw: str, public_if: str) -> str:
    try:
        doc = json.loads(policy_raw) if policy_raw.strip() else {}
    except json.JSONDecodeError as e:
        raise RuntimeError(f"invalid policy JSON: {e}") from e

    generation = str(doc.get("metadata", {}).get("generation", doc.get("generation", "")))
    floats = doc.get("floatingIPs") or []

    iptables("-t", "nat", "-F", "KMC_FLOAT_PRE")
    iptables("-t", "nat", "-F", "KMC_FLOAT_POST")
    iptables("-F", "KMC_FLOAT_FWD")

    new_floats: list[str] = []
    for f in floats:
        if not isinstance(f, dict):
            continue
        pub = str(f.get("public", "")).split("/")[0].strip()
        priv = str(f.get("private", "")).split("/")[0].strip()
        if not pub:
            continue
        # Always track/install as /32 on the public NIC (held + associated).
        # Held FIPs keep the secondary address reserved without DNAT/SNAT.
        new_floats.append(f"{pub}/32")
        ensure_float_addr(public_if, pub)
        if not priv:
            continue
        iptables(
            "-t", "nat", "-A", "KMC_FLOAT_PRE",
            "-d", f"{pub}/32", "-j", "DNAT", "--to-destination", priv,
        )
        iptables(
            "-t", "nat", "-A", "KMC_FLOAT_POST",
            "-s", f"{priv}/32", "-o", public_if, "-j", "SNAT", "--to-source", pub,
        )
        iptables("-A", "KMC_FLOAT_FWD", "-d", f"{priv}/32", "-j", "ACCEPT")
        iptables("-A", "KMC_FLOAT_FWD", "-s", f"{priv}/32", "-j", "ACCEPT")

    for old in list_managed_floats():
        old_ip = old.split("/")[0]
        if any(nf.split("/")[0] == old_ip for nf in new_floats):
            continue
        run(["ip", "addr", "del", old, "dev", public_if], check=False)
        run(["ip", "addr", "del", f"{old_ip}/32", "dev", public_if], check=False)
        run(["ip", "addr", "del", f"{old_ip}/24", "dev", public_if], check=False)

    set_managed_floats(new_floats)
    APPLIED_FILE.write_text(policy_raw if policy_raw.strip() else "{}", encoding="utf-8")
    return generation


def patch_status(
    status: str,
    generation: str,
    err: str,
    *,
    heartbeat_only: bool = False,
) -> None:
    applied_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    ann: dict[str, str] = {
        "kmc.ianunruh.com/agent-heartbeat-at": applied_at,
        "kmc.ianunruh.com/agent-version": running_script_sha()[:12],
    }
    if not heartbeat_only:
        ann["kmc.ianunruh.com/agent-status"] = status
        ann["kmc.ianunruh.com/agent-observed-generation"] = generation
        # Keep annotation size bounded
        ann["kmc.ianunruh.com/agent-last-error"] = (err or "")[:500]
        ann["kmc.ianunruh.com/agent-applied-at"] = applied_at
    body = json.dumps({"metadata": {"annotations": ann}}).encode("utf-8")
    path = f"/api/v1/namespaces/{urllib.parse.quote(KMC_NAMESPACE)}/configmaps/{urllib.parse.quote(KMC_POLICY_CM)}"
    try:
        api_request(
            "PATCH",
            path,
            body=body,
            content_type="application/strategic-merge-patch+json",
            timeout=30,
        )
    except Exception as e:  # noqa: BLE001 — best-effort status
        log(f"status patch failed: {e}")


def fetch_configmap() -> dict[str, Any]:
    path = f"/api/v1/namespaces/{urllib.parse.quote(KMC_NAMESPACE)}/configmaps/{urllib.parse.quote(KMC_POLICY_CM)}"
    cm = api_request("GET", path, timeout=30)
    if not isinstance(cm, dict):
        raise RuntimeError("configmap response was not an object")
    return cm


def maybe_self_update(cm: dict[str, Any]) -> None:
    data = cm.get("data") or {}
    remote = data.get(KMC_AGENT_KEY)
    if not remote or not isinstance(remote, str):
        return
    remote = remote.replace("\r\n", "\n")
    if not remote.endswith("\n"):
        remote += "\n"
    remote_sha = sha256_text(remote)

    try:
        local = AGENT_PATH.read_text(encoding="utf-8")
    except OSError:
        local = ""
    if not local.endswith("\n") and local:
        local_norm = local + "\n"
    else:
        local_norm = local
    if sha256_text(local_norm) == remote_sha or sha256_text(local) == remote_sha:
        return

    log(f"self-update: writing new agent ({remote_sha[:12]}) to {AGENT_PATH}")
    AGENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = AGENT_PATH.with_suffix(AGENT_PATH.suffix + ".new")
    tmp.write_text(remote, encoding="utf-8")
    tmp.chmod(0o755)
    tmp.replace(AGENT_PATH)

    # Re-exec under the updated script (python interpreter + path).
    args = sys.argv[1:] or ["run"]
    os.execv(sys.executable, [sys.executable, str(AGENT_PATH), *args])


def reconcile_from_cm(cm: dict[str, Any], *, force: bool = False) -> None:
    maybe_self_update(cm)

    meta = cm.get("metadata") or {}
    rv = str(meta.get("resourceVersion") or "")
    data = cm.get("data") or {}
    policy = data.get(KMC_POLICY_KEY) or "{}"

    # Status/heartbeat annotation patches change resourceVersion but not policy.
    # Skip re-applying iptables for those (avoids watch feedback loops).
    if not force and APPLIED_FILE.is_file():
        try:
            if APPLIED_FILE.read_text(encoding="utf-8") == policy:
                if rv:
                    LAST_RV_FILE.write_text(rv, encoding="utf-8")
                return
        except OSError:
            pass

    try:
        _, public_if = resolve_ifaces()
        ensure_chains()
        generation = apply_policy_json(policy, public_if)
        if rv:
            LAST_RV_FILE.write_text(rv, encoding="utf-8")
        patch_status("Ready", generation, "")
        log(f"applied generation={generation or '?'} rv={rv}")
    except Exception as e:  # noqa: BLE001
        err = f"{e}"
        log(f"apply failed: {err}")
        patch_status("Error", "", err)
        raise


def wait_for_nics(timeout_s: int = 120) -> tuple[str, str]:
    deadline = time.time() + timeout_s
    last_err: Exception | None = None
    while time.time() < deadline and not _shutdown:
        try:
            ifaces = resolve_ifaces()
            ensure_chains()
            return ifaces
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2)
    raise RuntimeError(f"NICs not ready: {last_err}")


def watch_loop() -> None:
    """Watch the policy ConfigMap; short watch timeouts double as heartbeats.

    Each apiserver watch ends after ``KMC_HEARTBEAT_SECONDS`` (or on event), at
    which point we patch the heartbeat annotation and reconnect. A full GET
    resync runs every ``KMC_RESYNC_SECONDS``.
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
                cm = fetch_configmap()
                resource_version = str((cm.get("metadata") or {}).get("resourceVersion") or "")
                reconcile_from_cm(cm, force=True)
                last_resync = time.time()
            except Exception as e:  # noqa: BLE001
                log(f"resync failed: {e}")
                patch_status("Error", "", str(e))
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
        path = f"/api/v1/namespaces/{urllib.parse.quote(KMC_NAMESPACE)}/configmaps?{qs}"
        resp = None
        saw_event = False
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
                    break  # stream closed (normal watch timeout)
                if isinstance(line, (bytes, bytearray)):
                    line = line.decode("utf-8")
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    log(f"skipping non-json watch line: {line[:80]}")
                    continue

                etype = event.get("type")
                obj = event.get("object") or {}

                if etype == "ERROR" or obj.get("kind") == "Status":
                    code = obj.get("code")
                    reason = obj.get("reason") or obj.get("message") or "watch error"
                    log(f"watch error: {reason} (code={code})")
                    if code == 410 or reason == "Expired" or "too old" in str(reason).lower():
                        resource_version = ""
                        LAST_RV_FILE.unlink(missing_ok=True)
                    break

                if etype == "BOOKMARK":
                    rv = str((obj.get("metadata") or {}).get("resourceVersion") or "")
                    if rv:
                        resource_version = rv
                    continue

                if etype in ("ADDED", "MODIFIED", "DELETED"):
                    saw_event = True
                    rv = str((obj.get("metadata") or {}).get("resourceVersion") or "")
                    if rv:
                        resource_version = rv
                    if etype == "DELETED":
                        log("policy ConfigMap deleted")
                        patch_status("Error", "", "policy ConfigMap deleted")
                        continue
                    try:
                        reconcile_from_cm(obj, force=False)
                        last_resync = time.time()
                    except Exception as e:  # noqa: BLE001
                        log(f"reconcile from watch failed: {e}")

            # Quiet watch timeout → liveness heartbeat (also bumps RV via annotation).
            # Skip when we already patched status during an event-driven apply.
            if not _shutdown and not saw_event:
                patch_status("Ready", "", "", heartbeat_only=True)

        except Exception as e:  # noqa: BLE001
            if _shutdown:
                break
            log(f"watch failed: {e}")
            time.sleep(KMC_RECONNECT_SECONDS)
        finally:
            if resp is not None:
                try:
                    resp.close()
                except Exception:  # noqa: BLE001
                    pass


def handle_signal(signum: int, _frame: Any) -> None:
    global _shutdown
    log(f"signal {signum}, shutting down")
    _shutdown = True


def cmd_once() -> int:
    try:
        wait_for_nics()
        cm = fetch_configmap()
        reconcile_from_cm(cm, force=True)
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"once failed: {e}")
        traceback.print_exc(file=sys.stderr)
        try:
            patch_status("Error", "", str(e))
        except Exception:  # noqa: BLE001
            pass
        return 1


def cmd_run() -> int:
    log(
        f"starting (ns={KMC_NAMESPACE} cm={KMC_POLICY_CM} "
        f"heartbeat={KMC_HEARTBEAT_SECONDS}s agent={running_script_sha()[:12]})"
    )
    try:
        wait_for_nics()
    except Exception as e:  # noqa: BLE001
        log(f"NIC wait failed: {e}")
        patch_status("Error", "", str(e))
        return 1
    watch_loop()
    return 0


def main(argv: list[str]) -> int:
    load_env_file(ENV_FILE)
    apply_config_from_env()
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    action = argv[1] if len(argv) > 1 else "run"
    if action == "once":
        return cmd_once()
    if action == "run":
        return cmd_run()
    log(f"usage: {argv[0]} [run|once]")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
