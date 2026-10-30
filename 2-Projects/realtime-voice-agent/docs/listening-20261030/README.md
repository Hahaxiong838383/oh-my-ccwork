# P003 倾听 Worker 开发入口

2026-10-30 当前批次已从基础纯模块推进到真实 job/control/pipeline/playout 接线、异步主 Brain HTTP 客户端及隔离联合模拟。当前分支 `codex/p003-listening-worker-20261030`，仍以普通 R18＋style-ark 为基线。

本分支没有部署、没有开线上总闸，没有修改 Android 包、搜索名单/窗口或已发布的后台。开发交付、测试证据、候选差分和回滚点见 [NEXT_BATCH_RECEIPT.md](NEXT_BATCH_RECEIPT.md)。

主要实现：

- `listening_mode.rs`：持久模式、双确认、单次反馈、讲话撤权、租约和会话上限。
- `listening_runtime.rs`：真实 participant/签名 job 绑定、逐帧 purpose/epoch/turn 许可、在途 capture 计数。
- `listening_adapter.rs`：异步授权、状态查询顺序、摘要 CAS、反馈调度及失败退避。
- `listening_http.rs`：主权威地址/服务头部、冻结快照与 SHA、响应绑定、单调租约余量。
- `listening_ready.rs`：真实 LiveKit 注册生命周期、编译时 build SHA、配置应用确认；缺少发布证据不宣称 ready。
- `pipeline.rs` / `playout.rs`：真实输入隔离、取消和排空、NativeAudioSource 全部 PCM 出口。

测试（已有依赖，不安装、不部署）：

```sh
cd 2-Projects/realtime-voice-agent/rust-worker
bash scripts/test-listening-core.sh
cargo test --offline --locked
```

本机 rustc 1.70 只能运行 std 核心测试。完整项目要求 edition 2024 的 Linux 工具链，不能用核心测试代替完整 Cargo。

真实 Brain HTTP 联合模拟使用只读选定 Brain 树中的 authority/router、临时 SQLite 注册表及模拟内容模型。构建 fixture 后在 Linux 运行：

```sh
node scripts/listening/build-joint.mjs /path/to/brain-worktree /tmp/p003-listening-joint.mjs
P003_LISTENING_JOINT_BUNDLE=/tmp/p003-listening-joint.mjs sh scripts/listening/run-joint.sh
```

它只监听回环地址，生成的身份/服务密钥均为合成测试值；测试配置留在临时目录。标准 Cargo 将这一个外部测试标记 ignored，联合命令会显式执行它，回执分别计数。

正式能力声明还要求编译时 `P003_WORKER_BUILD_SHA`、主 Brain 的可信发布 manifest、真实注册、当前全局快照应用确认。不能以运行时布尔值代替这些证据。本轮未创建生产发布 manifest，也没有进行发布构建/上线。

原首批基础提交 `53727c3fb367f5a4f692a81511d5ac8303eb728a`；原冻结标签 `rollback/p003-listening-worker-20261030` 指向 `ef92ee1aa30e6ef869f6270de22173ce51617f30`。本批回滚点为开发开始时的 `4c900d9a239b4cfa580f592502594f21bcba90c3`。

署名：codex（OpenAI）| 2026-10-30
