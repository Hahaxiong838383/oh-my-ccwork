# JavisVoice 接入指南（给 demo 合作方）

> 你拿到的是一个**托管语音会话服务**：全双工打断、语义判停、承接语、字幕，全部服务端处理。
> 你只需要：①把自己的讯飞 / 大脑凭据写进来 ②页面里引一个 `<script>`。看不到也不需要关心内部实现。

## 0. 你会拿到

| 东西 | 说明 |
|---|---|
| `API` | `https://voice-api.hahaxiong.cc` |
| `你的接入 key` | 形如 `jv_xxx…`（线下单独给你，只发一次） |

## 1. 写入你自己的凭据（key 不经任何人转手）

三条 curl，直接在你自己电脑上执行。写入即校验：我们会拿它真调一次对应服务，**无效的 key 当场拒绝、不落盘**；有效的 key 加密存储、任何接口不回显明文（只回 `****` 指纹）。

```bash
# ① 讯飞·实时语音转写大模型(控制台「实时语音转写大模型」服务的 appId/accessKeyId/accessKeySecret)
curl -X POST https://voice-api.hahaxiong.cc/v1/credentials \
  -H "Authorization: Bearer jv_你的key" -H "Content-Type: application/json" \
  -d '{"provider":"xfyun_stt","credentials":{"app_id":"…","access_key_id":"…","access_key_secret":"…"}}'
```

```bash
# ② 讯飞·超拟人语音合成(开放平台三件套;vcn 发音人可选,默认 x6_lingxiaoxuan_pro 聆小璇)
curl -X POST https://voice-api.hahaxiong.cc/v1/credentials \
  -H "Authorization: Bearer jv_你的key" -H "Content-Type: application/json" \
  -d '{"provider":"xfyun_tts","credentials":{"app_id":"…","api_key":"…","api_secret":"…","vcn":"x6_lingxiaoxuan_pro"}}'
```

```bash
# ③ 你的大脑:任意 OpenAI 兼容 /chat/completions 端点(比如你包了 Qwen 的服务)。
# base_url 填到 /v1 这一级;对话逻辑、prompt、记忆全在你自己服务里,我们只透传。
curl -X POST https://voice-api.hahaxiong.cc/v1/credentials \
  -H "Authorization: Bearer jv_你的key" -H "Content-Type: application/json" \
  -d '{"provider":"brain","credentials":{"base_url":"https://你的服务/v1","api_key":"…","model":"qwen-plus"}}'
```

查看已配置（只有指纹）：

```bash
curl https://voice-api.hahaxiong.cc/v1/credentials -H "Authorization: Bearer jv_你的key"
```

三条都配好后**说一声**，服务端把你的会话切到讯飞链路（一次性开关）。

## 2. 页面接入（两步）

```html
<script src="https://voice-api.hahaxiong.cc/sdk/v1.js"></script>
<script>
  // 必须在用户点击等手势里调用(浏览器麦克风/自动播放限制)
  async function startVoice() {
    const session = await JavisVoice.connect({
      apiKey: "jv_你的key",
      // ⚠️ 每次必传你的用户标识(如激活码):它会以 OpenAI 标准 user 字段
      // 原样出现在发往你 LLM 端点的每个请求里(含开场白请求),你按它读用户记忆。
      // 不传时默认 "user"——所有人的记忆会串到同一个名下。
      participantName: "P3ZSUH6J",
    });

    session.on("transcript", ({ role, text, final }) => {
      // role: "user"(你说的) | "agent"(AI 说的);final=false 是打字机中间态
      console.log(role, text, final);
    });
    session.on("state", (s) => console.log("state:", s));      // connected/reconnecting/disconnected
    session.on("metrics", (m) => console.log("延迟:", m));      // {stt_ms,eou_ms,ttft_ms,ttfb_ms}
    session.on("speaking", ({ speaking }) => {                  // 服务端权威说话状态
      // true=AI 开始播报;false=本轮播报完毕(切图标/起超时计时用它,别再猜电平)
      console.log("speaking:", speaking);
    });

    // session.setMicEnabled(false);  // 闭麦(同时真正释放麦克风设备,见 §5.1)
    // await session.close();          // 挂断
    window.session = session;
  }
</script>
<button onclick="startVoice()">开始对话</button>
```

