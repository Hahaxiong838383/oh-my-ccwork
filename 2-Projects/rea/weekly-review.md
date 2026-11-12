# REA 周审（Hermes 独立复核）

> 引擎：Hermes（deepseek-v4.1-flash / acp）｜首次执行：2026-10-21 09:05 CST｜最近更新：2026-10-21
> 本文只写 Hermes 周审结论，不改 `latest.json`、不覆盖历史报告。上游证据一律带 commit/文件/行号或官方版本 URL。
> 并行情况：本次核验期间 Codex 日报已先产出（`latest.json` + `reports/2026-10-21-daily.md`，01:03Z），初稿据此修正，交叉核对见第八节。

## 结论（2026-10-21）

**未变化但需注意：上游 main 已领先正式发布 245 个提交，package.version 却同为 6.7.0。** 本周不建议安装 REA；继续跟踪。若将来接入，必须锁 `rea-agents@6.7.0` 发布包 + 包内技能（version 42），**不得**把 main 的技能（version 44）配到 6.7.0 运行时上。

- 主分支 HEAD：`d0067ba34a39ea47dd7e11bb2e6169bc0938cc3f`（2026-10-21T00:17:12Z），与 baseline 的 `source_commit` 相同 → 本次核验窗口内 main 未再前进。
- 最新正式 release：`rea-agents-6.7.0` → tag commit `27dc42d10249`（发布 2026-10-18T07:45:18Z）。
- npm `latest`：`rea-agents@6.7.0`（2026-10-18T08:12:05Z 发布），dist-tags 只有 `latest`。
- main 相对 tag：`ahead_by=245`，300 个文件变更（GitHub compare API，tag `27dc42d` → HEAD `d0067ba`）。

## 一、main / npm / skill 三个版本源的关系（重新查证）

| 源 | package.version | 技能 metadata.version | SKILL.md 字节 | SKILL.md sha256 |
|---|---|---|---|---|
| GitHub main `d0067ba` | 6.7.0 | **44** | 26,147 | `36ed6adf…96c6d1fe` |
| release tag `27dc42d` 的 `.agents/` 源 | 6.7.0 | **42** | 23,510 | `976e400f…2b45e6` |
| npm tarball 6.7.0 `skills/` 制品 | 6.7.0 | **42** | 23,523 | `fbcd39d6…629eb1` |

两条独立的"同号不同物"证据：

1. **main 42→44 是内容升级，不是排版差异。** main 技能新增 `open_bundle_resources`（Apple plist/IB/资源目录）、`inspect_model_artifact`（GGUF/safetensors）、`inspect_il2cpp_metadata`（Unity IL2CPP）等入口（`head-SKILL.md` 对应段落；compare 中 `.agents/skills/.../SKILL.md` `+33/-1`）。而 npm 6.7.0 的 `dist/` 对 `il2cpp`、`gguf`、`safetensors` 命中数为 **0**，包内技能对上述词命中也为 **0** → 这些是 main-only 能力，**发布物里不存在**。
2. **npm 42 与 tag 42 字节不同，但差异可解释、不是内容分叉。** 逐行 diff 只有两类改动：注入 `tool_count: 207`，以及把 `rea-agents@latest` 全部替换为 `rea-agents@6.7.0`（`scripts/generate-skill-metadata.mjs` 的发布期生成行为；包内 `SKILL.md:37,51,56,71,79` 已是固定版本）。**据此修正 baseline 的粗粒度表述**：真正的内容断层在 npm 42 ↔ main 44，而不在 npm 42 ↔ tag 42。

即：`package.version` 相同**不能**推出源码与发布物同字节；本次三源两两不同，已用 sha256 与能力命中直接证伪。另据 release notes（`releases/latest` body）：**6.6.0 只打了 tag、未发布到 npm**（"That version was tagged but was not published to npm"），所以 npm 版本序列是 6.5.0 → 6.7.0。→ 版本号连续/跳号都不能当发布完整性，判断依据只能是 registry 元数据 + integrity。

## 二、发布身份（今日重新验证，非复用旧证据）

