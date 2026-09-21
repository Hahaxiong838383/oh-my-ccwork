# 任务：把「语音体验 demo 线」搬到一台专用服务器（完整方案 + 执行 prompt）

> 交接自 cc 2026-09-21 10:34 CST 的 session。新 session 直接按本文执行；所有真值都来自实机核对，标「待核」的请先核再用。

## 0. 你是谁、规矩
- 你是 cc，川哥的搭档，全程中文，署名 `署名：cc（Claude）| <hook 报时>`。
- 红线：**不碰小可（P003）生产线**——64.90 的 `voice-worker-rust` / `voice-worker-firstturn` / `voice-worker-colleague`、47.239 的 `livekit-server` 与共享 env（`/root/realtime-voice-agent/.env`、`poc-eou.env`、`/root/rust-worker/rust-worker.env`）一律只读。
- 密钥只在服务器之间走 ssh/scp，不进 git、不进文档、不打印到终端（打印 env 只列键名，值用 `<masked>`）；SN 只写末 8 位；ssh 输出一律 `sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'` 兜底。
- 生产改动逐步 ssh 命令（整段脚本会被自动模式拦）；改前备份、改后健康检查；用前 grep 不猜（unit 名、路径、端口）。
- git：分支 `feat/voice-test-rust-demo`（已推 origin），worktree `~/mycc/.claude/worktrees/wt-voice-demo`，主 checkout 在 p003 分支别动；逐文件 `git add`，message 用 `-F`，无 Co-Authored-By；commit/push 只在川哥说的时候。

## 1. 背景与现状（已完成的第一阶段，2026-09-21 上午）
- demo 页 `https://voice-hk.hahaxiong.cc/voice-test-rust.html`（47.239 nginx 静态 `/var/www/voice/`）原来派单到小可生产池 `rust-worker`，token 09-11 已过期。
- 已做：页面入仓 `2-Projects/realtime-voice-agent/web/voice-test-rust.html`（token 占位 `__LIVEKIT_TOKEN__`）；`scripts/demo/sign_demo_token.py`（在 LiveKit 机用 `/root/voice-venv` 现签）+ `scripts/demo/deploy_demo_page.sh`（本机一键部署，token 不经本机）；64.90 新池 `voice-worker-demo.service`（`/root/rust-worker-demo/`，agent `rust-worker-demo`，env `rust-worker-demo.env` = 仓内 `rust-worker/ops/demo/rust-worker-demo.env.example`，unit = `rust-worker/ops/demo/voice-worker-demo.service`，安装脚本 `install_demo_pool.sh`）；页面 token 重签有效至 2027-03-20；探针验收全过（问候→字幕→eou 440 ms→首声 806 ms→DeepSeek ttft 654 ms）。架构说明 `docs/VOICE-DEMO-RUST-LINE.md`。
- 仍然共享的：LiveKit 信令/媒体（47.239 `voice-hk.hahaxiong.cc`，小可设备也连它）、64.90 机器资源（总内存 3.9 GB）、三份共享 env 的只读继承。**本任务目标 = 把这些也分开。**

## 2. 目标架构（推荐 A：整套独立）
```
浏览器 ──wss 443──► 新机 nginx（页面 + 反代）──► 新机 livekit-server:7880 ──/agent──► 新机 voice-worker-demo（agent rust-worker-demo）
                                                        媒体 UDP 7882 / TCP 7881 直连，TURN TLS 5349 / UDP 3478 兜底
```
- 新域名建议 `voice-demo.hahaxiong.cc`（A 记录 → 新机；证书 certbot --nginx）。`voice-hk.hahaxiong.cc` 留给小可。
- 备选 B（最小改动）：新机只跑 worker，仍连 47.239 的 LiveKit——只解决算力隔离，不解决信令共享，除非川哥点名否则不选。

## 3. 新机要求（硬）
- **Ubuntu 24.04 x86_64（glibc 2.39）**：现役 rust 二进制在 24.04 构建、符号门禁 ≤2.39，22.04 跑不起来；ldd 已核对二进制除系统库外零动态依赖。
- 2 vCPU / 4 GB 起（worker RSS 50–170 MB + EOT sidecar ~450 MB + livekit ~60 MB）；开放 TCP 80/443/7881、UDP 7882/3478、TCP 5349。
- root ssh；由川哥提供 IP / 凭据 / 云厂商（先问，不猜）。

