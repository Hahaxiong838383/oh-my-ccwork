# REA 本机落位评估（2026-10-21）

结论：按“机器级 REA 运行时 + 各 agent 的用户级配套技能/MCP + mycc 接入记录 + MyAgent 具体任务”组织。不需要新建 HOME 顶层 rea 源码仓。日常使用不要求持有源码 checkout。

本轮只做调研。现有项目、客户端配置和运行时未修改；临时源码在 `/tmp/rea-codex-review-b9ce6f3a`。Hermes 经 Codeg delegate_to_agent 独立评估，任务 ID `a7932083-9a3a-4e9a-b131-89f66df042bf`，会话 236。下面是主代理复核后的结论，不是未经校验的子代理输出。

## 范围与版本

- GitHub HEAD：`d0067ba34a39ea47dd7e11bb2e6169bc0938cc3f`，提交时间 2026-10-21T08:17:12+08:00。
- 重点阅读了 CLI/MCP 分发、setup 工作流、客户端配置和技能路径、Hermes profile 解析、技能更新/软链处理、JS/Electron 分析至 Evidence 链路、缓存及相关测试源码。没有声称逐行审完仓库的 4,942 个跟踪文件，也没有运行全套测试。
- 实时 npm latest 为 `rea-agents@6.7.0`。下载官方 tarball，在内存读取内容并验证 registry 提供的完整性哈希，匹配成功；未执行包内安装脚本。
- 包解压大小元数据：28,575,703 字节、1,775 文件；下载压缩大小 6,276,963 字节。以上不包含安装后的依赖、额外引擎或缓存，不能作为总磁盘占用。
- 发布包技能 `metadata.version = 42`，配套工具数元数据 207；Git main 技能 `metadata.version = 44`。两边 package.version 都是 6.7.0，内容仍不相同。
- 发布包技能共有 7 个文件（SKILL.md + 6 个 references）；其中 runner 已固定为 `rea-agents@6.7.0`。因此优先让同一个固定发布包管理 MCP 与技能，避免 main 技能混用旧运行时。

## 目录判断

| 候选 | 判断 | 原因 |
|---|---|---|
| `~/rea` 或 `/rea` | 不推荐 | HOME 新顶层受约束；源码按安装包自身位置寻找构建物，没有必须占据根目录的要求。 |
| 当前 Codeg chat-sessions 目录 | 不作长期落点 | 这是当前会话的工作目录，不是 mycc 或 MyAgent 的项目仓。 |
| `~/mycc/2-Projects/rea/` | 适合接入管理文件 | HOME 默认将新项目归此，但其 README 明确不存独立代码仓；可放版本、配置指针、验收记录。 |
| `~/MyAgent/...` | 适合具体逆向任务 | 现有 cc/Hermes 技能共用接线适用于 MyAgent 项目；跨目录 Codeg 会话仍需实际确认发现范围。 |
| 机器级运行时 + 用户级技能 | 推荐的使用方式 | 无需维护上游开发树，可跨项目复用，与 REA 官方 setup 的配置路径一致。 |

建议运行时使用官方 Linux 布局 `~/.local/lib/node_modules/rea-agents` / `~/.local/bin/rea`。mycc 仅保留接入记录。默认 profile 下，技能由同版 setup 分别生成到 `~/.agents/skills/reverse-engineer-anything`、`~/.claude/skills/reverse-engineer-anything`、`~/.hermes/skills/reverse-engineer-anything`。实际配置与路径以 profile 解析和 dry-run 为准。部署副本统一由包生成，不各自手改；升级统一验证。

若只计划在 MyAgent 内使用，也可以维护项目级技能，利用现有 `.hermes/skills -> ../.claude/skills` 接线。但这会引入自行维护技能版本的责任，不是跨目录使用的首选。官方安装器检查的是所选具体技能目录及 references 是否软链，不能把此限制夸大为“不允许任何父目录软链”。

## 源码证据

以下均基于上述固定提交，可按 `https://github.com/morluto/rea/blob/d0067ba34a39ea47dd7e11bb2e6169bc0938cc3f/` 拼接：

