# 小可个人大脑 · 飞牛 2

运行分工见[个人语音助手产品架构](../../docs/个人语音助手产品架构.md)。

## Worker 接入

飞牛 2 的 Docker 容器通过 `personal-voice-private` 访问 `http://personal-brain:8080/v1/chat/completions`。该网络是独立的 Docker internal bridge。脑容器单独连接一个出网网络，用于访问个人 CPA 和公开资料源。Compose 仅通过容器网络提供入口。Worker 同时接入自己的出网网络以连北京。

NAS 配置文件在 `/vol1/1000/docker/personal-voice-runtime/private/brain.env`，权限 `0600`。在 worker 的 Compose 中作为最后一个 `env_file` 加载，清掉 Compose `environment` 里任何会覆盖下表的旧值。大脑使用的上游配置保存在单独的 `service.env`。

| 变量 | 约定 |
| --- | --- |
| `LLM_BASE_URL` | `http://personal-brain:8080/v1` |
| `LLM_MODEL` | `personal-brain` |
| `LLM_API_KEY` | 个人 worker 专用 Bearer，用现有文件加载 |
| `LLM_URL_QUERY` | 空 |
| `LLM_FALLBACK_ENABLED` | `0` |
| `P003_SEARCH_ENABLED` | `0`，个人大脑处理查找意图 |
| `VOLC_PREFLIGHT_ENABLED` | `0`，只发送已提交的语音轮次 |
| `ORDERED_SPEC_ON_FINAL_ENABLED` | `0`，已提交后再触发有副作用的查询或记忆 |

`stream:true` 返回 SSE，`stream:false` 返回普通 Chat Completion。每轮传可信 worker 的 `?room=`，也接受 `X-Personal-Session`。房间只分隔对话和任务，同一服务固定绑定一个主人。OpenAI 请求的 `user` 字段和系统消息不参与主人绑定。主动中断时由 worker 关闭本轮 HTTP 流；同一房间的新请求会取消旧请求。无房间请求可生成普通答复，房间预热直接应答。使用 `store:false` 可跳过对话落库、长期记忆和人格使用。

查找、天气、时间回执以顶层 `tool` 返回。流式响应在 `[DONE]` 前的终止块发送元数据，`choices[0]` 为 `{ "index": 0, "delta": {}, "finish_reason": "stop" }`。

```json
{
  "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
  "tool": "search",
  "sources": [{ "title": "What’s new in Python 3.14", "url": "https://docs.python.org/3/whatsnew/3.14.html", "date": null }]
}
```

`tool` 的可能值为 `search`、`weather`、`clock`、`search_cancel`。`sources` 是顶层数组，每项包含 `title`、`url`、`date`，日期可能为 `null`。查询无来源时返回空数组，普通聊天、时钟和取消回执省略该字段。同房间接续可重用上一次结果及其来源。非流式 JSON 响应使用相同顶层字段。朗读取 `choices[0].delta.content`；当前 Rust worker 的普通聊天流只转发正文，手机展示来源需在 worker 读取终止块并转发元数据。音频播放回执归 worker。

## 实现与依赖

构建从 P003 服务端源码挑选时钟、百度及墨迹天气、央视检索、搜索执行与任务账本、记忆抽取和提示词组装、关系、特质、风格及成长账本。个人入口用严格 Bearer 校验并固定主人。数据写入专用 `brain-data/`，其中包含个人画像、对话和搜索三个 SQLite 文件。普通聊天先完成对话写入，再异步串行抽取本房间的记忆，原始证据可通过消息 ID 回看。语音提出改变风格后，原有特质规则与成长账本负责保存，本轮与后续轮次均读取实际模板。

聊天、抽取和搜索摘要使用凭据库中的个人 CPA，实测模型为 `gpt-6.1-sol`。央视国内及航天新闻、百度天气和兼容城市的墨迹天气走原有来源。通用网页查询优先使用已配置的个人 `BRAIN_DEEPSEEK_SEARCH_KEY`，缺少该项或结果无可用来源时，在查询时限内请求个人 CPA 的 `/v1/responses` 内置 `web_search`。有主备时给 DeepSeek 最多 8 秒，整个搜索任务最长 20 秒。设置 `BRAIN_CPA_WEB_SEARCH=0` 可关闭通用后备。CPA 请求只带通过隐私检查的本轮公开查询和固定搜索指令，设置 `store:false`，不传画像、历史或记忆。有完成的搜索调用和通过格式检查的 HTTPS 引用时才返回结果，引用标题和链接来自 `url_citation`，缺少发布日期时返回 `null`。新闻摘要超时而正文已通过来源和日期核验时，直接播报带出处的原始标题。设备动作和真实播放回执仍需 worker 与设备端能力链路。

