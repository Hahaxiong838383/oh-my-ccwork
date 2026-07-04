# music-orchestrator 设计文档

> 2026-07-04 定稿。背景：MyJavis（个人 Jarvis 语音助手）+ realtime-voice-agent（通用语音框架）都需要"能听懂'放一首歌'"的音乐播放能力，重复造轮子不划算，抽成共用服务。个人自用，不商用。

## 0. 决策链摘要（为什么长这样）

1. **VPS 拉流中转，不做纯 URL 分发**：`googlevideo.com`/B站 CDN 直链大陆不可达或有 Referer 防盗链，客户端必须经我方服务器代理播放字节。
2. **部署 HK 47.239.204.68，不用韩国**：MyJavis + realtime-voice-agent 已同机部署，工具调用是语音回合内延迟（省 localhost vs 跨机 35-40ms），流媒体是客户端有缓冲的环节（HK/KR 回程差异在此无感知）。见 [[feedback_volc_customllm_callback_geo_constraint]] 的"语音大脑选址三角"同一逻辑。
3. **不用美宅住宅 IP(lisa)兜底**：lisa 专职代理中转，不参与其他业务（川哥拍板）。改用"源冗余"代替"网络冗余"——B站/网易云对数据中心 IP 风控远松于 YouTube，主力承接量。
4. **三源分层，非单源**：YouTube 2026 年数据中心 IP 高概率触发 SABR/PO Token 拦截；B 站免登录即可取音频流、风控温和，作为 Day-1 MVP 主力；网易云复用已有 `ncm-cli` 资产做国内曲库补充；YouTube Music 降级为"全球库补充"，工程量最后做。
5. **不引入 Music Assistant**：其核心价值是局域网设备发现/编排（AirPlay/Cast/DLNA），VPS 上没有本地播放设备，价值落空；正确归宿是未来家庭 Mini/NAS 层。
6. **自建 Orchestrator，不用现成聚合 server**：调研过 xiaomusic/melody/lx-music/MusicFree，均不满足"面向 Agent 暴露 HTTP Tool API"这个形态，但复用了它们验证过的子构件（bilibili-api 库、yt-dlp 双源解析、多源打分换源思路）。
7. **两个消费方接入方式不同，且都不是"想当然"的 tool-calling**（此为本次落盘新增的关键澄清，见 §3/§4）。
8. **接入 multica 做日常维护**（本次新增，见 §5）：不改 multica 闭源 daemon，走"skill 教 LLM + wrapper 脚本"零侵入范式（已验证过的 multica 集成范式，见 [[feedback_multica_llm_skill_integration_pattern]]）。

## 1. 整体架构

```
                        ┌─ MyJavis server (Node/Hono, 同机 localhost) ─┐
                        │   custom-llm.ts 意图短路 + /api/music/pending 轮询
                        │
47.239.204.68 (HK ECS) ─┼─ realtime-voice-agent (Python/LiveKit, 同机 localhost)
                        │   fast_llm.py tools= 原生 function-calling
                        │
                        └─ music-orchestrator (FastAPI :8100, 本项目)
                              ├─ sources/bilibili.py   (bilibili-api 搜索 + yt-dlp 解析, Day-1 主力)
                              ├─ sources/ytmusic.py    (ytmusicapi 搜索 + yt-dlp 解析, Phase 3)
                              ├─ sources/netease.py    (包 ncm-cli, Phase 3)
                              ├─ ranking.py            (多源并发搜索→归一化→打分→排序)
                              ├─ cache.py              (本地 LRU, 目标 5GB)
                              ├─ routes/tools.py       (5 个高层 Tool, 两个消费方共用)
                              ├─ routes/stream.py      (Range 流代理, 播放端消费)
                              └─ routes/admin.py       (multica 维护 agent 专用, 独立 key)

公网: https://music.chenchuan.cc/ ── nginx (同机) ── 127.0.0.1:8100
       CF DNS A 记录, 灰云直连(实时应用铁律), 复用 chenchuan.cc zone (CF_API_TOKEN 已验证可用)
```

## 2. API 契约（两个消费方 + multica 维护方共用，先定契约后并行开工）

### 2.1 鉴权