就这些。连接后：对着麦克风说话 → 你的大脑回答 → 讯飞音色播出，随时插话可打断。

## 2.5 新能力（2026-07-31 上线）

### `JavisVoice.prewarm()` —— 唤醒前预热网络层

```js
// 页面加载后/定时保温(替换你现有的 40s 轻量请求逻辑)
await JavisVoice.prewarm();   // 预热 API 域 + 信令域的 DNS/TCP/TLS
```

不创建会话、不占 worker 名额、不发声，幂等可重复调，失败静默。唤醒瞬间只剩真正的会话创建开销。

### `speaking` 事件 —— 每轮"说完了"的权威信号

见上方示例。`{speaking:false}` 在服务端本轮播报完成时触发（实测紧跟最后一条 final 字幕）。语义是"服务端播完"，与扬声器实际放完之间有极小的播放缓冲差（百毫秒级），做图标切换与超时计时足够。

### `session.room` —— 公开 API（稳定承诺）

`session.room` 返回底层房间对象，`room.startAudio()`（解锁自动播放）、`room.localParticipant`（本地音轨→电平分析）、`room.activeSpeakers` 都可放心用。**接口稳定承诺**：不会静默变更，如需调整会提前在本文档同步。另有 `session.agentAudioTrack` 直接拿 AI 的远端音频轨（做"说话中"声纹的真实驱动）。

### 说完即挂断（哨兵 `[[END_SESSION]]`）—— 服务端已就绪

你的大脑在告别语**末尾**输出 `[[END_SESSION]]`：我们在进 TTS/字幕**之前**把它剥离（绝不会被念出、不进 transcript），等这句真正播完后服务端结束会话，你的前端收到现有 `disconnected` 事件即可收尾。你侧只需打开输出开关（`BRAIN_END_SENTINEL`）。

### `POST /v1/tts` —— 场景语音（文本→流式 mp3，不开房间）

```bash
curl -X POST https://voice-api.hahaxiong.cc/v1/tts \
  -H "Authorization: Bearer jv_你的key" -H "Content-Type: application/json" \
  -d '{"text":"欢迎回来,今天也一起冒险吧!"}' --output line.mp3
```

- 用你已写入的讯飞 TTS 凭据合成，默认聆小璇，`audio/mpeg` 流式返回（浏览器直接 `new Audio(URL.createObjectURL(await r.blob()))` 播）；
- **按文本缓存**：同一句第二次起近零延迟；text 上限 500 字，format 目前仅 mp3。

### `POST /v1/tts/prewarm` —— 台词表批量预热

```bash
curl -X POST https://voice-api.hahaxiong.cc/v1/tts/prewarm \
  -H "Authorization: Bearer jv_你的key" -H "Content-Type: application/json" \
  -d '{"texts":["开机欢迎语","夜航报告开场","开箱播报"]}'
# → {"accepted":3,"already_cached":0}  后台逐条预合成,完成后首次播放也是缓存速度
```

设备空闲时把 100+ 条台词推一遍（单次上限 200 条），"一天只播一次"的台词首次也快。

## 3. 大脑端点要求（provider=brain）

- 标准 OpenAI `POST {base_url}/chat/completions`，`stream=true` SSE 流式返回；
- 我们透传 user/assistant 消息历史，**首句尽量短**（首句出来就开始合成播报，首句长=开口慢）；
- 回复是给"念"的：口语化、别输出 markdown/代码块/舞台指示 `(笑)`。

## 4. 注意事项

- **闭麦=真正释放麦克风**（2026-07-31 起）：`setMicEnabled(false)` 会停掉采集轨并释放麦克风设备——常连房间下你的浏览器唤醒词识别可正常拿麦。代价是重新开麦时会重新获取设备（约 +100ms，已授权域无弹窗）。
- 页面必须 **HTTPS**（或 localhost）才能开麦克风。
- `apiKey` 在前端可见即可（demo 级设计）；泄露了找我们换发。
- 凭据写入接口返回 `422` = 校验失败，响应里有具体原因（哪个 key 错/端点不通）。
- 隐私说明：通话音频经我们的香港服务器实时处理，不留存录音；你的凭据加密存储在该服务器上（管理员技术上可及——介意勿用生产 key，demo 用子账号 key）。
