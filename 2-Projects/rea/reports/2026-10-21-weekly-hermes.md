# 2026-10-21 REA 周审报告（Hermes）

- 引擎：Hermes（deepseek-v4.1-flash，acp）
- 类型：首次独立周审（以 `baseline.json` 为起点；核验期间 Codex 日报并行落地，已交叉核对）
- 核验时间：2026-10-21 08:59–09:05 CST（00:59–01:06 UTC）
- 范围：公开上游（GitHub API / raw / npm registry）+ 本机软件元信息，只读
- 未做：未安装、未升级、未执行上游脚本、未改任何客户端配置、未写共享记忆、未对外发消息

## 结论

上游 main 已领先正式发布 **245 个提交**，但三处版本号仍是 6.7.0 / 技能 42 / 44 混排。本周不建议安装；跟踪继续。接入时只能"固定 6.7.0 包 + 包内技能 42 + 独立 Node"这一组合，且包升级、MCP 注册、技能刷新按三件独立步骤分别验收（`tracking-policy.md:28`）。

## 关键事实与证据

| # | 事实 | 证据 |
|---|---|---|
| 1 | main HEAD = `d0067ba34a39ea47dd7e11bb2e6169bc0938cc3f`，2026-10-21T00:17:12Z；与 baseline 相同 | `GET /repos/morluto/rea/commits/main`（本次 00:59Z 取得） |
| 2 | 最新正式 release = `rea-agents-6.7.0`，tag commit `27dc42d10249`，发布 2026-10-18T07:45:18Z | `GET /repos/morluto/rea/releases/latest`、`/tags` |
| 3 | npm `latest` = 6.7.0，发布 2026-10-18T08:12:05Z，dist-tags 仅 `latest` | `https://registry.npmjs.org/rea-agents` |
| 4 | main 相对 tag 领先 245 提交 / 300 文件 | `GET /compare/27dc42d10249...d0067ba34a3`（`ahead_by=245`） |
| 5 | 三源技能版本不同：main 44、tag 42、npm 42；字节与 sha256 均不同 | 见下表 |
| 6 | npm 包完整性今日重算匹配 | 重算 `sha512-yhIx2ioJ…Fw==` = `dist.integrity`；`sha1 11f23ba3…` = `dist.shasum` |
| 7 | npm 包内技能 42 缺 main 的 il2cpp/GGUF/safetensors 能力 | `dist/` 对这三词命中 0；包内 SKILL.md 命中 0；main SKILL.md 分别为 4/1/1 |
| 8 | Hermes 是一等客户端，且已随 6.7.0 发布 | `SupportedClients.ts:644-651`、`HermesClientHome.ts:141-179`、`HermesConfigurationYaml.ts`；包内 `dist/application/HermesClientHome.js` 存在 |
| 9 | Hermes 的 MCP 写在 `config.yaml` 的 `mcp_servers` | `dist/application/ClientConfigurationDocument.js:83`、`:28` |
| 10 | 技能文档三版本都不提 Hermes（客户端清单缺口） | npm 42/tag 42/main 44 中 `hermes` 命中均为 0 |
| 11 | Linux 安装走 `~/.local` 前缀 | `install.sh:142-144`；平台门 `install.sh:113` |
| 12 | SQLite 需 Node 24.x ≥24.15 或 26+ | `docs/sqlite-databases.md:8-10`；总门槛 `package.json:45-46` |
| 13 | Hopper 有 Linux 实现（非 macOS-only） | `LinuxHopper.ts:391,435-452,690`；`docs/installation.md:539-544`（自动化安装支持 Ubuntu 24.04+）、`:670`；CI `real-hopper-linux.yml` |
| 14 | 卸载清理 `~/.rea` 不能倒推安装会创建它 | `Uninstall.ts:342`（仅 `purgeData` 目标） |
| 15 | 本机存在 Node 26.7.0（Hermes 工具链内） | `~/.hermes/tools/node-26.7.0-linux-x64/bin/node -v` → v26.7.0 |
| 16 | 本机未安装 REA | PATH、两个 npm prefix、四个技能目录、四个 MCP 配置均无命中 |
| 17 | 6.6.0 打了 tag 但未发布 npm（故 npm 序列 6.5.0 → 6.7.0） | release notes body（`releases/latest`）："That version was tagged but was not published to npm" |

### 技能三源对照

| 源 | `metadata.version` | 字节 | sha256 | 备注 |
|---|---|---|---|---|
| main `d0067ba` `.agents/` | 44 | 26,147 | `36ed6adf…96c6d1fe` | 含 `open_bundle_resources`、`inspect_model_artifact`、`inspect_il2cpp_metadata` |
| tag `27dc42d` `.agents/` | 42 | 23,510 | `976e400f…2b45e6` | 运行时引用仍为 `@latest` |
| npm 6.7.0 `skills/` | 42 | 23,523 | `fbcd39d6…629eb1` | 追加 `tool_count: 207`，`@latest` 全替换为 `@6.7.0`（`:37,51,56,71,79`） |

结论：npm 42 ↔ tag 42 的差异是**发布期生成**（可解释）；npm 42 ↔ main 44 是**内容断层**（能力级）。因此"同包版本号"不能作为源码与发布物等价的依据。

## 本机环境（只读）

