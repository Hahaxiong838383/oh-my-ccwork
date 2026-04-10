#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "=== cc-agent 基础设施部署 ==="

# 检查 Docker
docker compose version || { echo "需要 Docker Compose"; exit 1; }

# 创建数据目录
mkdir -p data/postgres data/one-api data/files

# 启动容器
docker compose up -d

# 等待 PG 就绪
echo "等待 PostgreSQL 启动..."
for i in $(seq 1 30); do
    if docker exec cc-postgres pg_isready -U cc -d cc_agent > /dev/null 2>&1; then
        echo "PostgreSQL 就绪！"
        break
    fi
    sleep 1
done

# 验证 PGroonga
echo "验证 PGroonga..."
docker exec cc-postgres psql -U cc -d cc_agent -c "SELECT pgroonga_version();"

# 验证表
echo "验证数据表..."
docker exec cc-postgres psql -U cc -d cc_agent -c "\dt"

echo ""
echo "=== 部署完成 ==="
echo "PostgreSQL: 127.0.0.1:5433 (user: cc, db: cc_agent)"
echo "One API:    http://127.0.0.1:3001 (首次访问设置管理员密码)"
echo ""