- tarball：`https://registry.npmjs.org/rea-agents/-/rea-agents-6.7.0.tgz`，下载 6,276,963 字节。
- 重算 `sha512`（base64）= `sha512-yhIx2ioJYYT1C/tONfYeitC6LhnKmCh+ZwRUOgYuhSc733lGhkkt73zhug9WmLgxoMdKuqIYGCoBfD4fXkOhFw==`，与 registry `dist.integrity` **逐字符相同**；重算 `sha1` = `11f23ba377303a5c28b3162180cf2bf3f3643708`，与 `dist.shasum` 相同。
- registry 元数据：`unpackedSize 28,575,703`、`fileCount 1775`，与 baseline 一致。
- 仅在 `/tmp` 解包读取 MD/JSON 与 `dist/` 字符串，**未执行** `install.sh`、`postinstall`、`prepare` 或任何包内脚本。

## 三、Node 门槛与本机运行时

- 门槛未变：`package.json:45-46` `^22.19.0 || ^24.11.0 || >=26.0.0`；`install.sh:113-125` 自带同样的平台/Node 校验；`README.md:174` 同表述。
- SQLite 单独更高：`docs/sqlite-databases.md:8-10` 要求 Node 24.x ≥24.15 或 26+（依赖原生 `DatabaseSync.limits`），其余能力仍走上面的范围。
- 本机实测（只读）：
  | 路径 | 版本 | 是否满足 |
  |---|---|---|
  | `/usr/local/bin/node`（PATH 首位） | v22.14.0 | 否（<22.19.0） |
  | `~/local/node/bin/node`（npm prefix） | v22.14.0 | 否 |
  | `~/.hermes/tools/node-26.7.0-linux-x64/bin/node` | **v26.7.0**（同目录有 node/npm/npx） | 是（含 SQLite 门槛） |

  更正 baseline 的"本机仅 22.14.0"：本机已存在一个满足 `>=26.0.0` 的 Node。但它在 `~/.hermes/tools/` 下、归 Hermes 工具链管理（升级/清理可能替换），**不建议**把它写成 REA 的固定启动路径；接入时更稳的是独立安装 Node 24.x ≥24.15（或 26+）并显式指定，避免动全局 Node v22.14.0。

## 四、Linux 与 Hermes 适配（本周重点复验）

- **Linux 安装路径明确**：`install.sh:142-144` 在 Linux 上 `npm install --global --prefix "$HOME/.local"`，命令落在 `~/.local/bin/rea`；`install.sh:113` 只接受 Darwin/Linux（"selected 64-bit Linux distributions"）。本机 Ubuntu 24.04.4 x86_64 在其支持面内。`~/.local/bin` 在 PATH、而 npm prefix 是 `~/local/node` 且其 bin 不在 PATH —— 这个错位是"装成功但找不到 `rea`"的根因，必须显式前缀。
- **Linux 额外前置**：`README.md:71-74` + `docs/installation.md:357-359` 要求 procps 兼容的 `ps`（供 owned-process 监督）；本机 procps-ng 4.0.4，满足。
- **Hermes 是一等客户端（不靠推断）**：
  - `src/application/SupportedClients.ts:644-651` 定义 `hermes`：技能目录 `<hermes home>/skills`、配置 `<hermes home>/config.yaml`。
  - `src/application/HermesClientHome.ts:141-179` 解析 Hermes home：`HERMES_HOME` 覆盖、`~/.hermes` 默认、读 `active_profile` 跟随粘性 profile（`:149` 显式 `profiles/<name>` 直接采用；`:109-117` 定义 profile 身份标记与保留名），解析不出来时抛 `HermesClientPathError` 而不是落到相对路径。
  - `src/application/HermesConfigurationYaml.ts` 专门做 YAML 往返编辑（保留 tag/时间戳语义），配套 `tests/acceptance/setup/hermesClientSetup.test.ts`、`tests/boundary/filesystem/hermesClientConfiguration.test.ts`。
  - MCP 写入的键是 `mcp_servers`（`dist/application/ClientConfigurationDocument.js:83` 注释与 `:28` 返回值）；该支持**已包含在 npm 6.7.0 发布物**里（`dist/application/HermesClientHome.js`、`HermesConfigurationYaml.js` 均在包内），不是 main-only。
  - **文档缺口**：三份 SKILL.md（npm 42 / tag 42 / main 44）里 `hermes` 命中数均为 0，技能列出的客户端清单没有 Hermes。实操上应直接用 `--client hermes` 并以 `setup --dry-run --json` 的实际路径为准，不要被技能里的清单误导。
