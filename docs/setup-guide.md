# 新机器初始化清单

> 本仓库在 Windows 和 macOS 两台电脑上共用，单分支（main），不拆 OS 分支。

## 核心原则

- **共享的**（提交到 git）：CLAUDE.md、所有 SKILL.md、skills 代码、文档、4-Assets/ 等
- **本地的**（gitignore，不提交）：`.env`、`.claude/settings.local.json`、二进制文件、`current.json`
- **OS 差异由代码处理**：`platform.ts` 运行时自动检测平台，不需要手动配置

## 初始化步骤

拉取代码后，需要在本地完成：

1. 复制 `.env.example` → `.env`，填入凭证
2. `cd .claude/skills/mycc/scripts && npm install`
3. 安装 cloudflared（macOS: `brew install cloudflared`，Windows: 下载 exe 到项目根目录）
4. 配置 `.claude/settings.local.json`（hooks、MCP 等本地设置）
5. 如需飞书 MCP：使用 `open-feishu-mcp`，不要再安装或调用旧的官方飞书 MCP

## 什么文件不提交

| 文件 | 原因 |
|------|------|
| `.env` | 各机器凭证不同 |
| `.claude/settings.local.json` | 本地 hooks、MCP 路径不同 |
| `cloudflared` / `cloudflared.exe` | OS 特定二进制 |
| `.claude/skills/mycc/current.json` | 运行时生成 |
| `node_modules/` | 各机器自行安装 |

## 提交规范

- 修改 skills / CLAUDE.md / 共享文档后，正常 commit + push
- **不要提交** OS 特定的配置或二进制文件
- 两台电脑改了同一个文件 → 正常 pull 合并，有冲突手动解决
