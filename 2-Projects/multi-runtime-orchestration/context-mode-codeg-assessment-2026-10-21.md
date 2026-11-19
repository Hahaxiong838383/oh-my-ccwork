# context-mode 对当前 Codeg 工作模式的收益评估

2026-10-21，codex（OpenAI）。结论：值得作为按需工具小范围试用；现有证据不足以支持全 runtime 强制接入，或以宣传的 98% 推算整套工作流费用收益。

**用户决定（2026-10-21 21:12 CST）**：先不动，暂不接入 context-mode，不启动试点；保留现有 Codeg/runtime 工作方式。本轮只更新共享记忆、归档研究结果并做本地 Git 提交。下文试点建议仅作为未来重新评估时的参考，不是已批准的待执行任务。

## 证据范围

- context-mode：1.0.169，固定提交 `a92cf6a77ac02971fb5fafe2155e5ee229491884`。阅读 README、BENCHMARK、server/executor/store、平台适配、路由 hooks、事件采集/快照、统计、平台事件转发及相关测试。
- Codeg：实际运行进程 `/proc/2089052/exe --version` 和已安装程序均为 0.38.0；核对上游 v0.38.0，提交 `3f83b02da6006d198052fdef646e0d4bb8dc9e2c` 的连接、MCP 配置和委派实现。**上游 tag 默认 pin 不等于本机实际 adapter 版本**。
- 实机 Codex 链：codex-acp 2.0.1 → 自带 Codex 0.159.3 → `codex app-server`，另有运行中的 `codex-code-mode-host`。本轮对本机配置只提取服务名/功能开关，不读取输出凭据。
- 隔离模块实验、直接 stdio MCP 调用及 168 项相关上游测试；没有给生产 runtime 注册 context-mode，没有修改 hooks/AGENTS/服务配置，也没有重启 Codeg。没有付费模型任务 A/B，没有验收 Codeg 内真实 compaction 恢复。
- 机器可读结果：同目录 `context-mode-codeg-evidence-2026-10-21.json`。

## 当前工作模式决定了收益边界

只读查询 Codeg SQLite 的 conversation 表，固定创建时间区间为 2026-10-01 至 2026-10-21 20:46:02 CST；含已存储子会话，不按消息、token、活跃时长或任务成功率加权：

| runtime | 总会话 | 无 parent_id | 有 parent_id |
|---|---:|---:|---:|
| Codex | 46 | 30 | 16 |
| Grok | 70 | 7 | 63 |
| Hermes | 20 | 3 | 17 |
| Cursor | 10 | 6 | 4 |
| Claude | 3 | 1 | 2 |
| 合计 | 149 | 47 | 102 |

这证明实际使用涉及多 runtime 和大量子会话，不能只用 Claude 独立 CLI 的演示外推。Grok/Hermes 占 90 个会话、80 个子会话；这是兼容性优先级证据，不是成本份额证据。旧记忆的 Codeg 0.30.10 已被实机 0.38.0 覆盖。

Codeg `connection.rs:6384/6476` 和 `commands/mcp.rs:3343/5094` 显示：MCP 按 agent 类型管理。Hermes/Grok 从自身原生配置加载，Codeg 为避免重复注册而跳过该部分 ACP 转发；Codex 等则读取对应配置转成 ACP `mcpServers`。委派子任务建立自己的 ACP 连接，见 `delegation/spawner.rs:96`。

因此，context-mode 的合适位置是每个 runtime 使用的 MCP/可选 hook 层。Codeg 的任务调度、进程管理、权限、模型和远程连接不是它直接改进的对象。父会话加载某项能力，也不能证明异构子会话具备同样能力。

## 三种功能需要分别判断

