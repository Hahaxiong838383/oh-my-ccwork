# P003 K1 Game Demo

> 儿童陪伴机器人 K1 web 模拟器 · 800×480 像素锁定 · 4.5 天交付

## 进展速览（2026-05-14 22:30 · D3.5 完工）

**版本 V0.7 · 真机端到端跑通 + 美术化首两幕**

| 完成度 | 内容 |
|---|---|
| ✅ D1 V0.4 | 框架 + 9 组件 + 凭据探针（[D1-log](docs/D1-log.md)） |
| ✅ D2 V0.6 | 整体竖屏 + 三段闭环（ASR + LLM + TTS）+ 真机通（[D2-log](docs/D2-log.md)） |
| ✅ D3 V0.7 | OpenBox 4 级 + EcoUnlock + Farewell + 4 大调试链修复（[D3-log](docs/D3-log.md)） |
| ✅ D3.5 | **配网美术化 + 视频过渡 + Welcome 写实图（C 档动效）+ TTS sayDirect 通道**（[D3.5-log](docs/D3.5-log.md)） |
| ⏳ D4 上 | 部署阿里云 VPS + HTTPS/WSS 反代 + iOS Safari 真机测 |
| ⏳ D4 下 | SettingsPanel + 录 90s demo 视频 |
| ⏳ D5 | buffer：兼容性修复 + Polish + 锦上添花 |

**当前可演**：手机访问 `https://192.168.1.193:5173/` → DebugBar 完成配网 → 视频过渡 → 写实 Welcome 场景（小可在飞船舷窗读书 + 星点漂移 + 表情屏绿光 + 真实 TTS"你好，指挥官！欢迎回到方舟"）→ NightReport → AskMode → focusRunning → OpenBox 4 级 → EcoUnlock → Farewell

## 技术栈

- **前端**：React 18 + Vite 5 + TypeScript strict + Tailwind + Zustand + framer-motion + CSS container query units (cqw/cqh)
- **后端**：Hono + Node `ws` + tsx + ESM
- **三段语音链路**：
  - **ASR**：火山大模型 sauc v3（`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`）
  - **LLM**：gemini-3.1-flash-lite-preview via 川哥代理 `http://23.226.135.149:4000/v1`（TTFT 0.80s，max_tokens 65535）
  - **TTS**：Doubao-TTS 2.0 双向流（音色 `zh_female_tianmeixiaoyuan_moon_bigtts` 甜美小源）
- **新增 TTS sayDirect 通道**：绕过 ASR+LLM 直接 `{ type:'tts.say', text }`，用于开机欢迎语等无 ASR 触发场景

## 文档导航

| 文档 | 作用 |
|---|---|
| [`DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md) | **目标锚定（必读）** —— 4 个绝对目标 + 范围裁剪表 |
| [`D1-log.md`](docs/D1-log.md) | D1 V0.1-V0.4：框架 + 9 组件 + 凭据探针 |
| [`D2-log.md`](docs/D2-log.md) | D2 V0.6：B+C 方案 + 整体竖屏 + 三段端到端 + 9 真机 bug 复盘 |
| [`D3-log.md`](docs/D3-log.md) | D3 V0.7：三场景 + 4 大调试链路 + 团队协作产出 |
| [`D3.5-log.md`](docs/D3.5-log.md) | **D3.5：美术化 + Welcome 写实图 + TTS sayDirect + 5 大踩坑** |
| [`TECH-DEBT.md`](docs/TECH-DEBT.md) | 技术债清单（demo→优化阶段路线图）|
| [`00-product-spec.md`](docs/00-product-spec.md) | 产品规格 + 术语表（V1.0 参考） |
| [`05-server-contracts.md`](docs/05-server-contracts.md) | C/S 接口契约（含新增 tts.say） |

## 启动

```bash
# 后端（apps/server）：HTTPS 端口 3001
cd apps/server && npm start

# 前端（apps/web）：HTTPS dev server 5173 + WSS vite proxy
cd apps/web && npm run dev

# 手机扫码：https://<本机 IP>:5173/
```

凭据放 `apps/server/.env.local`（chmod 600，gitignored）。

## 4 个绝对目标（达成情况）

1. ✅ 手机竖屏外壳 + 800×480 像素锁定 5:3 画布
2. ✅ 小可 AI 实时语音对话：端到端 ~2.4s（达标 ≤2.5s）
3. ✅ 4.5 天交付（D1+D2+D3+D3.5 已完成，D4-D5 收尾）
4. ✅ demo 第一原则，砍 9 层 / XState / MSW / Dexie，纯 CSS + cqw/cqh

详见 [`docs/DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md)。
