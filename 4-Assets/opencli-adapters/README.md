# OpenCLI 自定义适配器备份

> User-level OpenCLI custom adapters, backed up for git tracking + cross-device sync.

## 实际部署位置

```bash
~/.opencli/clis/boss/      # BOSS 直聘 — 3 求职端只读命令 + 1 共享基础
~/.opencli/clis/liepin/    # 猎聘 — 7 命令（DOM scraping + 官方 MCP API）
```

## 新机器恢复

```bash
mkdir -p ~/.opencli/clis
cp -r /Users/rayman.chen/mycc/4-Assets/opencli-adapters/boss ~/.opencli/clis/
cp -r /Users/rayman.chen/mycc/4-Assets/opencli-adapters/liepin ~/.opencli/clis/

# 猎聘 MCP API 需要 token（90 天有效，登录 https://www.liepin.com/mcp/server 生成）
mkdir -p ~/.opencli && chmod 700 ~/.opencli
echo 'LIEPIN_MCP_TOKEN=<your-token>' > ~/.opencli/.env
chmod 600 ~/.opencli/.env

opencli boss --help
opencli liepin --help
```

## 适配器清单

### BOSS 直聘（求职端聚焦）

| 命令 | 类型 | API endpoint | referer |
|------|------|-------------|---------|
| `interviews` | 读 | `/wapi/zpinterview/geek/interview/data.json` | `/web/geek/job` |
| `history` | 读 | `/wapi/zpgeek/history/joblist.json?page=N` | `/web/geek/history` |
| `deliver-list` | 读 | `/wapi/zprelation/resume/geekDeliverList?page=N` | `/web/geek/chat` |

共享基础 `utils-extra.js`：bossFetch（page.evaluate + XHR + cookie 复刻）+ 反风控节流工具（gaussian/createBurstTracker，备用）。

### 猎聘（求职端 + MCP API 双路径）

| 命令 | 类型 | 实现 |
|------|------|------|
| `search` | 浏览器 | DOM 抓取（含 salary/experience 编码筛选） |
| `detail` | 浏览器 | 职位详情 DOM 抓取 |
| `me` | 浏览器 | 当前登录用户信息 |
| `api-search` | API | 官方 MCP `user-search-job`（无需浏览器） |
| `apply` | API | 官方 MCP `user-apply-job` 投递 |
| `resume` | API | 官方 MCP `my-resume` 查看简历 |
| `resume-edit` | API | 官方 MCP `resume` 编辑简历模块 |

共享基础 `utils.js`：getMcpToken + callMcpTool（node:https 绕过 undici proxy）+ DOM 工具函数。

## 工程教训沉淀

详见 mycc memory：
- `feedback_opencli_custom_adapter.md` — opencli 自定义适配器工程模式
- `feedback_codex_api_template_guess.md` — codex 写 API 适配器幻觉与防护
- `feedback_undici_proxy_bypass.md` — Node 18+ 调外部 API 的代理污染

## 借鉴来源

- **boss-cli** (jackwener/boss-cli) — 反风控 Gaussian 节流策略 + BOSS 错误码处理
- **boss-agent-cli** (can4hou6joeng4/boss-agent-cli) — API endpoint 规范 + Pipeline / snapshot diff 思路
- **猎聘官方 MCP** (open-agent.liepin.com/mcp/user) — 求职官方 API 集成
- **mcp-jobs** (mergedao/mcp-jobs) — 评估发现已被内置 14 命令覆盖，未采用
