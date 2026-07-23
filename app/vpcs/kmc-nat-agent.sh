#!/bin/bash
# kmc-nat-agent — reconcile floating IPs from a policy ConfigMap
set -euo pipefail

ENV_FILE="${KMC_ENV_FILE:-/etc/kmc/nat-agent.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

: "${KMC_NAMESPACE:?KMC_NAMESPACE required}"
: "${KMC_POLICY_CM:?KMC_POLICY_CM required}"
: "${KMC_PRIVATE_MAC:?KMC_PRIVATE_MAC required}"
: "${KMC_PUBLIC_MAC:?KMC_PUBLIC_MAC required}"
: "${KUBECONFIG:=/etc/kmc/kubeconfig}"
: "${KMC_APISERVER:?KMC_APISERVER required}"
: "${KMC_POLL_SECONDS:=30}"
: "${KMC_POLICY_KEY:=policy.json}"
: "${KMC_STATE_DIR:=/var/lib/kmc}"
: "${KMC_CA_FILE:=/etc/kmc/ca.crt}"

export KUBECONFIG
mkdir -p "$KMC_STATE_DIR"
LAST_RV_FILE="$KMC_STATE_DIR/last-resource-version"
APPLIED_FILE="$KMC_STATE_DIR/applied-policy.json"

log() { echo "kmc-nat-agent: $*" >&2; }