1. **执行和筛选**：`ctx_execute`、`ctx_execute_file` 在子进程中执行智能体编写的程序，返回 stdout；`ctx_batch_execute` 批量执行、索引和查询。大幅缩小输出的关键往往是程序只打印答案，不是模型压缩算法。`executor.ts:283/409` 是子进程机制。
2. **可检索资料库**：`ctx_index`/`ctx_fetch_and_index` 将内容分块入 SQLite，`ctx_search` 进行 FTS5/BM25 搜索；当前还包括 porter/trigram 双索引、RRF 融合、模糊纠错和位置重排。能返回原始证据片段，并保留以后继续查的路径。见 `store.ts:475/1340`。
3. **压缩前后的工作状态恢复**：PostToolUse/UserPromptSubmit 等采集事件，PreCompact 建快照，SessionStart 恢复指引/快照；不是安装一个 MCP 就天然获得。见 `hooks/codex/precompact.mjs`、`hooks/codex/sessionstart.mjs:58`。

对普通 `ctx_execute`，传入 intent 且输出超过 5,000 字节会走索引检索；没有 intent 的大输出超过 102,400 字节才自动外置。5KB–100KB 的普通 stdout 仍可能直接返回。见 `server.ts:1912/1979`。所以“用了工具名就一定只回短摘要”不成立。

它也不是所有 MCP 工具的透明输出代理：`hooks/core/routing.mjs:999` 对外部 MCP 明确只提供周期性提示，不拒绝、不修改调用。不能承诺安装后 REA、飞书、NAS MCP 和 codeg-mcp 的任意结果都会自动压缩。

## 独立验证结果

**同一方法的公平对照**：使用上游 500 行 access.log，写同一个状态码统计程序，分别经原生 Node 子进程与 context-mode PolyglotExecutor.executeFile 执行。

| 指标 | 原生 Node | context-mode 执行器 |
|---|---:|---:|
| 输入文件 | 46,216 B | 46,216 B |
| 筛选结果 stdout | 98 B | 98 B |
| 统计结果 | 500 行、8 种状态码 | 完全相同 |

这证明日志任务可以少回传约 99.79% 字节，也证明这部分能力普通脚本已经具备。98 B 是执行器 stdout，不包含 MCP 包装、工具参数或模型生成脚本的成本。直接 MCP 的另一个“只数行数”实验返回 182 B 文本，其中包含路径和代码回显，不能把内部 stdout 当成完整上下文成本。

**官方示例复跑**：`tests/context-comparison.ts` 的 11 个静态样本合计显示 195.0 KiB → 4,898 B。其源码直接比较原文件与预写筛选脚本 stdout，使用约字节/4估算 token，没有模型自主选工具、编写程序、错误修复、答案完整性或实际账单比较。README 的 315KB → 5.4KB 也属于此类口径；BENCHMARK 把结构化筛选写为约 98%，把检索部分写为约 82%，合计约 96%。这些数字不是矛盾的同一个实验，而是不同样本/功能的统计。

**真实 stdio MCP**：列出 11 个工具；文件执行确实返回 500 行；索引后能查询回本轮唯一标记 `CM_REVIEW_7429`；不存在标记返回 No results。11 个工具的序列化定义合计 30,082 B，实际进入模型的多少取决于 runtime 的工具延迟加载，不能直接视为每轮固定开销。

**中文检索探针**：索引“只在取得明确授权之后才允许重启生产服务。”以及“家里的网络连接已经中断，需要排查线路。”。

| 查询 | 结果 |
|---|---|
| 明确授权 | 找到原句 |
| 网络连接 | 找到原句 |
| 重启 | 0 命中，原句确实含该词 |
| 断网 | 0 命中，存在对应语义但没有同词 |
| ECONNRESET | 找到另一段英文技术证据 |
| 不存在的英文标记 | 0 命中 |

这是小样本反例，不代表中文整体召回率；但足以否定“任意中文短词/改写均能可靠召回”。FTS5 的英文 stemming 和 trigram 检索不能等同于中文分词/语义向量检索。既有 mycc-memory 的跨引擎长期事实和明确交接仍有独立作用。

