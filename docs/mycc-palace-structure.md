# mycc 结构治理（脚本配套说明）

> **定位**：本文件是 `mycc-lint-structure.sh` / `mycc-route-file.sh` 两个检查脚本的配套说明 + 空间命名速查，**不是真相源**。
>
> 真相源以现有文档为准，本文件只做指引、不重复定义：
> - **文件归档规则** → 以 `CLAUDE.md` P0 §5「文件归档铁律」为准。
> - **记忆系统**（分层、写入、检索、遗忘） → 以 `docs/memory-system.md` 为准。**本文件不再自定义记忆分层**（旧 L0–L4 表已删除，避免与 memory-system.md 漂移）。
>
> 原则：先跑起来再迭代，只做路由、检查和清单，不做自动迁移。

## 1. 空间命名速查

mycc 的 `0-5` 目录沿用 `CLAUDE.md` §5 的归档铁律，这里只补一层空间化别名（便于沟通，不改变归档规则）：

| 区域 | 空间别名 | 定位（详细规则见 CLAUDE.md §5） |
|------|----------|----------|
| `0-System` | Palace Core | 系统状态、记忆、任务日志（symlink 到 `~/.mycc-global/0-System`） |
| `1-Inbox` | Intake Hall | 临时想法、研究过程、未判定去向的材料 |
| `2-Projects` | Project Wings | 正在推进的项目，每个子目录是一个项目房间 |
| `3-Thinking` | Doctrine Wing | 方法论、认知框架、经过提炼的判断 |
| `4-Assets` | Tool Wing | SOP、模板、脚本、可复用素材 |
| `5-Archive` | Cold Storage | 不再活跃但有参考价值的历史材料 |
| `tasks` | Active Queue | 跨 session 的短期任务队列 |

不确定放哪里时的默认动作（与 CLAUDE.md §5 铁律 3 一致）：

```text
先放 1-Inbox/YYYY-MM-DD-主题.md，再在整理时迁移。
```

> 记忆类写入（`memory-items.md` / `RECENT_EVENTS.md` / `MEMORY.md`）请直接遵循 `docs/memory-system.md`，不要走本文件或 route 脚本——那是一套独立的、更精密的记忆架构（Resource→Item→Category + 版本链 + 向量检索 + 主动遗忘）。

## 2. 检查项与阈值（对应 lint 脚本）

`mycc-lint-structure.sh` 只读检查以下项，红=阻断、黄=提醒、绿=通过：

| 检查项 | 阈值 | 级别 |
|--------|------|------|
| `0-System` symlink 可读 | 必须可读 | 不可读=红 |
| 根目录非白名单散落项 | 越少越好 | 有=黄（只提醒，不移动） |
| `1-Inbox` 文件数 | ≤ 20 | 超过=黄 |
| `1-Inbox` 超 7 天待处理项 | 越少越好 | 有=黄 |
| `2-Projects` 缺 `README.md` 的项目 | 0 | 有=黄 |
| `tasks` 活跃项 | ≤ 5 | 超过=黄 |

> 阈值（20 / 7天 / 5）是初版经验值，按老板真实工作节奏调整脚本即可，不是硬规则。

## 3. 项目房间规则

`2-Projects/<project>/README.md` 是项目状态卡。**补状态卡前必须先分类**（见下），不要对所有缺 README 的目录一刀切：

| 项目类型 | 处理方式 |
|----------|----------|
| 老板自有项目（在推进/暂停/已完成） | 补完整状态卡，用 `4-Assets/Templates/project-README-template.md` |
| 第三方工具本地部署（如 sing-box、ncm-cli、gpustack 集群配置） | 不套产品状态卡，最多放一行「来源 + 用途」说明 |
| 空壳/占位目录（无实质内容） | 不补 README，确认后归档或删除 |

自有项目状态卡至少包含：状态（active/paused/done/archived）、最后活跃日期、下一步、归档条件、一句话目标、当前事实、关键入口、外部 repo/服务/端口/负责人。

项目目录失控的处理顺序：先分类 → 自有项目补状态卡 → 第三方/空壳列清单等确认 → 迁移或删除前列清单并等待确认。

## 4. 根目录治理规则

根目录白名单硬编码在 `mycc-lint-structure.sh` 的 `is_root_whitelisted()` 中（一级空间 + 规则入口 + 启停脚本 + 必要配置 + 已知工具目录）。

根目录出现不在白名单内的项时，脚本**只做候选提醒**：

```text
候选散落项 -> 先确认用途 -> 决定移到 Inbox / Projects / Assets / Archive / 删除
```

> 注意：白名单是人工维护的，新增的合法工具目录需要手动加入白名单，否则会被误报为散落项。

## 5. `0-System` 入口规则

`0-System` 是指向 `~/.mycc-global/0-System` 的 tracked symlink（共享外置状态），**不是 canonical 记忆源**。

1. `0-System` 应为可读入口；若是 symlink，目标必须存在且可读。
2. symlink 失效时，最小修复：`ln -sfn ../.mycc-global/0-System 0-System`（仅在老板确认后执行）。
3. `0-System.old` 只作旧数据来源，不直接覆盖 `0-System`。
4. 不修改 canonical 记忆源 `~/.claude/projects/-Users-rayman-chen-mycc/memory/`，除非老板明确授权。

> ⚠️ 待澄清的底层债：canonical 记忆源（`~/.claude/.../memory/`）、共享外置状态（`~/.mycc-global/0-System`）、只读镜像三者的同步关系，在 `CLAUDE.md` §4 与 `memory-system.md` 中表述并不完全一致。涉及记忆写入路径的治理动作，需先澄清此拓扑再动。

本轮盘点结果：

```text
0-System -> ../.mycc-global/0-System
状态：symlink 可读
结论：当前不需要修复入口
```

## 6. 执行工具

| 工具 | 用途 |
|------|------|
| `4-Assets/scripts/mycc-lint-structure.sh` | 只读检查目录结构、入口、散落文件、任务积压 |
| `4-Assets/scripts/mycc-route-file.sh` | 根据用途和标题输出建议路径，不创建文件 |
| `4-Assets/Templates/project-README-template.md` | 新项目状态卡模板 |
| `tasks/mycc-structure-governance.md` | 本轮发现的问题和分阶段治理清单 |

这些工具默认不移动、不删除、不改记忆内容。