- `X-Music-Key`：`/tools/*` + `/stream/*`，MyJavis 与 voice-agent 共用同一把（各自 env 配置，不下发前端）。
- `X-Music-Admin-Key`：`/admin/*`，单独一把，只有 Mini 上的 multica 维护 wrapper 脚本知道（不进 multica issue 明文，不进 LLM 可见文本）。

### 2.2 Tool 端点（语音场景高层接口，粗粒度、不暴露底层源细节）

所有请求带 `session_id`（调用方各自的房间/会话标识：MyJavis 传 `roomId`，voice-agent 传 LiveKit room name）——**队列/播放状态必须按 session_id 隔离**，服务两个 App 的多个并发会话不能互相污染播放状态。

```
POST /tools/music_search   {query, limit=5, session_id}
  → {results: [{id, source, title, artist, duration_sec, score}]}

POST /tools/music_play     {query, mode="track"|"radio"|"playlist", session_id}
  → 高置信度(top1 score>阈值): {status:"playing", track, stream_url}
  → 中置信度: {status:"playing", track, stream_url, alternatives:[...]}
  → 低置信度/多义: {status:"ambiguous", candidates:[...]}  ← 调用方 LLM 据此反问用户
  → 无结果: {status:"not_found"}

POST /tools/music_control  {action:"pause"|"resume"|"next"|"prev"|"stop"|"volume", value=None, session_id}
  → {status, current_state}

POST /tools/music_queue    {action:"add"|"clear"|"list", item=None, session_id}
  → {queue:[...]}

GET  /tools/music_status?session_id=
  → {playing, current_track, queue, position_sec}
```

源路由策略（ranking.py）：三源并发搜索 → 归一化成 `SearchResult(id, source, title, artist, duration_sec, popularity)` → 打分（标题/歌手模糊匹配 + 时长合理性 90-480s + 热度信号）→ 排序。华语默认 bilibili/netease 优先命中，英文/全球内容 ytmusic 优先；单源解析失败自动降级下一源。

### 2.3 流代理端点（播放端消费，Range-aware）

```
GET /stream/{source}/{track_id}
  → audio bytes, 支持 Range 请求, 命中 LRU 缓存直接返回, 否则实时 yt-dlp 解析后转发+落盘缓存
```

### 2.4 Admin 端点（仅 multica 维护 agent 用，见 §5）

```
GET  /admin/report        → {cache_size_mb, cache_item_count, source_health:{bilibili:{ok_rate,last_fail_at},...}, yt_dlp_version, uptime_sec}
POST /admin/prune-cache    {target_mb=None} → {pruned_items, freed_mb}
POST /admin/check-sources  → {bilibili:"ok"|"degraded"|"down", ytmusic:..., netease:...}  (轻量真实探活)
```

## 3. MyJavis 接入方式（★ 关键澄清：不是 tool-calling）

**读源码验证结论**（`apps/server/src/providers/llm.ts` + `routes/custom-llm.ts`）：MyJavis 的 LLM 层是纯 OpenAI 兼容 **文本流式**（`streamChat` 只有 `onDelta/onDone/onError`，请求体没有 `tools`/`tool_calls` 字段），**没有 function-calling 基础设施**。火山 RTC 的 CustomLLM 回调本身也只认 ChatCompletion SSE 文本流，不是给 Agent 工具调用设计的通道。

MyJavis 已有的、被验证过的对应模式是**声纹对话式注册**（`voiceprint/enroll-session.ts` + `custom-llm.ts` 的 `resolveEnrollCanned`）：正则/启发式意图检测在调 LLM **之前**短路，命中则直接走预置话术，跳过 LLM。同时前端拿不到 custom-llm 的 SSE（那是火山→我方大脑的回调通道，不直通前端），已验证的"服务端→前端通知"手段是**轮询**（"前端 2.5s 轮询 /api/voiceprint/pending"）。

**音乐接入照抄这个已验证范式，不引入新架构**：

