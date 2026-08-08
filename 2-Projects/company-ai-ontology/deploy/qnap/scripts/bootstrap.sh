#!/bin/sh
set -eu

HOT_DATA_ROOT=${HOT_DATA_ROOT:-/share/CACHEDEV1_DATA/ai-ontology}
BACKUP_ROOT=${BACKUP_ROOT:-/share/CACHEDEV2_DATA/ai-ontology-backup}
PROJECT_ROOT=${PROJECT_ROOT:-$HOT_DATA_ROOT/foundation}
ENV_FILE=$PROJECT_ROOT/.env

random_hex() {
  first=$(sed 's/-//g' /proc/sys/kernel/random/uuid)
  second=$(sed 's/-//g' /proc/sys/kernel/random/uuid)
  printf '%s%s' "$first" "$second"
}

mkdir -p "$HOT_DATA_ROOT/data/caddy" "$HOT_DATA_ROOT/config/caddy" "$BACKUP_ROOT"
chmod 750 "$HOT_DATA_ROOT" "$HOT_DATA_ROOT/data" "$HOT_DATA_ROOT/config" "$BACKUP_ROOT"
chmod 755 "$PROJECT_ROOT/initdb"
chmod 644 "$PROJECT_ROOT/initdb"/*
chmod 755 "$PROJECT_ROOT/config"
chmod 644 "$PROJECT_ROOT/config"/*

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
HOT_DATA_ROOT=$HOT_DATA_ROOT
BACKUP_ROOT=$BACKUP_ROOT
POSTGRES_PASSWORD=$(random_hex 32)
POSTGRES_BACKUP_PASSWORD=$(random_hex 32)
ONTOLOGY_APP_PASSWORD=$(random_hex 32)
ONTOLOGY_READONLY_PASSWORD=$(random_hex 32)
ACTION_GATEWAY_PASSWORD=$(random_hex 32)
ACTION_GATEWAY_CONTROL_TOKEN=$(random_hex 32)
ACTION_GATEWAY_BUILD_CONTEXT=$HOT_DATA_ROOT/action-gateway-source
KNOWLEDGE_CONNECTOR_PASSWORD=$(random_hex 32)
KNOWLEDGE_CONNECTOR_CONTROL_TOKEN=$(random_hex 32)
KNOWLEDGE_CONNECTOR_BUILD_CONTEXT=$HOT_DATA_ROOT/knowledge-connector-source
ONTOLOGY_REGISTRY_PASSWORD=$(random_hex 32)
ONTOLOGY_REGISTRY_CONTROL_TOKEN=$(random_hex 32)
ONTOLOGY_REGISTRY_BUILD_CONTEXT=$HOT_DATA_ROOT/ontology-registry-source
FEISHU_KNOWLEDGE_DISCOVER_PUBLIC_TEAM_SPACES=1
FEISHU_KNOWLEDGE_SPACE_IDS=
FEISHU_KNOWLEDGE_RESOURCES_B64=W10=
REDIS_PASSWORD=$(random_hex 32)
QDRANT_API_KEY=$(random_hex 32)
AGENT_CORE_HMAC_SECRET=$(random_hex 32)
AGENT_CORE_BUILD_CONTEXT=$HOT_DATA_ROOT/agent-core-source
H_LITE_SHADOW_TOKEN=$(random_hex 32)
H_LITE_BUILD_CONTEXT=$HOT_DATA_ROOT/h-lite-source
H_COMPANY_RUNTIME_MODE=shadow
FUTURUS_TENANT_ID=$(cat /proc/sys/kernel/random/uuid)
EOF
  chmod 600 "$ENV_FILE"
fi

if ! grep -q '^AGENT_CORE_HMAC_SECRET=' "$ENV_FILE"; then
  umask 077
  printf 'AGENT_CORE_HMAC_SECRET=%s\n' "$(random_hex 32)" >> "$ENV_FILE"
fi

if ! grep -q '^AGENT_CORE_BUILD_CONTEXT=' "$ENV_FILE"; then
  printf 'AGENT_CORE_BUILD_CONTEXT=%s\n' "$HOT_DATA_ROOT/agent-core-source" >> "$ENV_FILE"
fi

if ! grep -q '^H_LITE_SHADOW_TOKEN=' "$ENV_FILE"; then
  umask 077
  printf 'H_LITE_SHADOW_TOKEN=%s\n' "$(random_hex 32)" >> "$ENV_FILE"
fi

if ! grep -q '^H_LITE_BUILD_CONTEXT=' "$ENV_FILE"; then
  printf 'H_LITE_BUILD_CONTEXT=%s\n' "$HOT_DATA_ROOT/h-lite-source" >> "$ENV_FILE"
fi

if ! grep -q '^H_COMPANY_RUNTIME_MODE=' "$ENV_FILE"; then
  printf 'H_COMPANY_RUNTIME_MODE=shadow\n' >> "$ENV_FILE"
fi

if ! grep -q '^ACTION_GATEWAY_CONTROL_TOKEN=' "$ENV_FILE"; then
  umask 077
  printf 'ACTION_GATEWAY_CONTROL_TOKEN=%s\n' "$(random_hex 32)" >> "$ENV_FILE"
fi

if ! grep -q '^ACTION_GATEWAY_BUILD_CONTEXT=' "$ENV_FILE"; then
  printf 'ACTION_GATEWAY_BUILD_CONTEXT=%s\n' "$HOT_DATA_ROOT/action-gateway-source" >> "$ENV_FILE"
fi

if ! grep -q '^KNOWLEDGE_CONNECTOR_PASSWORD=' "$ENV_FILE"; then
  umask 077
  printf 'KNOWLEDGE_CONNECTOR_PASSWORD=%s\n' "$(random_hex 32)" >> "$ENV_FILE"
fi

if ! grep -q '^KNOWLEDGE_CONNECTOR_CONTROL_TOKEN=' "$ENV_FILE"; then
  umask 077
  printf 'KNOWLEDGE_CONNECTOR_CONTROL_TOKEN=%s\n' "$(random_hex 32)" >> "$ENV_FILE"
fi

if ! grep -q '^KNOWLEDGE_CONNECTOR_BUILD_CONTEXT=' "$ENV_FILE"; then
  printf 'KNOWLEDGE_CONNECTOR_BUILD_CONTEXT=%s\n' "$HOT_DATA_ROOT/knowledge-connector-source" >> "$ENV_FILE"
fi

if ! grep -q '^ONTOLOGY_REGISTRY_PASSWORD=' "$ENV_FILE"; then
  umask 077
  printf 'ONTOLOGY_REGISTRY_PASSWORD=%s\n' "$(random_hex 32)" >> "$ENV_FILE"
fi

if ! grep -q '^ONTOLOGY_REGISTRY_CONTROL_TOKEN=' "$ENV_FILE"; then
  umask 077
  printf 'ONTOLOGY_REGISTRY_CONTROL_TOKEN=%s\n' "$(random_hex 32)" >> "$ENV_FILE"
fi

if ! grep -q '^ONTOLOGY_REGISTRY_BUILD_CONTEXT=' "$ENV_FILE"; then
  printf 'ONTOLOGY_REGISTRY_BUILD_CONTEXT=%s\n' "$HOT_DATA_ROOT/ontology-registry-source" >> "$ENV_FILE"
fi

if ! grep -q '^FEISHU_KNOWLEDGE_DISCOVER_PUBLIC_TEAM_SPACES=' "$ENV_FILE"; then
  printf 'FEISHU_KNOWLEDGE_DISCOVER_PUBLIC_TEAM_SPACES=1\n' >> "$ENV_FILE"
fi

if ! grep -q '^FEISHU_KNOWLEDGE_SPACE_IDS=' "$ENV_FILE"; then
  printf 'FEISHU_KNOWLEDGE_SPACE_IDS=\n' >> "$ENV_FILE"
fi

if ! grep -q '^FEISHU_KNOWLEDGE_RESOURCES_B64=' "$ENV_FILE"; then
  printf 'FEISHU_KNOWLEDGE_RESOURCES_B64=W10=\n' >> "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"

cd "$PROJECT_ROOT"
docker_path=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker

"$docker_path" compose config --quiet
"$docker_path" compose pull
"$docker_path" compose up -d foundation-init postgres
PROJECT_ROOT="$PROJECT_ROOT" "$PROJECT_ROOT/scripts/migrate.sh"
"$docker_path" compose up -d --build

printf 'QNAP Foundation bootstrap completed.\n'
