#!/bin/sh
set -eu
exec </dev/null
umask 077

phase=${1:?phase is required}
output_file=${2:?output file is required}
case "$phase" in preparation|before|after|rollback_before|rollback_previous|rollback_restored) ;; *) echo 'Goal 7 deployment state phase invalid' >&2; exit 1 ;; esac
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'Goal 7 deployment state Node runtime unavailable' >&2; exit 2; }
case "$output_file" in "$shadow_root"/*) ;; *) echo 'Goal 7 deployment state output must remain under strategic intelligence root' >&2; exit 2 ;; esac

cd "$foundation_root"
set -a
. ./.env
set +a

temporary_root=$(mktemp -d "$shadow_root/goal7-deployment-state.XXXXXX")
trap 'rm -rf "$temporary_root"' EXIT INT TERM
agent_file=$temporary_root/agent.json
connector_file=$temporary_root/connector.json
h_lite_file=$temporary_root/h-lite.json
registry_file=$temporary_root/registry.json
foundation_file=$temporary_root/foundation.tsv
migration_file=$temporary_root/migration.txt

"$docker_path" compose exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify(p))}).catch(()=>process.exit(1))" \
  > "$agent_file"
"$docker_path" compose exec -T knowledge-connector node -e \
  "fetch('http://127.0.0.1:8083/readyz').then(async r=>{const p=await r.json();if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify(p))}).catch(()=>process.exit(1))" \
  > "$connector_file"
"$docker_path" compose exec -T h-lite node -e \
  "Promise.all([fetch('http://127.0.0.1:8081/healthz'),fetch('http://127.0.0.1:8081/readyz')]).then(async rs=>{const p=await Promise.all(rs.map(r=>r.json()));if(!rs.every(r=>r.ok))process.exit(1);process.stdout.write(JSON.stringify({health:p[0],ready:p[1]}))}).catch(()=>process.exit(1))" \
  > "$h_lite_file"
"$docker_path" compose exec -T ontology-registry node -e \
  "fetch('http://127.0.0.1:8084/readyz').then(async r=>{const p=await r.json();if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify(p))}).catch(()=>process.exit(1))" \
  > "$registry_file"

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 --username ontology_admin --dbname ontology -qAtc \
  "SELECT (to_regclass('iam.principal_memberships') IS NOT NULL AND to_regclass('work.conversation_authority_snapshots') IS NOT NULL AND to_regclass('runtime.h_engine_route_state') IS NOT NULL AND to_regclass('runtime.h_engine_usage_events') IS NOT NULL)::text" \
  > "$migration_file"

: > "$foundation_file"
for container_id in $($docker_path ps -q --filter label=com.docker.compose.project=company-ai-foundation); do
  "$docker_path" inspect --format '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{json .NetworkSettings.Ports}}' "$container_id" >> "$foundation_file"
done
LC_ALL=C sort -o "$foundation_file" "$foundation_file"

mkdir -p "$(dirname "$output_file")"
temporary_output=$output_file.partial
"$node_bin" -e '
const fs=require("fs"),crypto=require("crypto");
const [phase,agentPath,connectorPath,hLitePath,registryPath,foundationPath,migrationPath,outputPath]=process.argv.slice(1);
const readJson=(file)=>JSON.parse(fs.readFileSync(file,"utf8"));
const agent=readJson(agentPath),connector=readJson(connectorPath),hLite=readJson(hLitePath),registry=readJson(registryPath);
const rows=fs.readFileSync(foundationPath,"utf8").split("\n").filter(Boolean).map((line)=>line.split("|"));
const publishedPortCount=rows.reduce((total,row)=>{const ports=JSON.parse(row[5]||"{}");return total+Object.values(ports).reduce((sum,value)=>sum+(Array.isArray(value)?value.length:0),0)},0);
const governance=agent.runtime?.governance||{};
const routeA=governance.routeA||{};
const routeB=governance.routeB||{};
const state={
  snapshotVersion:"1.0.0",
  evidenceType:"goal7-deployment-state",
  phase,
  capturedAt:new Date().toISOString(),
  companyQnapIdentity:"qnap:company/prnas/TS-X65",
  activeOntologySchema:String(registry.active?.schemaVersion||registry.active?.version||""),
  registryStatus:String(registry.status||""),
  candidateMigration012Applied:fs.readFileSync(migrationPath,"utf8").trim()==="true",
  components:{
    agentCore:{version:String(agent.contractVersion||""),sourceCommit:agent.sourceCommit||null,ready:agent.ok===true,productionReady:agent.productionReady===true},
    knowledgeConnector:{version:String(connector.version||""),sourceCommit:connector.sourceCommit||null,ready:connector.ok===true,productionReady:connector.database?.ready===true},
    hLite:{version:String(hLite.health?.serviceVersion||""),sourceCommit:hLite.health?.sourceCommit||null,ready:hLite.ready?.ok===true,mode:String(hLite.health?.mode||""),subscriptionEnabled:hLite.health?.subscriptionEnabled===true},
  },
  foundation:{
    criticalContainerCount:rows.length,
    unhealthyContainerCount:rows.filter((row)=>row[2]!=="running"||(row[3]!=="none"&&row[3]!=="healthy")).length,
    restartCountTotal:rows.reduce((sum,row)=>sum+Number(row[4]||0),0),
    publishedPortCount,
    fingerprint:crypto.createHash("sha256").update(fs.readFileSync(foundationPath)).digest("hex"),
  },
  routeState:{routeAOperational:agent.productionReady===true&&routeA.enabled===true&&routeA.circuitState!=="open",routeBEnabled:routeB.enabled===true},
};
fs.writeFileSync(outputPath,JSON.stringify(state,null,2)+"\n",{mode:0o600});
' "$phase" "$agent_file" "$connector_file" "$h_lite_file" "$registry_file" "$foundation_file" "$migration_file" "$temporary_output"
chmod 600 "$temporary_output"
mv "$temporary_output" "$output_file"
printf 'goal7_deployment_state=%s\nphase=%s\n' "$output_file" "$phase"