- Ubuntu 24.04.4 LTS，x86_64；procps-ng（`ps`）满足 Linux owned-process 前置（`README.md:71-74`）。
- Node：`/usr/local/bin/node` v22.14.0、`~/local/node/bin/node` v22.14.0（均低于 22.19.0）；`~/.hermes/tools/node-26.7.0-linux-x64/bin/node` v26.7.0（满足）。
- npm 10.9.2，prefix `~/local/node/lib`（其 `bin` 不在 PATH）；`~/.local/bin` 在 PATH。
- 未安装 `rea`；`npm ls -g` 9 个包无 `rea-agents`；四个技能目录均不存在；`~/.hermes/config.yaml`、`~/.claude.json`、`~/.codex/config.toml`、`~/.grok/config.toml` 中 rea 注册命中 0。

## 观察 / 推断 / 未验证

- **观察**：上表 1–16 全部为本轮实际请求或本机只读命令的直接结果。
- **推断**：main 的 il2cpp/GGUF/资源能力需要 main 构建产物；npm 6.7.0 未包含，两者不能混搭。此为基于字符串命中与文件清单的合理推断，**未**真机运行验证。
- **未验证**：REA 在本机的任何实际分析输出；Hermes 真实会话中 MCP 是否可调用；Hopper Linux demo 路径可用性；安装耗时与磁盘占用（registry 元数据 28.5 MB 解包只是包体，不含依赖/缓存）。
- **不成立的推论**：`~/.rea` 会由安装创建（仅见于卸载清理代码）；Hopper 仅 macOS；`doctor` 通过即已接通。

## 观察缺口

- Codex 日报 `latest.json`（`checked_at 2026-10-21T01:03:00Z`，status=success）与 `reports/2026-10-21-daily.md` 在本次核验过程中（09:03 CST）落地，与本轮并行；本报告初稿写作时两者尚不存在，已按并发产物修正。因此"从未有过日报"不成立，"无 36 小时以上成功历史"成立 → 日报节奏稳定性仍不可评估。
- 周审任务 id=6 cron 为周一 09:45，本次（周三）为初次运行；下次自然触发预计 2026-10-26T01:45Z。
- `latest.json` 缺 `ahead_by` 与技能版本差的可解释性判断，这两项是错配风险的直接指标。

## 与 Codex 日报的交叉核对

| 事实 | Hermes | Codex | 判定 |
|---|---|---|---|
| HEAD / release / npm 版本 / integrity | `d0067ba` / `27dc42d` / 6.7.0 / `sha512-yhIx2ioJ…` | 同 | 一致 |
| tarball SHA-256 | `20958a66…f51f90` | `20958a66…f51f90` | 一致（各自独立算出） |
| 技能版本 | main 44 / npm 42 | 同 | 一致 |
| 差异归因 | npm 42↔tag 42 仅生成期注入；内容断层在 main 44 | "不能将全部哈希差异当成功能变化" | 一致，Hermes 补 tag 42 中间参照 |
| main 独有依赖 | 仅 `@bufbuild/protobuf@2.16.0` | 同 | 一致 |
| 行号 | `install.sh:142-144`、`sqlite-databases.md:8-10` | `install.sh:141-149`、`:8-11` | 不冲突（语句级 vs 块级） |
| 本机 Node | PATH 22.14.0，另有 `~/.hermes/tools/.../node` v26.7.0 | 22.14.0（scope 限 PATH） | 不矛盾，口径需写清 |

补充独立佐证：release notes 说明 6.6.0 打了 tag 但**未发布 npm**（故 npm 序列 6.5.0 → 6.7.0），且 6.7.0 含 6.6.0 迁移事项。

## 来源（本次获取时间 2026-10-21T00:59–01:06Z）

1. https://api.github.com/repos/morluto/rea
2. https://api.github.com/repos/morluto/rea/commits/main
3. https://api.github.com/repos/morluto/rea/releases/latest
4. https://api.github.com/repos/morluto/rea/tags
5. https://api.github.com/repos/morluto/rea/compare/27dc42d10249...d0067ba34a39ea47dd7e11bb2e6169bc0938cc3f
6. https://registry.npmjs.org/rea-agents
7. https://registry.npmjs.org/rea-agents/-/rea-agents-6.7.0.tgz （仅 `/tmp` 解包读取，未执行）
8. https://raw.githubusercontent.com/morluto/rea/d0067ba34a39ea47dd7e11bb2e6169bc0938cc3f/{package.json,README.md,install.sh,docs/installation.md,docs/sqlite-databases.md,src/application/SupportedClients.ts,src/application/HermesClientHome.ts,src/application/HermesConfigurationYaml.ts,src/application/SetupSkill.ts,src/application/LinuxHopper.ts,src/application/Uninstall.ts,.agents/skills/reverse-engineer-anything/SKILL.md}
9. https://raw.githubusercontent.com/morluto/rea/27dc42d10249/.agents/skills/reverse-engineer-anything/SKILL.md

## 产物

- `weekly-review.md`（本次更新）
- `reports/2026-10-21-weekly-hermes.md`（本文件）
- 本轮**未修改** `latest.json`、`baseline.json`、`README.md`、`tracking-policy.md`、`automation.json`；其中 `latest.json` 与 `reports/2026-10-21-daily.md` 由 Codex 日报任务在 09:03 CST 并发创建，仅作只读交叉核对。
