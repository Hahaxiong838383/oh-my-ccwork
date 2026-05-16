# P003 K1 Game Demo

> 儿童陪伴机器人 K1 web 模拟器 · 800×480 像素锁定 · 4.5 天交付

## 进展速览（2026-05-16 · D4 美术化全线完工）

**版本 V0.8 · 真机端到端跑通 + 全场景美术化 + 视频升级演示**

| 完成度 | 内容 |
|---|---|
| ✅ D1 V0.4 | 框架 + 9 组件 + 凭据探针（[D1-log](docs/D1-log.md)） |
| ✅ D2 V0.6 | 整体竖屏 + 三段闭环（ASR + LLM + TTS）+ 真机通（[D2-log](docs/D2-log.md)） |
| ✅ D3 V0.7 | OpenBox 4 级 + EcoUnlock + Farewell + 4 大调试链修复（[D3-log](docs/D3-log.md)） |
| ✅ D3.5 | 配网美术化 + 视频过渡 + Welcome 写实图（C 档动效）+ TTS sayDirect 通道（[D3.5-log](docs/D3.5-log.md)） |
| ✅ **D4** | **focusRunning/Companion 美术化 10 stage + 静思 4 图 + 出航 7 图 + 宝箱 4 PNG + 生态缸 4 mp4 升级演示**（[D4-art-final-summary](docs/D4-art-final-summary.md)） |
| ⏳ D4 后续 | 出航视觉链路修复（按"出航1-7"统一命名 + 修 04/05 伪旋转穿帮）+ Welcome 字幕技术债 + 真机演练 |
| ⏳ D5 | buffer：性能优化 + 真机 60fps 验证 + mkcert 真证书替换 |

**当前可演**（13 个 commit 落地）：手机访问 `https://<LAN-IP>:5173/` → 完成配网 →
全 11 个 scene（welcome / nightReport / askMode / focusRunning 出航 / focusCompanion 静思 /
boxCommon/Rare/Epic/Legendary 4 PNG / ecoUnlock 4 mp4 升级 / farewell）+ DebugBar 调试控件
（跳关 / 速度滑块 / 进度起点 / 一键满进度 / 演示出航过渡 / 演示静思过渡 / 生态缸 4 等级切换）。

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
| [`D3.5-log.md`](docs/D3.5-log.md) | D3.5：美术化 + Welcome 写实图 + TTS sayDirect + 5 大踩坑 |
| [`D4-focus-art-decisions.md`](docs/D4-focus-art-decisions.md) | **D4 决策记录档（P0~P9.7 完整 Phase 拆分 + 回滚锚点）** |
| [`D4-art-final-summary.md`](docs/D4-art-final-summary.md) | **D4 最终总结（commit 时间线 + 能力增量 + 踩坑沉淀 + 后续 todo）** |
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
3. ✅ 4.5 天交付（D1+D2+D3+D3.5+D4 已完成，D5 收尾）
4. ✅ demo 第一原则，砍 9 层 / XState / MSW / Dexie，纯 CSS + cqw/cqh
5. ✅ **D4 新增**：全场景美术化（12 PNG + 4 MP4）+ focusRunning/Companion 完整链路（launching → 4 stage → reward 交接）

详见 [`docs/DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md)。

## 验收脚本（playwright + chrome）

```bash
# 完整 7 段 E2E（含 11 场景跳关 + 11 键盘 + C2 状态机 + C4 box×4 + farewell + voice）
node apps/web/scripts/e2e-flow-test.mjs

# mini test：P4 reward 自动交接链路
node apps/web/scripts/p4-reward-handoff-test.mjs

# mini test：P5 字幕在 3 场景显示
node apps/web/scripts/p5-subtitle-test.mjs

# mini test：P9 生态缸 4 等级 mp4 切换
node apps/web/scripts/p9-eco-levels-test.mjs
```

所有截图归档到 `.scratch/{e2e,p4,p5,p9}-screenshots/`。
