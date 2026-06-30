# mycc 结构治理迁移清单

> 创建：2026-06-17 | 状态：进行中

## 目标

在不大拆家的前提下，把 mycc 现有 `0-5` 目录体系升级为“空间索引 + 原文抽屉 + 分层记忆”的治理框架，并用脚本检查问题、用清单等待确认。

## 当前发现的问题清单

| 问题 | 当前状态 | 处理原则 |
|------|----------|----------|
| `0-System` 入口 | `0-System -> ../.mycc-global/0-System`，当前可读 | 暂不修复；仅持续检查 symlink 可读性 |
| L4 原文抽屉 | `0-System/drawers/` 当前不存在 | 先写入治理文档；创建前需老板确认 |
| 根目录散落文件 | 发现一批非白名单候选 | 只列清单，不移动、不删除 |
| Inbox 积压 | 17 个待处理项，未超过 20；其中多项超过 7 天 | 先提醒，后续确认去向 |
| 项目状态卡弱 | 19 个缺 README，分类后实为：自有 9 + 第三方部署 3 + 空壳/占位 7 | 仅 9 个自有项目补状态卡；空壳确认后归档、第三方一行说明 |
| tasks 积压 | 当前 7 个活跃项；本清单加入后会变 8 个 | 后续需要收敛或归档 |

## 根目录散落文件候选

以下只是候选，不代表要删除或移动：

- `CLAUDE.md.bak.20260428`
- `_migrate_0_system.sh`
- `error.log`
- `feishu-cli`
- `garden-gpt-image-2`
- `json`
- `kidsbench-eval`
- `output.png`
- `screenshots`
- `test_edit.txt`
- `备份（CLAUD.MD_20260322)`

待确认方向：

| 候选类型 | 可能去向 |
|----------|----------|
| 临时文件、日志、截图 | `1-Inbox/` 或确认删除 |
| 旧备份 | `5-Archive/legacy-docs/` 或 `5-Archive/legacy-scripts/` |
| 可复用脚本 | `4-Assets/scripts/` |
| 独立项目或外部 repo | `2-Projects/<project>/` 状态卡或保留根目录例外 |

## 缺 README 的项目清单（已分类，2026-06-17 按目录内容验证）

> 验证方法：`find <dir> -maxdepth 2 -type f` 统计实质文件数 + 看顶层条目。最终归属仍需老板确认。

### A 类：老板自有项目 → 补完整状态卡（9 个）

| 项目 | 实质内容线索 |
|------|--------------|
| `P003-product-definition` | 140 个文件，KidsHub 产品定义（多版本方案 + 原型） |
| `brain-product` | 31 个文件，大量 HANDOFF 交接文档 |
| `chenchuan-site` | 48 个文件，含 Dockerfile / directus / docker-compose（站点） |
| `evo-desktop-ai` | 44 个文件，evodesk，含 deploy / HANDOFF / 验收报告 |
| `futurus-rebuild` | 7 个文件，抓取/截图脚本 |
| `gesture interface` | 11 个文件，gesture_drag_demo |
| `cc-remote-v2` | 9 个文件，完整服务（server.js / tunnel-client / vite） |
| `cc-remote-v3` | 仅 `frpc.toml`，疑似 v2 的配置分支，内容极少 |
| `qwen-eval` | 仅 `HANDOFF-disk-cleanup.md`，评测项目残留 |

### B 类：第三方工具本地部署 → 一行「来源 + 用途」说明，不套产品状态卡（3 个）

| 项目 | 性质 |
|------|------|
| `sing-box` | 第三方代理工具：含 sing-box 二进制 + config.json + service + 日志 |
| `ncm-cli` | 第三方网易云 CLI 本地安装（仅 bin/），有同名 skill |
| `gpustack-cluster` | gpustack（第三方）集群部署配置，仅 HANDOFF.md |

### C 类：空壳/占位目录（depth2 无任何文件）→ 不补 README，确认后归档或删除（7 个）

`Claude-code-on-FNOS`、`OpenClash`、`ai-commit`、`ai-diff-review`、`ai-sentinel`、`app-needs-claw`、`clash-verge-rev`

> 这 7 个目录内两层无任何实质文件，可能是早期占位或未落地的想法。其中 `OpenClash` / `clash-verge-rev` 是第三方开源项目名。

建议做法：只对 A 类 9 个用 `4-Assets/Templates/project-README-template.md` 补状态卡；B 类加一行来源说明；C 类列清单等老板确认后归档到 `5-Archive/` 或删除。

## `0-System` 修复建议

当前检查：

```text
0-System -> ../.mycc-global/0-System
状态：可读
```

结论：当前无需修复。

如果后续 symlink 失效，最小修复方案是：

```bash
# 仅在老板确认后执行
ln -sfn ../.mycc-global/0-System 0-System
```

注意：

- 不用 `0-System.old` 覆盖当前 `0-System`
- 不改 canonical 记忆源 `~/.claude/projects/-Users-rayman-chen-mycc/memory/`

## `0-System.old` 迁移注意事项（已完结，2026-06-30 删除）

`0-System.old` 是 symlink 化（6-16）之前的旧实目录备份。2026-06-30 经老板确认删除，删前已验证现行 `~/.mycc-global/0-System`（symlink 真身）是其**严格超集**：

- `memory-items.md` 6-25 > old 6-13；`RECENT_EVENTS.md` 6-29 > old 6-15；`task-log.md` 6-30 > old 6-16；`status.md` 6-30 > old 6-16
- `memory.db` 两侧完全一致（同大小同时间）
- 无任何脚本/配置引用 `0-System.old`，且它从未被 git 跟踪

结论：旧备份无 live 缺失的事实，迁移保险条件满足，已 `rm -rf`。

## 分阶段 todo

### Phase 1：入口修复

- [x] 确认 `0-System` symlink 状态
- [x] 写入 symlink 最小修复方案
- [ ] 如后续失效，等待老板确认后再修复

### Phase 2：索引补齐

- [x] 新增 `docs/mycc-palace-structure.md`
- [x] 新增目录检查脚本
- [x] 新增文件路由脚本
- [ ] 确认是否允许创建 `0-System/drawers/`

### Phase 3：项目状态卡补齐

- [x] 新增项目 README 模板
- [x] 列出缺 README 的项目
- [ ] 按优先级补项目状态卡

### Phase 4：Inbox/Archive 清理

- [x] 列出 Inbox 超 7 天提醒
- [ ] 确认根目录散落项去向
- [ ] 确认旧备份、日志、截图是否归档或删除

### Phase 5：脚本接入工作流

- [x] 本轮手动运行 lint 和 route 脚本
- [ ] 决定是否在 session 开始或结束时手动跑 lint
- [ ] 决定是否把 route 脚本加入日常“新文件放哪里”流程

## 进度记录

- 2026-06-17：建立治理框架、只读检查脚本、路径建议脚本、项目 README 模板和迁移清单；未移动、未删除、未改 canonical 记忆源。
- 2026-06-17（cc 修订）：`palace-structure.md` 瘦身——删除与 `memory-system.md` 冲突的 L0–L4 记忆分层章节，「文件路由表」降级为指向 CLAUDE.md §5/memory-system.md 的配套说明；route 脚本记忆分支改为指回 memory-system.md（消除悬空的 `0-System/drawers/` 概念）；19 个缺 README 项目按目录内容验证后分为 A 自有 9 / B 第三方 3 / C 空壳 7 三类，Phase 3 只对 A 类补状态卡。
