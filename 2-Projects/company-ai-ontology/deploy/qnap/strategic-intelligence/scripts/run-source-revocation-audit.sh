#!/bin/sh
set -eu
exec </dev/null

request_key=${1:?request key is required}
output_file=${2:?output file is required}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"

runtime_uid=$(id -u)
runtime_gid=$(id -g)
[ "$runtime_uid" -ne 0 ] || { echo 'revocation audit requires a non-root runtime' >&2; exit 1; }
[ -f "${SI_COLLECTOR_CONFIG_FILE:?SI_COLLECTOR_CONFIG_FILE is required}" ] || { echo 'collector config missing' >&2; exit 1; }
[ -f "${SI_SOURCE_REGISTRY_FILE:?SI_SOURCE_REGISTRY_FILE is required}" ] || { echo 'source registry missing' >&2; exit 1; }
[ -n "${SI_COLLECTOR_IMAGE:-}" ] || { echo 'collector image missing' >&2; exit 1; }

audit_root=$shadow_root/state/audits/$request_key-revocation
rm -rf "$audit_root"
mkdir -p "$audit_root/state" "$audit_root/reports"
chmod 750 "$audit_root" "$audit_root/state" "$audit_root/reports"
trap 'rm -rf "$audit_root"' EXIT INT TERM

audit_config=$audit_root/config.json
audit_registry=$audit_root/registry.json
audit_stderr=$audit_root/stderr.jsonl
node "$script_root/prepare-revocation-audit-fixture.mjs" \
  "$SI_COLLECTOR_CONFIG_FILE" "$SI_SOURCE_REGISTRY_FILE" "$audit_config" "$audit_registry" >/dev/null

started_epoch=$(date +%s)
set +e
"$docker_path" run --rm --network none --user "$runtime_uid:$runtime_gid" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  -v "$audit_config:/etc/company-intelligence/config.json:ro" \
  -v "$audit_registry:/etc/company-intelligence/source-registry.json:ro" \
  -v "$audit_root/state:/var/lib/company-intelligence/audit-state" \
  -v "$audit_root/reports:/var/lib/company-intelligence/audit-reports" \
  "$SI_COLLECTOR_IMAGE" run \
  --config /etc/company-intelligence/config.json \
  --registry /etc/company-intelligence/source-registry.json \
  >/dev/null 2>"$audit_stderr"
audit_exit=$?
set -e
completed_epoch=$(date +%s)
[ "$audit_exit" -ne 0 ] || { echo 'revoked source audit unexpectedly succeeded' >&2; exit 1; }
node -e "const fs=require('fs');const lines=fs.readFileSync(process.argv[1],'utf8').trim().split(/\\n/).filter(Boolean);const result=JSON.parse(lines.at(-1));if(result.errorCode!=='SOURCE_POLICY_DENIED')process.exit(1)" "$audit_stderr" \
  || { echo 'revoked source was not denied by policy' >&2; exit 1; }

duration=$((completed_epoch - started_epoch))
mkdir -p "$(dirname -- "$output_file")"
umask 077
node -e "const fs=require('fs');const value={auditVersion:'1.0.0',completed:true,reasonCode:'SOURCE_POLICY_DENIED',networkMode:'none',effectiveSeconds:Number(process.argv[2]),postRevocationNetworkRequestCount:0};fs.writeFileSync(process.argv[1],JSON.stringify(value,null,2)+'\\n',{mode:0o600})" "$output_file" "$duration"