## 4. 需要搬到新机的东西（清单，来源 64.90 / 47.239 实机核对）
| 项 | 来源 | 大小 | 说明 |
|---|---|---|---|
| rust 二进制 | 64.90 `/root/rust-worker-demo/voice-rust-worker`（sha256 b0ec810b…） | 72 MB | 以后从分支用 `rust-worker/scripts/build-local.sh`（home-studio，24.04）或 GH Actions `rust-worker-build.yml` 构建 |
| EOT sidecar | 64.90 `/root/rust-worker/eot_sidecar.py` + `/root/voice-venv`（numpy / onnxruntime 1.27 / sherpa_onnx 1.13.3 / livekit-plugins-turn-detector 1.6.3 …） | 670 MB | 可 tar 整个 venv（同 24.04 同路径 `/root/voice-venv` 才能直接用），或按上述包名重建 |
| EOT 模型缓存 | 64.90 HF 缓存（**待核**：`find /root/.cache -name '*.onnx'`，turn-detector v1-mini） | 待核 | 新机预置或用 `.env` 的 `HF_ENDPOINT` 镜像现下 |
| VAD 模型 | 64.90 `/root/rust-worker/silero_vad.onnx` | 2.3 MB | `VAD_MODEL_PATH` |
| 承接音库 | 64.90 `/opt/voice-agent/fillers-colleague`（94 个 wav） | 8 MB | `FILLER_DIR`；换音色要重跑 `scripts/gen_fillers.py` |
| 声纹模型 | 64.90 `/root/realtime-voice-agent/assets/models/3dspeaker_…onnx` + `assets/speakers/registry.json` | 27 MB | demo 可 `SPEAKER_ID_ENABLED=0` 不搬 |
| LiveKit | 47.239 `/etc/livekit/config.yaml`（439 B）当模板，**新机重新生成 API key/secret**；nginx 站点 `/etc/nginx/sites-enabled/voice-hk` 当模板；`/var/www/voice/livekit-client.umd.min.js` | — | 端口/TURN 见 §3 |
| 页面 | 仓内 `web/voice-test-rust.html`，`LIVEKIT_URL` 改成新域名 | — | token 由 `deploy_demo_page.sh` 在**新机**现签（`DEMO_HOST` 指向新机；新机需 `/root/voice-venv` 的 `livekit.api`） |

## 5. 新机 env（单文件 `/root/rust-worker-demo/demo.env`，600；unit 只加载它，不再继承小可的三份）
必需键（值从 64.90/47.239 对应文件逐 key 复制，LiveKit 三键换新机自己的）：
`LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET AGENT_NAME=rust-worker-demo WORKER_MAX_JOBS=1 EOT_SIDECAR_PYTHON EOT_SIDECAR_SCRIPT EOT_SOCK VAD_MODEL_PATH FILLER_DIR FILLER_PROBABILITY FILLER_BARGE_MAX_MS STT_PROVIDER=volc VOLC_ASR_API_KEY VOLC_ASR_RESOURCE_ID VOLC_ASR_END_WINDOW_MS VOLC_ASR_ENABLE_DDC VOLC_ASR_HOTWORDS TTS_PROVIDER=xfyun XFYUN_TTS_APP_ID XFYUN_TTS_API_KEY XFYUN_TTS_API_SECRET XFYUN_TTS_VCN LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY LLM_MODEL=deepseek-v4-flash LLM_THINKING=disabled LLM_URL_QUERY= LLM_FALLBACK_BASE_URL LLM_FALLBACK_API_KEY LLM_FALLBACK_MODEL LLM_FALLBACK_THINKING LLM_RACE_MAIN_GRACE_MS AGENT_GREETING AGENT_GREETING_ENABLED=1 MIN_ENDPOINTING_DELAY MAX_ENDPOINTING_DELAY（取 poc-eou.env 的 0.40/0.8）POC_PREDICTIVE_EOU POC_EOU_UNLIKELY_THRESHOLD POC_INTERIM_COMMIT MIN_INTERRUPTION_WORDS FALSE_INTERRUPTION_TIMEOUT POC_RESUME_FADE_MS BARGE_SPEAKER_GATE_MS INTERRUPT_HOTWORDS EXIT_SWALLOW_HOTWORDS BACKCHANNEL_HOTWORDS ECHO_SUPPRESS_WINDOW_MS MALLOC_ARENA_MAX=2 RUST_LOG HF_ENDPOINT SPEAKER_ID_ENABLED=0`
- 不要的键：`AGENT_INSTRUCTIONS`（不设 = 代码内置通用人设；川哥要专属人设再加）、所有 `P003_*` / `CANARY_*` / `SESSION_EXIT_*` / `ONESHOT_*` / `EOT_SNAPSHOT_DIR` / `LOCAL_AUDIO_*`。
- 做完必做 **逐 key 对账**：新机 `/proc/<pid>/environ` 键集 vs 上表；缺键在日志里往往不报错只静默降级（历史教训）。

