# 搜索半句回归验证（2026-11-13）

结论：本轮新增正反例全部通过，当前语音 Worker 已保护“帮我查查深”等已知片段，无需修改业务逻辑。本 PR 只补回归测试及本说明，未部署、未重启、未改凭证或主分支。

## 基线与行为

- 从 Studio 现有语音分支 `codex/p003-v391-asr-diagnostics-20261111` 的 `a64855b98a516a9b2ed25cb67ec30eae060d3e60` 创建独立工作树。原工作树干净，远端同名分支指向相同提交；未从旧 `main` 开发。
- 实际执行边界是 `SearchSession::interpret → command → poll`。路由内部返回 `Search` 并不表示已发起后台搜索：不完整查询先进入有界 `PendingTopic`，超时后生成追问，不向任务队列发送 `Submit`。
- 相邻 ASR 尾句有 1.2 秒拼接窗口，检测到输入活动时上限为 5 秒；只使用用户实际说出的尾句，不猜城市。追问播放仍遵守已有安全/静默门。
- pipeline 接到搜索 action 后中止该轮普通回复路径；未把片段交给普通模型自行补成城市。

## 新增测试

`rust-worker/src/search_tasks.rs` 增加 3 个测试、43 个输入/配置场景：

| 测试 | 场景与断言 |
|---|---|
| `search_fragments_ask_without_submitting_or_guessing` | 12 类城市前缀/谓语半句，分别在无路由快照和默认配置下验证；超时前后均无搜索提交，能够输出追问，不虚构“深圳” |
| `complete_searches_including_short_topics_submit_without_fragment_wait` | 8 类完整表达 × 2 种配置，包括“水”“深圳”“深是什么意思”“恐龙为什么会灭绝”；不进入片段等待，原样且仅提交一次 |
| `fragment_cannot_guess_from_unrelated_chat_or_survive_cancel` | 普通聊天、取消、新查询三个后续输入；不拼接或猜测旧片段，新查询“水”恰好提交一次 |

测试复用实际 Session、真实任务通道和现有本地夹具；仅移动夹具的时间锚点，不等待真实六秒，不请求生产服务。按“测试不过再改”的要求，本轮未改生产代码。独立静态评审未发现阻断问题。

## 本轮执行结果

| 检查 | 结果 |
|---|---|
| 路由预览 `cargo test --offline --locked --manifest-path tools/search-route-preview/Cargo.toml` | 61 通过；与 Worker 内同源测试有重叠，不累加为独立覆盖数 |
| Worker `cargo test --locked` | 主测试目标 699 通过、3 失败、3 忽略；新增 3 项均通过 |
| Worker `cargo test --offline --locked --no-fail-fast -- --test-threads=1` | 主目标同上；另外 30 + 13 + 10 项集成测试全过。合计 **752 通过、3 失败、3 忽略** |
| 上述 Worker 中搜索相关模块 | **146 通过、0 失败**，包含新增 3 项/43 个场景 |
| `git diff --check` | 通过 |

使用本机既有现代 Rust 工具链，新增依赖缓存与构建产物仅位于本工作树的 `rust-worker/target`。系统默认 Cargo 1.70 不支持仓库的 edition 2024，因此没有使用它编译，也没有降低仓库依赖版本。

全量未通过的三项均在未修改的 `voice_connect.rs`，并行与串行均复现：

1. `cname_target_in_additional_is_not_discarded_as_no_addresses`：本机不能绑定测试用的第二个回环地址，返回 `AddrNotAvailable`。
2. `diagnostic_records_refused_address_then_success_with_same_connection`：该地址没有产生测试预期的 `ConnectionRefused` 诊断。
3. `diagnostic_cancelled_tcp_loser_keeps_connection_and_subscriber`：该地址连接仍在等待，取消记录为 2 条，测试预期 1 条。

此文件的工作区 Git blob 与基线均为 `2402bff7216033719975e78b0b03d111b24cb569`。未改网络设置或修订这些无关用例，不把全量测试描述成全绿。编译另有既有未使用代码告警。

## 验证边界

本次证明已知八个城市前缀及有限谓语后缀的行为，不代表能理解任意中文半句。未验真实 ASR、TTS、终端听感或线上版本是否包含这段代码；没有上线动作。评审应针对上述功能分支基线，仅审阅本次测试和说明。

署名：codex（OpenAI）| 2026-11-13