1. 新增 `music-intent.ts`（结构比照 `enroll-session.ts`）：正则识别"放一首/播放/换一首/暂停/继续/大点声"等播放意图 + 提取查询词。
2. `custom-llm.ts` 里 `resolveEnrollCanned` 调用点旁边加一个同级短路：命中播放意图 → 调 Orchestrator `/tools/music_search`+`/tools/music_play`（session_id=roomId）→ 若 ambiguous 走 `streamCannedReply` 反问候选 → 若命中，一边 `streamCannedReply` 一句"好，给你放《歌名》"，一边把 `{action:"play", stream_url, title}` 写进一个内存 pending map（roomId 键，仿 `enroll-session.ts` 的会话状态管理方式）。
3. 新增路由 `routes/music.ts`：`GET /api/music/pending?roomId=` 给前端轮询用（比照 `routes/voiceprint.ts` 的 pending 接口实现，取件即清空）。
4. 前端（`kidshub` 目录外，MyJavis 自己的 web/Tauri 端）加 `<audio>` 播放器，轮询命中即换源播放；说话时压低音量（duck，onSpeaking 时 `audio.volume=0.3`，结束恢复）。音乐走独立 `<audio>` 通道，完全不进火山 RTC 语音链路，两者互不干扰。

## 4. realtime-voice-agent 接入方式（原生 function-calling，路子不同）

**读源码验证结论**（`engines/fast_llm.py`）：这里的 LLM 层**原生支持** LiveKit Agents 的 `tools=` 参数（`FastLLMStream(..., tools=tools or [])`），是围绕 OpenAI-style function-calling 设计的框架。

接入方式：用 LiveKit Agents 的 `@function_tool` 装饰器（或该项目已有的等价机制，实现前先读 `engines/base.py`/`engines/tier_a_cascade.py` 确认当前 Agent/AgentSession 组装点，不臆造）直接注册 5 个音乐工具，Agent 判断要不要调用、要不要反问用户（ambiguous 候选），是标准 tool-calling 而非 MyJavis 那种正则短路。

拉流后的播放方式：Orchestrator 解出音频后，agent 进程（服务端）用 LiveKit 的 audio track publish API 把这路音频发布成房间内独立 track（服务端混音），客户端 UI 侧零改动——这是 LiveKit 架构对"服务端主动推音频"的标准支持路径，实现前同样要先读 `adapters/livekit_adapter.py` 确认当前发布 track 的既有方式，照着接，不是另起一套。

## 5. multica 日常维护接入（本次新增）

**背景**：multica（自托管多智能体任务平台，QNAP+Mini 部署，见 memory `project_multica_team_deploy`）daemon 是闭源 Go binary，spawn agent 时只给 `issue_id`，agent 自己 `multica issue get` 拿详情。已验证的第三方系统集成范式是"skill markdown 教 LLM 三步走 + issue.metadata 传上下文 + bash wrapper 做真实 side-effect"（见 memory `feedback_multica_llm_skill_integration_pattern`），不改 daemon、不写 custom_env。

**落地设计**：

1. **wrapper 脚本** `~/bin/music-maintenance.sh`（部署在 Mini，multica agent 实际执行环境）：三个子命令 `report`/`prune`/`check-sources`，各自 curl Orchestrator 对应 `/admin/*` 端点，`X-Music-Admin-Key` 从 Mini 本地 `~/.mycc-secrets.env` 读取（**密钥不进 multica issue 正文/metadata**，agent 只会调 wrapper，看不到明文 key——呼应"secret 绝不写进规则/记忆，只存指针"铁律，也绕开 multica 无 per-issue ACL、workspace 内全员可见的限制，见 memory `feedback_multica_no_per_issue_acl`）。
2. **skill markdown**（multica workspace 绑定）：教 LLM 三步走——① 跑 `bash music-maintenance.sh report` 拿健康数据；② 按铁律判断要不要 `prune`（缓存超 4GB 才清，不到阈值不动）；③ 结果摘要写回 issue comment。铁律包含"绝不擅自重启服务/绝不改 nginx/绝不碰非 /admin 端点"（scope 收紧，音乐维护 agent 只有只读探活 + 缓存清理两个动作权限）。
3. **每日触发**：multica 无原生 recurring issue，用 Mini 现有 launchd（已有 frpc/daemon 同类先例）新增 `com.multica.music-maintenance.plist`，每日固定时间跑 `multica issue create`（CLI）在指定 workspace 建一条"音乐服务日常维护"issue 并指派给维护 agent，metadata 只带 `orchestrator_base_url`（不带密钥）。
4. **失败可见性**：agent 处理不了（如 source 全挂）时 skill 教它在 issue comment 标 `NEEDS_HUMAN` 前缀，人工层面后续可接飞书通知（不在本次范围内，留 TODO）。