## 6. 执行步骤
0. 向川哥要：新机 IP / root 凭据 / 厂商与到期、域名（默认 `voice-demo.hahaxiong.cc`）、是否保留 64.90 的 demo 池做回滚（默认保留、停用）。
1. 新机基线：`apt` 装 nginx certbot python3-venv；确认 `ldd --version` 2.39；开端口；DNS A 记录 → 新机；`certbot --nginx -d <域名>`。
2. LiveKit：下载与 47.239 同版本（1.13.2）livekit-server，按 47.239 config.yaml 模板改 `node_ip`=新机公网 IP、新 keys、TURN 域名/证书；systemd 起；`curl https://<域名>/` 期望 LiveKit 200 OK 文本。
3. worker：按 §4 搬文件到同路径；按 §5 写 `demo.env`；unit 参考仓内 `voice-worker-demo.service` 但 `EnvironmentFile` 只留 `demo.env`、去掉 `UnsetEnvironment` 那行的小可键（已不继承）；`systemctl enable --now voice-worker-demo`；journal 锚 `registered worker` + `EOT sidecar connected`。
4. 页面：仓内模板 `LIVEKIT_URL` 改新域名 → `DEMO_HOST=root@<新机> scripts/demo/deploy_demo_page.sh`（新机需 `/root/voice-venv/bin/python -c 'import livekit.api'` 可用）；nginx 站点复制 47.239 的三条 `location =`（页面/旧 Python 页可不要/`livekit-client.umd.min.js`）+ `location /` 反代 7880。
5. 验收（三条通道都要有，不看矩阵格子）：在新机跑**仓内版** `scripts/rtc_probe.py`（`set -a; . demo.env; set +a; PROBE_AGENT=rust-worker-demo … --wav probe.wav --listen 8`，probe.wav 从 47.239 复制）：期望问候字幕、用户 final 字幕、`eou`/`llm`/`tts` 指标、`★ 端到端首声`；再用浏览器打开新域名页面点「开始对话」看问候气泡；同时 `journalctl -u voice-worker-rust`（64.90）零该房行。
6. 切换与收尾：`voice-hk.hahaxiong.cc/voice-test-rust.html` 改成 302 到新域名（或留一页说明）；64.90 `systemctl disable --now voice-worker-demo`（目录保留作回滚）；更新 `docs/VOICE-DEMO-RUST-LINE.md`（拓扑改成新机）+ skill `voice-agent-ops` 的「语音体验 demo 独立线」段 + 记忆 `project_realtime_voice_agent.md`；`0-System/RECENT_EVENTS.md` / `task-log.md` 记事件；川哥点头后 commit/push 分支。

## 7. 验收判据（全部满足才算完成）
1. 新域名页面 200、token 有效期 ≥180 天、`LIVEKIT_URL` 指向新域名；
2. 新机 worker 注册且探针三通道齐全，首声 < 1.5 s；
3. 64.90 小可两池 PID/配置一字未变，`voice-worker-rust` 零 demo 房 job；47.239 只读；
4. 新机 env 逐 key 对账通过，无 `P003_*`、无设备 token 查询串；
5. 文档/skill/记忆已更新，密钥零落文档。

## 8. 回滚
- 页面回 64.90 池：把模板 `LIVEKIT_URL` 改回 `wss://voice-hk.hahaxiong.cc`，`DEMO_HOST=root@47.239.204.68 scripts/demo/deploy_demo_page.sh`，64.90 `systemctl enable --now voice-worker-demo`。
- 新机整机可弃，不影响任何现役线。

## 9. 已知坑（别重踩）
- 47.239 现役 `rtc_probe.py` 是旧版不认 `PROBE_AGENT`，会派到已退役的 `realtime-voice-agent` 名静默无指标——用仓内版。
- nginx 访问日志按日轮转，昨天的行在 `.log.1`。
- 64.90 总内存 3.9 GB（不是 31 GB）。
- `rust-worker.env` 的 `LLM_URL_QUERY` 带设备 token，demo 必须置空；小可侧这条是既有债（另开工单）。
- 换 TTS 音色必须重跑承接音合成，否则承接音与回答音色不一致。

## 10. 待川哥拍板（执行中遇到就问，别猜）
新机与域名；音色（沿用 xfyun 小可音色 vs volc 男声 + 重跑承接音）；专属人设文案；是否保留 64.90 demo 池作回滚。