个人进程仅加载构建清单中的复用模块和专用配置。该入口、数据库和模型配置与 P003 生产签票、存量数据库及方舟服务隔离。

## 私有供应商文件

容器读取 `PERSONAL_PROVIDERS_FILE=/run/personal-providers/providers.json`。飞牛把 `/vol1/1000/docker/personal-voice-runtime/private/providers/` 整目录以只读方式挂到 `/run/personal-providers`，换文件时先写临时文件再在同一目录内改名。文件缺失、三个 `active` 都是 `null`，或文件通不过契约时，聊天、非流式答复和记忆抽取继续使用 `service.env` 里的个人 CPA。识别保持飞牛中文 ASR，合成保持飞牛五音色。校验失败时 `/health` 的 `providers.state` 为 `invalid`，进程不使用文件里的密钥。

`active.llm` 只能指向 `driver=deepseek` 的档案。同一文件可以放多档模型，每档使用自己的 `DEEPSEEK_MODEL`。选定后，流式聊天、普通聊天、搜索规划里的 `chat/completions`，以及记忆抽取，都把该模型原样发给 `https://api.deepseek.com/v1/chat/completions`。深度模型档案不会因此去掉 `tools`。档案里的 `DEEPSEEK_API_KEY` 只进入这一个官方请求，不接受档案指定的地址。`/v1/responses` 的网页搜索仍用个人 CPA，请求保持 `store:false`。DeepSeek 的 `tools/search` 仍只使用原来的 `BRAIN_DEEPSEEK_SEARCH_KEY`。人格记忆仍由原来的提示词组装和抽取链路处理。

`APP_ID`、访问令牌和 API key 放在 `secrets`。资源 ID、模型名、音色名、可选的官方 ASR 地址，以及 `VOLC_ASR_END_WINDOW_MS`、`VOLC_ASR_ENABLE_DDC` 放在 `config`。这些键都使用大写环境变量名。`/health` 只返回修订号、档案 ID、驱动和 DeepSeek 模型名。本服务不拨打 ASR 或 TTS，也不把语音密钥转发到其他地址。

## 重建和验收

在本目录用 `BRAIN_BUILD=<版本> ./build.sh`，构建从 P003 的锁文件安装临时依赖、做 TypeScript 检查，并打包到固定摘要的 Node 24 基础镜像。将同标签镜像加载到飞牛 2，再在运行目录执行 `BRAIN_BUILD=<版本> docker compose -f compose.brain.yaml up -d --no-build --wait`。重建保留 `brain-data/` 和私密配置，选回已验证标签时要明示所用版本。备份 SQLite 时使用在线备份或停该服务后保存数据库及其 WAL。

`verify.mjs` 默认从私网同伴容器测试鉴权、时钟、实时央视查询、来源和同房接续。设置 `BRAIN_VERIFY_WEATHER=1` 时同时检查真实天气及缺城市追问。设置 `BRAIN_VERIFY_CPA_SEARCH=1` 时验证 Python 官方文档查询、SSE 终止块、同房接续、隐私拒绝与同房取消。使用另起的同镜像实例、临时独立数据库、独立测试主人和 `BRAIN_VERIFY_DATA=/data` 才执行写入型验收，另配 `BRAIN_VERIFY_PROMPT=1` 时服务器仅记录关系、特质及风格段是否实际注入。写入型验收涵盖新房间回忆、来源消息 ID、反馈账本及下一轮风格，正常运行卷没有测试人物或预填记忆。公开来源与模型暂时不可用时，验收直接报错。

## 飞牛 2 发布记录 · 2026-11-25

### 当前版本 `personal-brain:20261125.9`

