# cc-agent — 自进化个人 AI Agent 系统

> 整合 Hermes Agent 的自进化引擎 + LLM Wiki 的知识管理 + 多模型网关。

**状态**：Phase 1 已部署（知识引擎 + 模型网关基础设施）

## 运行中的服务

| 服务 | 端口 | 说明 |
|------|------|------|
| PostgreSQL + PGroonga | 127.0.0.1:5433 | 知识库存储 + 中文全文搜索 |
| One API | 127.0.0.1:3001 | 多模型代理网关（需配置模型 API Key） |
| Wiki MCP | stdio | 知识引擎（5 个工具：guide/search/read/write/ingest） |
| Gateway MCP | stdio | 模型网关（3 个工具：llm_call/llm_models/llm_usage） |

## 快速操作

```bash
# 启动基础设施
cd 2-Projects/cc-agent && sudo docker compose up -d

# 验证
sudo docker ps --filter "name=cc-"
PGPASSWORD=ccagent2026 psql -h 127.0.0.1 -p 5433 -U cc -d cc_agent -c "\dt"

# 重新迁移知识
python3 scripts/migrate_existing.py
```

## One API 配置

1. 访问 http://127.0.0.1:3001 （初始账号 root/123456）
2. 添加模型渠道：DeepSeek / Qwen / Gemini 等
3. 生成 API Key，替换 `.mcp.json` 中的 `sk-placeholder`

## 目录结构

```
gateway/        模型路由（models.yml 配置 + router.py）
gateway_mcp/    Gateway MCP Server
wiki_mcp/       Wiki 知识引擎 MCP Server
scripts/        迁移脚本 + 配置模板
data/           PG 数据 + 文件存储（gitignore）
```
