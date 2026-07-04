# 协作约束 · 个人站展示层 session 必读

> 起草：main 分支 cc 主线（KidsHub-AI 开发主线）｜2026-06-14
> 对象：负责把 KidsHub-AI 同步到个人站（本仓 `2-Projects/chenchuan-site/`）做展示/微调的 session
> 背景：KidsHub 核心（`2-Projects/P003GameDemo20260513/`）与个人站是 mycc monorepo 下两个不同目录、不同技术栈（vite SPA vs 本仓 Next.js）。为避免多 session 同工作区 race（已发生过一次），立此单向协作铁律。

---

## 基线事实（已验证，放心用）

main HEAD `685786db1`（webp 全量迁移，24MB→2.3MB 省 90%）已通过 main 主线 E2E 验证：

- 43 个素材全 HTTP 200、content-type 正确
- 代码零残留 `.png` 引用（引用改全）
- 无破图、无失败请求
- 二维码 `wechat-qr.png` 正确保留 PNG（未误转有损 webp）
- 引导图标 / 大场景 webp 边缘无振铃、渲染无损

→ 你从此 commit 切分支 / `merge main` 即可，KidsHub 素材基线干净。

---

## 🔴 硬红线（违反任一 = 立即停手，报告川哥）

1. **【目录墙】** 只准动 `2-Projects/chenchuan-site/`。
   ❌ 禁止修改 `2-Projects/P003GameDemo20260513/` 任何文件（KidsHub 核心 = main 主线地盘）。
2. **【禁全量 add】** 绝不 `git add -A` / `git add .` / `git commit -a`。
   main 工作区现混着别的 session 的改动（cc-monitor / multica / scheduler / 0-System），全量 add 会打包别人半成品。只准 `git add 2-Projects/chenchuan-site/<具体路径>`。
3. **【0-System 禁区】** 禁止碰 `0-System/`（RECENT_EVENTS / task-log / memory-items）——全局单源 + 正在等收尾，不是你的。
4. **【部署墙】** 禁止部署 / rsync 公司站 `kidshub-ai.hahaxiong.cc`（`/opt/p003/web/dist`）——那是 main 主线的部署目标。你只部署个人站自己的目标。
5. **【不替别人 push】** main 现在 ahead 1（`685786db1` 未 push），由主线决定何时 push。你只 push 你自己的 personal-site 分支。

---

## ✅ 工作流

- **A.** 在你自己的 worktree + 独立分支干活（从 main HEAD 切，自动带上 `685786db1` webp）。别在 main 工作区直接改文件。
- **B.** 同步 KidsHub 新成果 = 在你的分支 `git merge main`（单向）。你的个人站微调留在你分支，**不回流 main**。
- **C.** 需要改 KidsHub 核心组件 / 逻辑？→ **不要自己动手**，写成需求提给 main 主线，主线改完你再 merge。保持单向数据流：`main(核心) → 你的分支(展示)`。
- **D.** commit message 限定个人站 scope，例：`feat(chenchuan-site): 嵌入 KidsHub demo 卡片`。

---

## 🤝 共享资源协调（worktree 隔离不了这些）

- **dev 端口**：`5173 / 5174 / 5175 / 4173` 是 main 主线（P003 vite）在用，你另选端口。
- **gpt-image-2 网关**：要出图先吭一声（429 并发限制，避免和主线撞）。

---

## 开工前先和川哥确认 1 件事

**个人站到底怎么"展示"KidsHub？**

- **(a) iframe 嵌公司站 URL**（`kidshub-ai.hahaxiong.cc`）→ 最解耦，**强烈推荐**，你几乎不碰 P003，且两边技术栈不同（Next.js vs vite）天然适合 iframe
- **(b) import P003 组件 / 复制 build 产物** → 耦合，同步要立规矩

定了 (a) 还是 (b) 再动手——这决定你和主线会不会撞。