**已落盘文件**（`deploy/multica/`）：`music-maintenance.sh`（wrapper）、`music-ops-skill.md`（skill markdown）、`daily-issue-trigger.sh` + `com.multica.music-maintenance.plist.example`（每日触发，⚠️ `multica issue create` 的具体 flag 未经实测验证，部署时需先 `--help` 核对）。实际安装到 Mini（脚本落地 + launchd 加载 + multica workspace 建 agent 绑定 skill）留到 Orchestrator 部署上线、`/admin` 端点真实可访问之后再联调，现在装上去也测不了。

## 6. 部署（HK 47.239.204.68，需川哥显式授权后执行）

- 路径 `/opt/music-orchestrator/`，Python venv，`pm2 start` 管理（与 MyJavis 同一 pm2 实例，一套运维习惯）。
- nginx 新 server block，域名 `music.chenchuan.cc`（CF zone `chenchuan.cc` 已验证 token 可用，新增 A 记录指向 47.239.204.68，DNS-only 灰云，同机复用 certbot 流程）。
- systemd/pm2 资源限额保护同机的 LiveKit 实时流优先级（yt-dlp 限速 `--limit-rate 2M` + CPU 配额）。
- 缓存目录 `/opt/music-orchestrator/cache/`，LRU 5GB 上限。

## 7. 落地阶段

1. **Phase 1（本轮）**：Orchestrator 核心（bilibili 单源可用，ytmusic/netease 留接口 stub）+ MyJavis 接入 + voice-agent 接入 三路并行实现；multica 维护 skill/wrapper 同步写好（先备好，等 admin API 部署后联调）。
2. **Phase 1 收尾**：部署 HK、接 DNS/nginx、公网 E2E（cc 自验，不甩给用户）。
3. **Phase 2（后续）**：ytmusic 源（小号 cookies + PO Token 插件）+ netease 源（包 `ncm-cli`）接入 ranking.py，多源竞速验证。
4. **观察期**：命中率/失败率数据说话，再调打分权重、缓存阈值、multica 维护动作范围。

## 8. 已验证的风险（2026-07-04 真机测试发现，不是纸面推演）

**bilibili resolve() 会遇到 HTTP 412**：本地真机测试（非 mock）验证 `search()` 完全正常（真实返回周杰伦《晴天》等结果，标题/歌手/时长/热度字段均正确），但 `resolve()`（yt-dlp 取音频直链）对 3 个不同 bvid 均返回 `HTTP Error 412: Precondition Failed`。查证 yt-dlp 官方 GitHub 近 1-2 个月内有多个同类新 issue（#16962/#16565/#16584），官方确认是 **B 站近期收紧反爬**（"exceeding request limit gets you blocked... even with cookies"），非本项目代码问题——但这也意味着 turn 2 判断的"B 站风控温和、免登录可行"这个结论需要**下调置信度**，可能已经不再成立或至少不稳定。

已加的缓解（`app/sources/bilibili.py`）：Referer/UA 请求头、412 命中时短退避重试 2 次、`BILIBILI_SESSDATA` 可选 cookie 配置。加了之后本地重测仍 412（大概率是我本机 IP 被我自己短时间内的多次测试请求触发了临时封锁，issue 原文说这类封锁几分钟到几小时自行解除）——**HK 生产 IP 是全新、干净的，实际可用性没法在部署前 100% 确定**，这是诚实的未知，不是"应该没问题"的乐观假设。

**建议**：① 部署后第一件事就是用生产 IP 真实验证 bilibili resolve，不要假设本地测试结果能推广；② 如果生产环境也频繁 412，`ncm-cli`（网易云，已是现成资产、有 API key、非 yt-dlp 尝试兜底网站结构而是官方向 API）大概率比 bilibili 更稳定，值得考虑从"Phase 3"提前到"Phase 1 并列源"而不是纯兜底；③ 缓存命中后不再重新 resolve，天然降低触发频率，这也是既有 LRU 缓存设计的额外价值。

