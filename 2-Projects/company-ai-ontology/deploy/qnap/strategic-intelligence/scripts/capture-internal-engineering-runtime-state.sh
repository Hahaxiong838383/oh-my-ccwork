#!/bin/sh
set -eu
exec </dev/null

phase=${1:?phase is required}
output_file=${2:?output file is required}
case "$phase" in before|after) ;; *) echo 'internal runtime state phase invalid' >&2; exit 1 ;; esac
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'internal runtime state Node runtime unavailable' >&2; exit 2; }

temporary_root=$(mktemp -d "$shadow_root/internal-runtime-state.XXXXXX")
trap 'rm -rf "$temporary_root"' EXIT INT TERM
foundation_rows=$temporary_root/foundation.tsv
strategic_rows=$temporary_root/strategic.tsv
network_rows=$temporary_root/networks.tsv
: > "$foundation_rows"
: > "$strategic_rows"
: > "$network_rows"

for container_id in $($docker_path ps -q --filter label=com.docker.compose.project=company-ai-foundation); do
  "$docker_path" inspect --format '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{json .NetworkSettings.Ports}}' "$container_id" >> "$foundation_rows"
done
for container_id in $($docker_path ps -aq --filter label=com.docker.compose.project=company-strategic-intelligence-shadow); do
  "$docker_path" inspect --format '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{json .NetworkSettings.Ports}}' "$container_id" >> "$strategic_rows"
done
for network_id in $($docker_path network ls -q --filter label=com.docker.compose.project=company-strategic-intelligence-shadow); do
  "$docker_path" network inspect --format '{{.Name}}|{{.ID}}' "$network_id" >> "$network_rows"
done
LC_ALL=C sort -o "$foundation_rows" "$foundation_rows"
LC_ALL=C sort -o "$strategic_rows" "$strategic_rows"
LC_ALL=C sort -o "$network_rows" "$network_rows"

"$node_bin" -e '
const fs=require("fs"),crypto=require("crypto");
const [phase,foundationFile,strategicFile,networkFile,output]=process.argv.slice(1);
const bytes=(file)=>fs.readFileSync(file);
const lines=(file)=>fs.readFileSync(file,"utf8").split("\n").filter(Boolean).map((line)=>line.split("|"));
const hash=(...values)=>crypto.createHash("sha256").update(Buffer.concat(values)).digest("hex");
const containers=(file)=>lines(file).map(([name,image,status,health,restart,ports])=>({name,image,status,health,restart:Number(restart),ports:JSON.parse(ports||"{}")}));
const portCount=(rows)=>rows.reduce((total,row)=>total+Object.values(row.ports||{}).reduce((count,bindings)=>count+(Array.isArray(bindings)?bindings.length:0),0),0);
const foundation=containers(foundationFile),strategic=containers(strategicFile),networks=lines(networkFile);
const outputValue={snapshotVersion:"1.0.0",phase,capturedAt:new Date().toISOString(),foundation:{containerCount:foundation.length,runningContainerCount:foundation.filter((row)=>row.status==="running").length,unhealthyContainerCount:foundation.filter((row)=>row.status!=="running"||(row.health!=="none"&&row.health!=="healthy")).length,restartCountTotal:foundation.reduce((sum,row)=>sum+row.restart,0),fingerprint:hash(bytes(foundationFile))},strategicIntelligence:{containerCount:strategic.length,runningContainerCount:strategic.filter((row)=>row.status==="running").length,networkCount:networks.length,publishedPortCount:portCount(strategic),fingerprint:hash(bytes(strategicFile),bytes(networkFile))}};
fs.writeFileSync(output,JSON.stringify(outputValue,null,2)+"\n",{mode:0o600});
' "$phase" "$foundation_rows" "$strategic_rows" "$network_rows" "$output_file"
