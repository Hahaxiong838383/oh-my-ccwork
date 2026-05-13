# apps/server · K1 demo 后端

> 实时语音中转 + 业务接口。详见 [`docs/07-v04-implementation-plan.md`](../../docs/07-v04-implementation-plan.md)。

## 凭据管理（铁律）

**永远不在源码里写明文凭据**。所有 API Key / Secret / Token 一律走 `.env.local`。

### 流程

1. 复制 `.env.example` → `.env.local`
2. 在 `.env.local` 填入实际凭据
3. `chmod 600 .env.local`（owner-only）
4. `.env.local` 已被根目录 `.gitignore` 第 24 行忽略，**永远不会进 git**

### 验证

```bash
# 确认 git 忽略
git check-ignore -v apps/server/.env.local

# 应输出：.gitignore:24:.env.local <path>
```

如果凭据曾不小心写进源码并被 commit：
1. `git rm --cached <file>` 把文件从索引移除
2. 立即去对应平台**重新生成新凭据**（旧的视为已泄露）
3. 用 `git filter-branch` 或 BFG 清理历史

## 当前已配置的服务

`.env.example` 列出所有支持的供应商：

| 供应商 | 用途 | 凭据键 |
|---|---|---|
| 火山引擎（**主线**） | ASR + LLM + TTS | `VOLC_*` / `DOUBAO_*` |
| 讯飞超拟人 | TTS 备选 | `XFYUN_*` |
| MiniMax | 全套备选 | `MINIMAX_*` |
| Gemini Live | 海外实验线 | `GEMINI_*` |

## 诊断脚本

### 讯飞 TTS 连通性测试

```bash
pnpm install
pnpm probe:xfyun
# 或自定义文本：
node --env-file=.env.local scripts/xfyun-tts-probe.mjs "你好世界"
```

输出：
- 终端：连接耗时 / TTFB / 总耗时 / 字节数 / 错误码
- 文件：`/tmp/xfyun_probe_<ts>.mp3`（成功时落盘试听）

**常见错误码**：
- `11200 LiccCheck failed`：APPID 未授权该接口/音色 → 去[讯飞控制台](https://console.xfyun.cn)开通"超拟人合成"服务并领取目标音色
- `10163 vcn must be one of [...]`：音色名拼写错误，看返回的合法列表
- `10005 Engine not exist`：接口路径错误

## D1 开发计划

待启动（详见 [`docs/07-v04-implementation-plan.md`](../../docs/07-v04-implementation-plan.md) §四 D1）：
- `src/index.ts` Bun + Hono 入口
- `src/ws-voice.ts` WebSocket 语音中转
- `src/providers/` 三大供应商客户端
- `src/pipeline.ts` 管线协调器（含打断）
