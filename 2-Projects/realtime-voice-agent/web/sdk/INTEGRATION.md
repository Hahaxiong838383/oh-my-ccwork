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
    const session = await JavisVoice.connect({ apiKey: "jv_你的key" });

    session.on("transcript", ({ role, text, final }) => {
      // role: "user"(你说的) | "agent"(AI 说的);final=false 是打字机中间态
      console.log(role, text, final);
    });
    session.on("state", (s) => console.log("state:", s));      // connected/reconnecting/disconnected
    session.on("metrics", (m) => console.log("延迟:", m));      // {stt_ms,eou_ms,ttft_ms,ttfb_ms}

    // session.setMicEnabled(false);  // 静音
    // await session.close();          // 挂断
    window.session = session;
  }
</script>
<button onclick="startVoice()">开始对话</button>
```

就这些。连接后：对着麦克风说话 → 你的大脑回答 → 讯飞音色播出，随时插话可打断。

## 3. 大脑端点要求（provider=brain）

- 标准 OpenAI `POST {base_url}/chat/completions`，`stream=true` SSE 流式返回；
- 我们透传 user/assistant 消息历史，**首句尽量短**（首句出来就开始合成播报，首句长=开口慢）；
- 回复是给"念"的：口语化、别输出 markdown/代码块/舞台指示 `(笑)`。

## 4. 注意事项

- 页面必须 **HTTPS**（或 localhost）才能开麦克风。
- `apiKey` 在前端可见即可（demo 级设计）；泄露了找我们换发。
- 凭据写入接口返回 `422` = 校验失败，响应里有具体原因（哪个 key 错/端点不通）。
- 隐私说明：通话音频经我们的香港服务器实时处理，不留存录音；你的凭据加密存储在该服务器上（管理员技术上可及——介意勿用生产 key，demo 用子账号 key）。