- **Hopper 存在 Linux 实现（再次确认）**：`src/application/LinuxHopper.ts:391,435-452` 明确 Linux 启动器 `/opt/hopper/bin/Hopper` 与候选路径；`:690` 起按 apt/dnf/pacman 家族给安装命令；`docs/installation.md:539-544` 写自动化安装支持 **Ubuntu 24.04+**（本机正好 24.04.4）以及 Fedora/Nobara/Arch 等，并说明"REA 本身可在任何有 apt/dnf/pacman 的 Linux 上跑，已有启动器用 `HOPPER_LAUNCHER_PATH` 选中"；`:670` 再次给出 Linux 首选路径。仓库另有 CI `real-hopper-linux.yml`。→ 不能把 Hopper 当作 macOS-only。
- **MCP 传输变更（main-only，默认行为不变）**：`60bd646478 feat(mcp): add opt-in streamable HTTP transport (#4955)` 新增 `src/server/http/serveStreamableHttp.ts` 等，属 opt-in；6.7.0 仍是 stdio。只影响将来"是否用 HTTP 传输接 Hermes/Codeg"的选择，不影响当前评估。

## 五、本机接入状态（只读核验，2026-10-21）

| 项 | 结果 |
|---|---|
| PATH 中的 `rea` | 无 |
| `~/.local/lib/node_modules/rea-agents` | 不存在 |
| `~/.local/bin/rea` | 不存在 |
| `~/local/node/lib/node_modules/rea-agents` | 不存在 |
| `npm ls -g`（prefix `~/local/node/lib`） | 9 个包，无 `rea-agents` |
| `~/.agents|.claude|.hermes|.codex /skills/reverse-engineer-anything` | 四个目录全部不存在 |
| `~/.hermes/config.yaml`、`~/.claude.json`、`~/.codex/config.toml`、`~/.grok/config.toml` 中 rea 相关注册 | 命中 0 |

→ `installed.version` 仍为 null，状态仍是"已检查位置未安装"（不是全盘穷尽扫描）。

## 六、必须保留的边界（防止把推断写成事实）

- `src/application/Uninstall.ts:342` 的 `purgeData(join(home, ".rea"))` 只说明**卸载会尝试清理**该目录，**不能**倒推安装必然创建 `~/.rea`。因此本机 HOME 白名单现在**不要**为 REA 预加条目，等真实安装后按实际产物再定。
- 同 `package.version` / 同 `metadata.version` 都**不**证明同字节（本文第一节已给出两组反例与一组可解释差异）。
- 本轮**未**安装、未运行 REA、未验证任何 provider 就绪、未验证分析输出。所有"支持 Linux/Hermes/Hopper"的结论都是**源码与文档证据**，不等于本机能力验收。

## 七、观察缺口

- **日报仅 1 份且与本次周审并行**：Codex 的 `latest.json`（`checked_at 2026-10-21T01:03:00Z`，status=success）与 `reports/2026-10-21-daily.md` 在本轮核验过程中（09:03 CST）落地。本文件初稿写作时两者尚不存在，已据此修正——**"从未有过日报"不成立**，但"无 36 小时以上成功历史"成立，故仍无法评估日报节奏稳定性。
- 周审任务（`automation.json` id=6）cron 为周一 09:45，本次（周三）属初次运行，周节奏同样未经验证；下次自然触发预计 2026-10-26T01:45Z。
- `latest.json` 未记录 `ahead_by`（main 相对最新 tag 的领先提交数），也未记录 main 技能版本与 npm 技能版本之差的可解释性判断；这两项恰是本次发现错配风险的直接指标。

## 八、与 Codex 日报的交叉核对（并行产物）