**上游相关测试**：store、search-flood-guard、session-snapshot 共 168/168 通过，Node 24.22.0。首次为避免安装脚本修改配置使用 ignore-scripts；Node 22.14 内置 SQLite 无所需 FTS5、better-sqlite3 原生绑定未构建，导致 98 项依赖初始化失败。改用机器已有 Node 24 的内置 SQLite 后通过；不把首次环境准备失败记作上游算法缺陷。

## 对各条实际链路的判断

| 场景 | 可期待的增量 | 限制/依据 |
|---|---|---|
| 长日志、CSV、大 JSON、构建输出 | 适合，收益机制有证据 | 原生脚本筛选已能实现主要压缩；增量是统一工具和按需回查 |
| 多文档、多页面研究，后续频繁追查 | 较有价值 | 索引保留资料、返回证据块；仍需检索覆盖和原文核验 |
| 当前 Codex 日常编程 | 增量相对有限 | 实机已有 code mode；精确 rg/sed、脚本统计已有同类能力 |
| Claude 长会话 | 自动化接入条件较完整 | 官方 hook 链完整，本机当前 ACP 会话尚未安装和验收 |
| Codex 压缩恢复 | 有实现、待验证 | 上游已提供 hooks；本机配置未显式打开 hooks，ACP/app-server/code-mode 真实路径未验证，不能照旧记忆说 Codex 永远不支持 hooks |
| Grok/Hermes | 基础 MCP 路线可试 | 当前 adapter registry/client map 没有专用适配；自动路由、事件采集/恢复无现成兼容证据 |
| Codeg 跨 runtime 委派/共享记忆 | 不足以承担 | 不是 Codeg broker、共享记忆或交接协议；存储/身份/恢复需分别接线 |
| 小补丁、短任务、精确单文件修改 | 可能无收益甚至增加开销 | 多一层工具选择、索引和检索；必须把结果完整性与总耗时算进去 |

## 必须计入的成本与具体接入问题

- **统计不是账单**：`server.ts:1033–1079` 以 indexed/sandboxed/cache bytes 估算保留在外的数据，按 bytes/4 换算 token，并乘价格得美元值；不是本机 CPA/实际 provider 的收费 usage，也没有完整扣除工具说明、参数、额外生成与重试等开销。应用实际成本数据作验收。
- **搜索节流**：默认每个识别出的 agent-context 在 60 秒窗口内，超过 3 次搜索收窄结果、超过 8 次阻止继续搜索；可配置。它确实有防洪目的，但源码逐轮研究需要批量查询或调整，并验是否漏证据。见 `server.ts:2444`、`search/flood-guard.ts`。
- **并发身份**：`server.ts:451–490` 在没有明确 session ID 时，会尝试读取项目数据库最新事件所属 session，并缓存两秒。该分支不能被视作可靠的 Codeg 父子身份映射。多会话共用一个 cwd 或仓库时，必须检验会话归属；本轮没有证实生产串台。
- **外部网站访问**：`server.ts:2881` 的 fetch 子进程主动删除 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 等变量。对依赖显式代理的抓取任务可能改变连通性；是否受本机透明代理覆盖需要实际验证，不能只看到安装成功就断定能抓国外资料。
- **行为规则**：上游路由会阻止/重定向 curl、构建、分析读文件等调用。直接用其安装示例覆盖 `~/.codex/AGENTS.md` 会覆盖本机宪法/记忆入口，不能照抄。若接入，只能保留原规则并增量配置，先测原生入口与委派入口。
- **权限边界**：源码和 README 自己说明执行器是子进程，不是完整 OS 安全沙箱；普通执行工具仍可访问宿主可访问的文件。它的 Bash/Read 策略检查也不等于自动继承所有现有自定义 hooks。接入不能宣称本机原护栏自然覆盖新工具。
- **本地与平台功能**：README 宣称“Nothing leaves your machine”，但 `hooks/platform-bridge.mjs:268` 在配置了 platform.json 后会发送事件；未配置时直接返回。还有启动 npm 版本查询。合理结论是核心存储/检索在本机，云 Insight 为条件性能力，不能笼统声称代码绝无联网路径。本轮未启用 Insight。
- **维护边界**：当前许可为 Elastic-2.0，个人本地使用与以其提供托管服务应区分。本次推荐不需要维护 Codeg fork，也不需要把它做成新的全局平台。