- 飞牛 2 容器 `personal-brain-brain-1` 为 `healthy`。飞牛回读镜像 ID 为 `sha256:83d184ad40789b2844e7f26f33beb34052ad5430aab06e97ae2a7ed81677440e`，标签 `personal-brain:20261125.9`。运行中的 `/app/server.mjs` SHA256 为 `616ed5e0a2274a0ebe37b0f3d77d6e37d4f01feb1d974695108e5cab4ed70c32`，`/app/verify.mjs` 为 `5aa359000f8341b41399812018e1f4d934ab3cb99986c496b1dd841247f7c119`，与本地构建上下文一致。
- 供应商目录只读挂载。现有 `providers.json` 未改，`active` 三个选择都是 `null`。`/health` 回读 `providers.state=ready`、`revision=1`，聊天模型仍是个人 CPA `gpt-6.1-sol`，识别与合成回退仍是飞牛中文 ASR 和五音色。容器内写探测返回 `EROFS`。伦敦时间工具返回 200。
- 回滚到本改动之前：在 `/vol1/1000/docker/personal-voice-runtime` 执行 `BRAIN_BUILD=20261125.7 docker compose -f compose.brain.yaml up -d --no-build --no-deps --wait brain`。`.7` 不读取供应商文件。若要同时去掉挂载，先把 `compose.brain.yaml.bak-20261125.7` 覆盖回 `compose.brain.yaml`，再执行同一条命令。

### 上一版 `personal-brain:20261125.7`

- 飞牛 2 正式容器 `personal-brain-brain-1` 回读为 `healthy`，镜像 ID 为 `sha256:f9327b3ca9cf168281c2ee3bfe7bd34f155a092e7e9fef3db913243c13d09edf`。逐文件 SHA256 为 `d4f5e67c727e5350f12be21a6df3f961b28de88c165d1e2a82989fb882f923c1`（`/app/server.mjs`）和 `5aa359000f8341b41399812018e1f4d934ab3cb99986c496b1dd841247f7c119`（`/app/verify.mjs`），与本地构建一致。变更源码保留在本工作树。
- 个人 CPA 实测返回已完成的 `web_search_call` 与 `url_citation`。从 worker 私网测试得到 Python 3.14.0 的首次发布日期为 2025 年 10 月 7 日，已回读[官方发布公告](https://www.python.org/downloads/release/python-3140/)。鉴权、时钟、央视、实际天气、终止块引用、同房接续、私有查询拦截与同房取消通过。隔离库确认取消任务无结果，拒绝的私有查询未入任务表。
- `.6` 首次正式测试给出正确日期但引用文档目录，已回滚。`.7` 要求引用结论所在正文，并通过隔离和正式实例验收。可回滚至 `personal-brain:20261125.5`。

### 上一版 `personal-brain:20261125.5`

- 运行容器为 `personal-brain-brain-1`，标签 `personal-brain:20261125.5`。NAS 回读镜像为 `sha256:bb24d1a091273ef9c0d08858edbc959add5b29c5177817656c4255f0769e364d`，入口产物 `server.mjs` 的 SHA256 为 `e5e7e4e5b07ed1cdac509d785f39269371672225ddc2ce1e82cbe2c5fa2c6bc7`。
- NAS 实测经私网同伴容器加载 `brain.env` 完成普通 SSE。鉴权、时钟、真实天气及跨房间隔离验收通过。真实新闻带日期和原文链接，取消中的任务不会串到下一轮。独立测试复现摘要模型失败时仍可收到经过校验的原文标题与链接。
- 测试实例用新数据库，经真实模型完成两次不同房间的偏好及称呼写回和召回。验收核对源消息 ID、成长账本和下一房间已注入的关系、特质及风格。线上卷只建一名主人，初装核验记忆、成长、对话数均为零。
- 收工时私网中有个人大脑与个人后台。当前验收到大脑 API 与 Docker 网络，手机音频和引用显示由 worker 联调验收。

## 个人语音的衔接短语

个人 Worker 发起的流式房间请求会等首个可朗读的完整句子。普通聊天等到 750 毫秒仍无首句时，小可先说一句「让我想一想。」之类的短语。同一通话连续聊天，普通衔接语间隔至少 20 秒，其他设备的房间独立计时。搜索任务实际排队或执行后使用 390 毫秒的等待时间，可以说「我来查一下。」。正文先就绪就直接播，查时间等短答也是直接播。搜索语句轮换，同一轮最多一次。它与正文走同一房间、同一 TTS、同一打断通道。长期对话记录及记忆提取接收回答正文。文字端和后台试问维持原响应。

个人后台四种风格的概率目前属于原预录短语库。本段的延时衔接策略由个人大脑执行。维护验收用新语音房提问一条普通问题、一条需要在线查来源的问题及一次查询中插话，再核对手机收到的首句字幕、对应非零音量、正文和取消结果。

个人语音的短查询会先识别常见自然问法。一般聊天也可申请检索本轮明确说出的公开主题。请求一条当下国内新闻时会优先核对央视正文，超过 2.5 秒转普通检索。指定日期、来源、专题或条数时保留原意。