### 8.1 已根治（2026-07-04 当天，同一轮部署内发现并修复）

上述 412 风险**已找到根治方案，不再是开放风险**：`resolve()` 改用 `bilibili_api.video.Video.get_download_url(cid, html5=True)`（bilibili-api 库自带的"移动端 HTML5 免鉴权播放流"官方签名接口）替代 yt-dlp 的网页抓取方式——两条路径命中 B 站不同的检测逻辑，网页抓取被限，官方签名 API 完全不受影响。生产 HK IP 与本地 IP 双重验证通过，零 412。

配套发现并修复的第二个问题：拿到直链后**真正下载字节会被 CDN 返回 403**（签名 URL 需要配对 `Referer: https://www.bilibili.com/` 请求头才能通过校验）——已在 `Source` 协议加 `download_headers()` 方法，`stream.py` 下载时透传。

**最终端到端验证**（生产环境，全新视频强制 cache miss）：HTTP 200，下载 24.3MB，`ffprobe` 确认真实可播放 MP4（h264+aac，时长 222.5s 与真实歌曲长度吻合）。全新请求耗时 **~40 秒**（resolve+下载+写缓存全部完成才响应）——这是"先完整下载再响应"这个 MVP 简化设计的代价，对语音陪伴场景是明显的体验短板。

## 9. 边下边流改造 + 存储上限（2026-07-04 同日第二轮，川哥要求优化）

### 9.1 真流式 + 音频提取

`stream.py` 重写：上游字节不再"整个下载完再响应"，而是 httpx 流式拉取 → 实时喂进 ffmpeg 子进程（`-vn -c:a copy`，丢视频轨、音频不重新编码直接透传）→ ffmpeg 输出的 fragmented mp4(m4a) 音频字节**同时**：① yield 给客户端（边收边发）② 写入临时缓存文件；下载完成后原子 rename 成正式缓存条目。之所以能这样做：`html5=True` 拿到的直链本是视频+音频混流的 MP4，之前整个存下来既浪费带宽也浪费磁盘，实际只需要音频轨。

**本地真实验证**（`ffmpeg` 本机装好后跑通，非纸面设计）：
- 首字节延迟：**0.54 秒**（原来 ~40 秒）
- 文件体积：**8.9MB**（原来 24-58MB，纯音频 vs 视频+音频混流）
- `ffprobe` 确认输出只有 `codec_type=audio`（无 video 流），时长 222.5s 与原视频一致
- 缓存正确 finalize（无 `.tmp` 残留），二次请求命中缓存仅 0.014 秒

已知简化（有意为之）：① 流式（未缓存）请求不支持 Range——语音点歌场景用户不会去 seek 一首还没放完的新歌，缓存命中后走 `FileResponse` 原生支持 Range；② 两个并发请求同一首"从未缓存过"的歌会各自触发一次下载（无 leader/follower 去重协调），个人自用场景概率极低，为此增加协调复杂度不划算。

### 9.2 存储上限：3000MB（3GB）

**依据真实测量数据推算**（不是拍脑袋）：改用音频提取后单曲实测 8.9MB（一首 3:42 的歌），按此计算：
- 3000MB ÷ ~9MB/首 ≈ **330+ 首歌**的缓存容量，对个人+少数人使用场景相当充裕
- 部署机 47.239.204.68 磁盘 40G 总量、部署时刻 32G 空闲，3GB 缓存仅占用空闲空间的 **~9%**，给同机运行的 MyJavis / LiveKit / 系统更新留足 29G 头部空间（这台机不是专用存储机，音乐缓存只是其中一个租户）
- 缓存本身有 LRU 自动淘汰（`cache.py` 每次写入后自动 `prune()` 到上限以内），即使超过 330 首歌的使用量也不会无限增长，只是老歌被淘汰重新变成"首次播放"

`CACHE_MAX_MB` 默认从最初拍脑袋的 5000 下调到 **3000**（`app/config.py` + 生产 `.env`），multica 日常维护 skill 的兜底阈值同步改为"明显超过 3000（自动 prune 疑似失灵）才手动清"——因为正常情况下服务自身的自动 prune 已经持续把大小控制在上限内，不需要人工介入。