## 未来重新评估时的候选方案与验收方法

建议采用“Codeg 原生 MCP 管理 + 指定任务按需调用”的低侵入试点，先比较本来就需要大输出的日志分析和文档研究；不要一开始给所有 runtime 强制 hook。选择当前高频 runtime 测基础工具，再单独评估 Claude/Codex 的恢复链，避免因 Claude 集成最完善而只测一个实际低频入口。

试点至少覆盖：长日志排障、代码库证据检索、网页文档研究、普通小补丁，以及一次父子委派。基线必须是现有会用脚本/rg/code mode 的工作方式，不能故意让对照组全量 cat。比较：

1. 同样需求下答案是否完整、关键故障/边界是否遗漏，给合成和真实已知错误设置正反锚。
2. 父会话和全部子会话合计实际 input/output/cached token、provider usage/费用与完成时间。
3. 工具拒绝、重试、重复查找及人工纠正次数。
4. 单独触发真实压缩后，核验最近用户约束、当前文件、未完成任务和证据仍被正确使用；核验新建会话不会误恢复旁边会话。
5. 所选 runtime 的会话与委派子会话都实际调用到服务，且索引查询回来的载荷非空；不是仅在设置页出现服务名。

如果只见 stdout 变短，而任务质量、总 usage、完成时间没有改善，就没有证明对当前工作模式有净收益。现阶段判断置信度：机制与基础兼容边界高；实际任务成本/成功率提升尚无数据。

## 固定版本源码入口

- [context-mode 工具实现与统计](https://github.com/mksglu/context-mode/blob/a92cf6a77ac02971fb5fafe2155e5ee229491884/src/server.ts)
- [执行器](https://github.com/mksglu/context-mode/blob/a92cf6a77ac02971fb5fafe2155e5ee229491884/src/executor.ts)
- [检索实现](https://github.com/mksglu/context-mode/blob/a92cf6a77ac02971fb5fafe2155e5ee229491884/src/store.ts)
- [外部 MCP 路由分支](https://github.com/mksglu/context-mode/blob/a92cf6a77ac02971fb5fafe2155e5ee229491884/hooks/core/routing.mjs#L999)
- [平台识别清单](https://github.com/mksglu/context-mode/blob/a92cf6a77ac02971fb5fafe2155e5ee229491884/src/adapters/client-map.ts)
- [基准脚本](https://github.com/mksglu/context-mode/blob/a92cf6a77ac02971fb5fafe2155e5ee229491884/tests/context-comparison.ts)
- [Codex 恢复 hook](https://github.com/mksglu/context-mode/blob/a92cf6a77ac02971fb5fafe2155e5ee229491884/hooks/codex/sessionstart.mjs)
- [条件性事件转发](https://github.com/mksglu/context-mode/blob/a92cf6a77ac02971fb5fafe2155e5ee229491884/hooks/platform-bridge.mjs#L268)
- [Codeg MCP 连接逻辑](https://github.com/xintaofei/codeg/blob/3f83b02da6006d198052fdef646e0d4bb8dc9e2c/src-tauri/src/acp/connection.rs#L6476)
- [Codeg Hermes MCP 配置管理](https://github.com/xintaofei/codeg/blob/3f83b02da6006d198052fdef646e0d4bb8dc9e2c/src-tauri/src/commands/mcp.rs#L5094)

归档仅包含分析与脱敏结果，按用户要求纳入本地 Git 提交；本轮不推送远端。生产接入和效果验收仍未进行，当前决定为暂不实施。