1. `scripts/rea.mjs:28,50-68`：按 import.meta.url 确定 packageRoot，CLI/MCP 加载 dist；缺构建物提示 npm ci 和 build:cached。无需将源码放 HOME 根。
2. `.agents/skills/reverse-engineer-anything/SKILL.md:10-19`：定位为发布制品/二进制/运行时证据；普通完整源码仓架构分析应使用常规工具；技能不注册 MCP、不安装引擎。
3. 同文件 `:69-78`：明确允许 CLI fallback，无需 MCP 注册即可进行静态 JS 分析。所以“CLI、MCP、技能三者都必须安装”不成立。
4. `src/application/SupportedClients.ts:483-505,644-651,807-855`：Claude、Codex、Hermes 的配置和个人技能路径；Codex 未单列 skillPath，回落共享 `.agents/skills`。
5. `src/application/SetupSkill.ts:22-30,245-285`：7 个受管理文件；检查具体 skill/references 目录软链并拒绝接管。
6. `scripts/generate-skill-metadata.mjs:12-14,33-41`：从 .agents 源文件生成发布 skills，并把 @latest 替换为固定包版本。
7. `src/cli/javascriptApplicationAnalysis.ts:15-27` 与 `src/server/registerElectronTools.ts:100-116`：CLI 与 MCP 接同一 JS 分析服务。
8. `src/application/javascript/JavaScriptApplicationService.ts:64-108`：重建、校验结果、生成证据；`JavaScriptApplicationEvidence.ts:67-86` 保留输入标识、sha256、authority、confidence、limitations。
9. `install.sh:141-149`：Linux 明确选择 npm --prefix ~/.local。
10. `package.json:45-46`：Node 范围 `^22.19.0 || ^24.11.0 || >=26.0.0`；`docs/sqlite-databases.md:8` 对 SQLite 要求 Node 24.15+ 或 26+。

本地规则证据：`~/AGENTS.md:11,34-44`；`~/mycc/2-Projects/README.md:19,31-32`；`~/MyAgent/README.md:15-17`；`~/MyAgent/0-System/HERMES.md:28-38`。

## 本机实测与建议收益

- Linux x86_64；Node v22.14.0；npm 10.9.2；ps 为 procps-ng 4.0.4。
- `~/local/node/bin/node` 也是 v22.14.0。建议并存满足要求的 Node 24（若要 SQLite 则 >=24.15），为 REA 固定启动路径，避免影响现有共享 Node。
- npm prefix 是 `~/local/node`，该 prefix/bin 不在本次 PATH；`~/.local/bin` 在 PATH。显式前缀可避免安装成功却找不到 rea 命令。
- java/javac/jadx/Ghidra/Hopper/IDA/rea 命令未在本次 PATH 找到，常规检查位置也未发现 Java/Ghidra。此结论不等于已穷尽全盘；只能说尚未证明相应 provider 可用。
- adb、objdump 可找到；adb 存在不代表 APK 静态反编译依赖齐全。
- 先以公开或自有的 JS/Electron 样本验证静态能力，再按实际任务补 JADX/JDK 或原生引擎，能缩小第一阶段安装与维护范围。
- 核心收益：跨项目复用、免上游源码构建、工具/说明版本对齐、PKM 不承载依赖树、分析结论带可追溯证据。

## 对 Hermes 输出的复核修正

- 采纳其“机器级工具 + 技能；不建 ~/rea”的核心判断。
- Hopper 不是仅支持 macOS：`src/application/LinuxHopper.ts:434-453` 明确有 Linux 安装路径和发现逻辑。
- 同为 6.7.0 不证明 main 与 npm 内容相同：本轮 tarball 已给出技能 42/44 的直接反例。
- `Uninstall.ts:342` 清理 `~/.rea` 不能证明本次安装必然创建它；不能据此提前要求修改 HOME 白名单。
- CLI 可以由 agent 的 shell 工具调用；MCP 是工具接入方式之一，不是使用 REA 的绝对前提。
- 包含可选 Frida 和 PTY 相关依赖，不能保证“纯 JS、无原生构建、1–2 分钟安装完”。本轮未测安装耗时。

## 后续验收边界

本轮结论是源码、发布包和本机环境支持的架构建议，尚未验收 REA 实际分析能力。后续落地应核对实际启动 Node、客户端 dry-run 写入目标、固定包和技能版本，再在 Codeg 启动的真实会话内确认工具可见，并对已知样本取得非空分析载荷和匹配的文件身份。doctor 配置通过本身不等于活会话已经接通。