if_by_mac() {
  local want="$1" path iface mac
  want=$(echo "$want" | tr '[:upper:]' '[:lower:]')
  for path in /sys/class/net/*; do
    iface=$(basename "$path")
    [[ "$iface" == "lo" ]] && continue
    [[ -f "$path/address" ]] || continue
    mac=$(tr '[:upper:]' '[:lower:]' < "$path/address")
    if [[ "$mac" == "$want" ]]; then
      echo "$iface"
      return 0
    fi
  done
  return 1
}

resolve_ifaces() {
  PRIVATE_IF=$(if_by_mac "$KMC_PRIVATE_MAC") || {
    log "private NIC not found for $KMC_PRIVATE_MAC"
    return 1
  }
  PUBLIC_IF=$(if_by_mac "$KMC_PUBLIC_MAC") || {
    log "public NIC not found for $KMC_PUBLIC_MAC"
    return 1
  }
}

ensure_chains() {
  iptables -t nat -N KMC_FLOAT_PRE 2>/dev/null || true
  iptables -t nat -N KMC_FLOAT_POST 2>/dev/null || true
  iptables -N KMC_FLOAT_FWD 2>/dev/null || true

  iptables -t nat -C PREROUTING -j KMC_FLOAT_PRE 2>/dev/null || \
    iptables -t nat -I PREROUTING 1 -j KMC_FLOAT_PRE
  # Insert SNAT before general MASQUERADE
  iptables -t nat -C POSTROUTING -j KMC_FLOAT_POST 2>/dev/null || \
    iptables -t nat -I POSTROUTING 1 -j KMC_FLOAT_POST
  iptables -C FORWARD -j KMC_FLOAT_FWD 2>/dev/null || \
    iptables -I FORWARD 1 -j KMC_FLOAT_FWD
}

token_from_kubeconfig() {
  # Prefer KUBE_TOKEN env; else crude extract from kubeconfig
  if [[ -n "${KUBE_TOKEN:-}" ]]; then
    echo "$KUBE_TOKEN"
    return
  fi
  awk '/token:/ {print $2; exit}' "$KUBECONFIG" 2>/dev/null || true
}

api_curl() {
  local method="$1" path="$2"
  shift 2
  local token
  token=$(token_from_kubeconfig)
  local args=(
    -sS -X "$method"
    --cacert "$KMC_CA_FILE"
    -H "Authorization: Bearer $token"
    -H "Accept: application/json"
  )
  if [[ "$method" == "PATCH" ]]; then
    args+=(-H "Content-Type: application/strategic-merge-patch+json")
  fi
  curl "${args[@]}" "$KMC_APISERVER$path" "$@"
}

fetch_policy() {
  local path="/api/v1/namespaces/${KMC_NAMESPACE}/configmaps/${KMC_POLICY_CM}"
  api_curl GET "$path"
}

patch_status() {
  local status="$1" generation="$2" err="$3" applied_at
  applied_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  # Escape error for JSON
  err=${err//\\/\\\\}
  err=${err//"/\\"}
  err=${err//$'\n'/\\n}
  local body
  body=$(cat <<EOF
{"metadata":{"annotations":{
  "kmc.ianunruh.com/agent-status":"$status",
  "kmc.ianunruh.com/agent-observed-generation":"$generation",
  "kmc.ianunruh.com/agent-last-error":"$err",
  "kmc.ianunruh.com/agent-applied-at":"$applied_at"
}}}
EOF
)
  local path="/api/v1/namespaces/${KMC_NAMESPACE}/configmaps/${KMC_POLICY_CM}"
  api_curl PATCH "$path" -d "$body" >/dev/null || log "status patch failed"
}

# List secondary float addresses we manage (tagged via /32 or tracked file)
managed_floats_file="$KMC_STATE_DIR/managed-floats"

list_managed_floats() {
  if [[ -f "$managed_floats_file" ]]; then
    cat "$managed_floats_file"
  fi
}

set_managed_floats() {
  printf '%s\n' "$@" > "$managed_floats_file"
}

apply_policy_json() {
  local json="$1"
  resolve_ifaces
  ensure_chains

  iptables -t nat -F KMC_FLOAT_PRE
  iptables -t nat -F KMC_FLOAT_POST
  iptables -F KMC_FLOAT_FWD

  # Parse floats with python3 (reliable JSON)
  local parsed
  parsed=$(python3 - "$json" <<'PY'
import json, sys
raw = sys.argv[1]
try:
    doc = json.loads(raw)
except Exception as e:
    print("ERR " + str(e), file=sys.stderr)
    sys.exit(1)
gen = str(doc.get("metadata", {}).get("generation", doc.get("generation", "")))
floats = doc.get("floatingIPs") or []
print("GEN", gen)
for f in floats:
    pub = f.get("public", "").split("/")[0].strip()
    priv = f.get("private", "").split("/")[0].strip()
    prefix = int(f.get("prefix") or 32)
    if not pub or not priv:
        continue
    print(f"FIP {pub} {prefix} {priv}")
PY
)

  local generation=""
  local -a new_floats=()
  while read -r kind a b c; do
    [[ -z "${kind:-}" ]] && continue
    if [[ "$kind" == "GEN" ]]; then
      generation="$a"
    elif [[ "$kind" == "FIP" ]]; then
      new_floats+=("$a/$b")
      local pub="$a" prefix="$b" priv="$c"
      # Own the public address on the public NIC
      if ! ip -4 addr show dev "$PUBLIC_IF" | grep -qw "$pub"; then
        ip addr add "$pub/$prefix" dev "$PUBLIC_IF" || true
      fi
      iptables -t nat -A KMC_FLOAT_PRE -d "$pub/32" -j DNAT --to-destination "$priv"
      iptables -t nat -A KMC_FLOAT_POST -s "$priv/32" -o "$PUBLIC_IF" -j SNAT --to-source "$pub"
      iptables -A KMC_FLOAT_FWD -d "$priv/32" -j ACCEPT
      iptables -A KMC_FLOAT_FWD -s "$priv/32" -j ACCEPT
    fi
  done <<< "$parsed"

  # Remove managed floats no longer desired
  local old
  while read -r old; do
    [[ -z "$old" ]] && continue
    local old_ip="${old%%/*}"
    local keep=0
    local nf
    for nf in "${new_floats[@]+"${new_floats[@]}"}"; do
      if [[ "${nf%%/*}" == "$old_ip" ]]; then keep=1; break; fi
    done
    if [[ "$keep" -eq 0 ]]; then
      ip addr del "$old" dev "$PUBLIC_IF" 2>/dev/null || \
        ip addr del "$old_ip/32" dev "$PUBLIC_IF" 2>/dev/null || true
    fi
  done < <(list_managed_floats)

  set_managed_floats "${new_floats[@]+"${new_floats[@]}"}"
  printf '%s' "$json" > "$APPLIED_FILE"
  echo "$generation"
}

reconcile_once() {
  local body policy rv generation status_err
  body=$(fetch_policy) || {
    log "fetch policy failed"
    patch_status "Error" "" "fetch policy failed"
    return 1
  }
  rv=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("metadata",{}).get("resourceVersion",""))' <<<"$body")
  policy=$(python3 -c '
import json,sys
cm=json.load(sys.stdin)
data=cm.get("data") or {}
print(data.get("'"$KMC_POLICY_KEY"'", "") or "{}")
' <<<"$body")

  if [[ -f "$LAST_RV_FILE" ]] && [[ "$(cat "$LAST_RV_FILE")" == "$rv" ]] && [[ -f "$APPLIED_FILE" ]]; then
    return 0
  fi

  set +e
  generation=$(apply_policy_json "$policy" 2>/tmp/kmc-nat-agent-apply.err)
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    status_err=$(cat /tmp/kmc-nat-agent-apply.err 2>/dev/null | tr '\n' ' ' | head -c 500)
    log "apply failed: $status_err"
    patch_status "Error" "" "${status_err:-apply failed}"
    return 1
  fi
  echo "$rv" > "$LAST_RV_FILE"
  patch_status "Ready" "${generation:-}" ""
  log "applied generation=${generation:-?} rv=$rv"
}

main_loop() {
  log "starting (ns=$KMC_NAMESPACE cm=$KMC_POLICY_CM poll=${KMC_POLL_SECONDS}s)"
  # Wait for NICs (cloud-init / DHCP)
  local i
  for i in $(seq 1 60); do
    if resolve_ifaces 2>/dev/null; then break; fi
    sleep 2
  done
  resolve_ifaces
  ensure_chains

  while true; do
    reconcile_once || true
    sleep "$KMC_POLL_SECONDS"
  done
}

case "${1:-run}" in
  once) resolve_ifaces; ensure_chains; reconcile_once ;;
  run) main_loop ;;
  *) log "usage: $0 [run|once]"; exit 2 ;;
esac