| 事实 | Hermes（本轮独立取得） | Codex 日报 `latest.json` / `2026-10-21-daily.md` | 判定 |
|---|---|---|---|
| HEAD | `d0067ba…c8cc3f`，2026-10-21T00:17:12Z | 同 | 一致 |
| release | `rea-agents-6.7.0`，tag `27dc42d`，2026-10-18T07:45:18Z | 同（`27dc42d10249f0…b931c`） | 一致 |
| npm | 6.7.0，integrity `sha512-yhIx2ioJ…Fw==`，6,276,963 B | 同 | 一致 |
| tarball SHA-256 | `20958a66…f51f90`（本地重算） | `20958a66…f51f90` | 一致（互不依赖地算出同一值） |
| 技能版本 | main 44 / npm 42 | 同 | 一致 |
| 技能字节差异解释 | npm 42↔tag 42 仅生成期注入（`tool_count`、固定 runner）；内容断层在 main 44 | "生成器还会注入工具数、固定 runner 版本，不能将全部哈希差异当成功能变化" | 一致（结论同向，Hermes 补充了 tag 42 这一中间参照） |
| Node 门槛 | `^22.19.0 || ^24.11.0 || >=26.0.0`；SQLite 24.x≥24.15 或 26+ | 同 | 一致 |
| 本机安装 | 未安装（PATH / 两个 npm 前缀 / 四个技能目录 / 四个配置均无命中） | 未安装（PATH / 两个包路径 / 三个技能文件） | 一致，检查面略有差别 |
| main 独有依赖 | 用 `package.json` 直接比对：main 仅多 `@bufbuild/protobuf@2.16.0` | 同 | 一致（Hermes 独立复核通过） |
| 行号引用 | `install.sh:142-144`（Linux 分支本体）、`docs/sqlite-databases.md:8-10` | `install.sh:141-149`、`docs/sqlite-databases.md:8-11` | 不冲突：Codex 取块级区间，Hermes 取语句级区间 |
| 本机 Node 版本 | PATH 22.14.0；另存在 `~/.hermes/tools/node-26.7.0-linux-x64/bin/node` v26.7.0 | 22.14.0（scope 限 PATH/两个前缀） | **需补记**：日报的"不合规"结论基于 PATH 默认，未涵盖该 26.7.0；两者不矛盾，但口径应写清 |

另一条独立佐证：release notes 明确 6.7.0 含 6.6.0 的迁移事项、且 6.6.0 未发布 npm，与日报"6.7.0 release 内含 6.6.0 migration notes"的表述吻合。

## 九、建议

1. **维持暂缓安装**。上游以每天约百次提交的速度演进，且 main 与发布物已出现能力级偏差；此时接入会立刻面对"技能说要 il2cpp/GGUF，运行时没有"的错配。
2. 若川哥决定接入，按此固定组合执行（并先备份）：
   - 包：`rea-agents@6.7.0`，锁定 `sha512-yhIx2ioJ…Fw==`；
   - 技能：**包内** 42（不要 main 的 44）；
   - Node：独立 24.x ≥24.15 或 26+（要用 SQLite 就必须 ≥24.15），显式给 `rea` 启动路径，不动全局 v22.14.0；
   - 客户端：`setup --client hermes --dry-run --json` 先看真实路径与备份，再 `--yes`；验收必须在真实会话里看到工具并跑通一个已知 JS/Electron fixture，`doctor` 通过不算接通。
   - 步骤边界（`tracking-policy.md:28`）：包升级、MCP 固定版本注册、技能刷新是三件独立步骤，`rea update` 成功不能证明后两者已更新；验收对象是本轮已评估的 6.7.0 候选，不是滚动变化的 npm latest。
3. 跟踪侧建议 Codex 日报补两个字段：`ahead_by`（main 相对最新 tag，本周 245）与"main 技能版本 / npm 技能版本"（本周 44/42）。日报已有 7 文件技能哈希，但缺这两个领先性指标；另建议 `installed` 段写明 Node 检查口径（PATH 默认 vs 其他已存在运行时），避免把"PATH 是 22.14.0"读成"本机没有合规 Node"。

## 历次周审

- 2026-10-21：首次独立周审（以 baseline 为起点；核验期间 Codex 日报并行落地，已交叉核对）。`reports/2026-10-21-weekly-hermes.md`
