# 语音体验 demo 独立线（voice-test-rust.html × rust-worker-demo）

建立：2026-09-21 09:59 CST（分支 `feat/voice-test-rust-demo`）。目的：川哥的网页体验 demo 与小可（P003）生产池彻底分离——改 demo 不碰小可，改小可不碰 demo。

## 现状（改造前）
- 页面 `https://voice-hk.hahaxiong.cc/voice-test-rust.html` 只存在于 47.239 的 `/var/www/voice/`，不在仓里；内嵌房间级 token 2026-09-11 已过期（页面已死）。
- token 派单到 agent `rust-worker` = 64.90 上的小可生产池 `voice-worker-rust.service`：小可人设（AGENT_INSTRUCTIONS）、走小可大脑（LLM_BASE_URL=kidshub-ai + LLM_URL_QUERY 设备 token）、设备指令/退出信号/二遍识别等设备功能全开、问候关闭。

## 改造后拓扑
```
浏览器 ──wss 443──► 47.239 nginx ──► livekit-server:7880 ──/agent──► 64.90 voice-worker-demo（agent_name=rust-worker-demo）
                                                        └──────────► 64.90 voice-worker-rust / -firstturn（小可，不变）
```
| 项 | demo 线 | 小可线 |
|---|---|---|
| 页面 | 仓内 `web/voice-test-rust.html`（token 占位 `__LIVEKIT_TOKEN__`，部署时现签注入） | 设备端 |
| 派单 | token roomConfig agentName=`rust-worker-demo`，房 `voice-test-rust` | `rust-worker` / `rust-worker-firstturn`，房 `sn-…` |
| 进程 | 64.90 `voice-worker-demo.service`（`/root/rust-worker-demo/`，独立 EOT sidecar socket） | `voice-worker-rust.service` / `voice-worker-firstturn.service` |
| 二进制 | 首装 = 复制现役生产二进制（sha256 b0ec810b…）；以后可从本分支单独构建换装 | 各自现役 |
| 大脑 | 直连 DeepSeek（`.env` 的 LLM_API_KEY），`LLM_URL_QUERY` 置空 | 小可大脑 kidshub-ai（设备 token） |
| 人设 | unit `UnsetEnvironment=AGENT_INSTRUCTIONS` → 代码内置通用语音助手；可在 demo env 自定义 | 小可 |
| 问候 | 开（文案取 `.env` AGENT_GREETING） | 关 |
| 设备功能 | 指令/意图执行/canary.say/退出信号/二遍识别全关 | 开 |
| 共享不变 | `.env` / `poc-eou.env` / `rust-worker.env`（只读继承）、TTS xfyun 同音色、承接音库、热词 | — |

## 文件
- `web/voice-test-rust.html` 页面模板（无 token）。
- `scripts/demo/sign_demo_token.py` 在 47.239 用 `/root/voice-venv` 现签 token（默认 180 天，房 voice-test-rust，agent rust-worker-demo）。
- `scripts/demo/deploy_demo_page.sh` 本机一键：模板 → 服务器签 token 注入 → 备份旧页 → 上线；token 不经本机、不打印，只回显 room/agent/exp。
- `rust-worker/ops/demo/rust-worker-demo.env.example` demo 池 env（无密钥，可直接当正式 env）。
- `rust-worker/ops/demo/voice-worker-demo.service` unit。
- `rust-worker/ops/demo/install_demo_pool.sh` 64.90 上装/换装（scp env+unit 到 /tmp 后跑；换二进制放 `.new`）。

## 运维
- 换 token / 改页面：改模板 → `scripts/demo/deploy_demo_page.sh`。
- 改人设 / 模型 / 开关：改 64.90 `/root/rust-worker-demo/rust-worker-demo.env` → `systemctl restart voice-worker-demo`（同步改仓内 .example）。
- 验收：47.239 `PROBE_AGENT=rust-worker-demo … scripts/rtc_probe.py`（⚠️ 47.239 上现役 rtc_probe.py 是旧版不认 PROBE_AGENT，用仓内版本）；期望问候字幕 + eou/llm/tts 指标 + 双侧字幕。
- 判「派对了池」：`journalctl -u voice-worker-demo` 有该房 job，`voice-worker-rust` 零该房行。
- 回滚：`systemctl disable --now voice-worker-demo`；页面回旧版 = `/root/voice-test-rust.html.bak-<ts>`（旧 token 已过期，回滚等于下线）。

## 首次验收（2026-09-21 09:59 CST）
- demo 池注册 worker_id AW_dpq99A6dwfX2（LiveKit 1.13.2），RSS 49 MB，64.90 可用内存 1954 MB；小可两池 PID 不变。
- 探针：问候「你好，我在，可以直接打断我。」→ 用户句 final「今天北京的天气怎么样」→ eou 440 ms / stt 371 ms → 首声 +806 ms → llm ttft 654 ms（DeepSeek）/ tts ttfb 291 ms → 回答字幕（通用助手口吻）。

## 待川哥定
- demo 音色：现沿用小可的 xfyun 音色 + 同一套承接音（换音色要重跑承接音合成）；如要 volc 男声（.env 里的 zh_male_lengkugege）需同步换承接音库。
- demo 人设：现为代码内置通用人设；要专属人设写进 demo env 的 AGENT_INSTRUCTIONS。
- 后续 demo 侧 worker 改动在本分支单独构建、只换 `/root/rust-worker-demo/` 的二进制。
