# SPEC — task-board 服务门户（Service Portal）

> 工单性质：给**另一台机器上的 cc** 冷启动执行。你没有原始对话上下文，本文档自包含。
> 执行方式（川哥指定）：**你用 team 模式经 omp 网关调 Codex 写代码，你自己做审核 + E2E 验收**。cc 只做规划/关键决策/验收，不亲手写实现。
> 出稿：cc（Claude）| 2026-07-01 | 在 Air 上写（Air 连不上 omp 网关，故转交）

---

## 0. 一句话目标

给现有本地项目 `task-board` 加一个「服务」标签页：川哥打开一个 `http://localhost:8788`，就能看到本机所有相关后台服务的**健康红绿灯**，并**一键跳转**到有网页界面的那几个。

需求原话：「所有跟我有关的后台服务，打开一个链接就能看到，然后可以自由跳转到具体的后台。」

方案已定，别再发散：**导航门户页**（不是 iframe 聚合、不是 nginx 反代挂子路径——那两条上游已否决，会撞 `X-Frame-Options` 和 SPA base-path 问题）。并入 task-board 做成同一个「驾驶舱」的第二个 tab。

---

## 1. 项目现状（动手前先读这几个文件）

`task-board` 是一个**零第三方依赖**的本地看板，Node 原生实现。关键文件：

| 文件 | 作用 |
|---|---|
| `server.mjs` | 零依赖 HTTP 服务：REST API + 静态托管，默认端口 **8788** |
| `index.html` | 单页看板，**纯原生 JS**（无 Vue/React），含拖拽/深色模式/3s 轮询 |
| `scripts/lib.mjs` | 读写/校验/迁移/生成 md 的共享核心 |
| `tasks.json` | 任务数据源（v2 多项目结构） |
| `scripts/sync-taskboard.mjs` | 命令行同步薄壳 |

**代码风格铁律（Codex 必须遵守）：**
- **零新增第三方依赖**。只允许 Node 内置模块（`http` / `fs` / `path` / `net` / `url`）。`package.json` 的 dependencies 保持为空。
- 前端保持**原生 JS + 单文件 index.html**，不引框架、不引 CDN。
- 复用现有 index.html 的**顶栏布局、CSS 变量、深色模式机制**（`[data-theme=dark]` + localStorage）。新 tab 要和现有视觉一致——**先读 index.html 现有实现再动手，不要另起一套样式**。
- 中文注释，和现有代码一致。
- 服务端写操作若涉及文件，沿用 lib.mjs 的**原子写**风格（先写 `.tmp` 再 rename）。

---

## 2. 要实现的功能（三块）

### 2.1 数据源：`services.json` + `GET /api/services`

新增一个和 `tasks.json` 平级的数据文件 `services.json`（结构见 §5）。`server.mjs` 提供 `GET /api/services` 读它返回。

**理由**：和 task-board「JSON 是数据源」的哲学一致——川哥以后加/删服务只改 `services.json`，不动代码。**禁止**把服务清单硬编码进 index.html。

### 2.2 健康检查：**必须走后端 TCP 探活**（本 spec 最关键的一条，别踩坑）

新增 `GET /api/health`：后端遍历 `services.json` 里每个 `port`，用 Node `net` 模块对 `127.0.0.1:<port>` 做 TCP 连接探测，连上=`up`，超时/`ECONNREFUSED`=`down`，探完立即 `socket.destroy()`。并发探测，单次超时 ~800ms，整体 1s 内返回。

响应示例：
```json
{ "checkedAt": "2026-07-01T...Z", "status": { "8788": "up", "18080": "up", "3197": "down" } }
```

前端每 10s 调一次 `/api/health` 刷新红绿灯（只在「服务」tab 激活时轮询，离开就停，省资源）。

> ⚠️ **为什么健康检查不能在前端直接 fetch 目标端口（这是最容易被写错的地方）：**
> - 前端页面在 `http://localhost:8788`，去 fetch `http://127.0.0.1:11434`（ollama）等**是跨源请求**。目标服务（ollama / xray / 多数后台）**不返回 CORS 头**，标准 `fetch` 会被浏览器拦截并 reject → 服务明明活着却被判成 down（红灯全亮，功能报废）。
> - 用 `fetch(url,{mode:'no-cors'})` 拿到的是 opaque response：`ok` 恒为 false、`status` 恒为 0，**无法区分活/死**；且浏览器对 localhost 的私有网络访问（PNA）限制在收紧，未来更不可靠。
> - Node 后端 `net.connect` 探本地 TCP **无 CORS、最准**。前端只请求同源的 `/api/health`，天然无跨源问题。
> **结论：健康检查一律后端做。Codex 若按「前端探端口」实现，验收直接打回。**

### 2.3 前端：顶栏加 tab + 服务卡片

- 顶栏加两个 tab：**「任务看板」/「服务」**，切换两个视图（复用现有顶栏与深色模式样式）。默认停留在「任务看板」，不改变现有默认体验。
- 「服务」视图：服务**卡片网格**，每张卡显示 `name` / 端口 / `desc` / **健康点**（up=绿、down=红、未探到=灰）。
- `hasUI:true` 的卡片给「打开 ↗」按钮：`window.open('http://localhost:'+port+(path||'/'), '_blank')`。
- `hasUI:false` 的卡片（纯代理/纯 API，无网页）：**置灰、不给跳转**，标注「无界面」——只显示健康状态。
- 进入「服务」tab 立即探一次；现有任务看板的 3s 轮询逻辑**不受影响、不回归**。

---

## 3. 验收标准（cc 你亲自 E2E，别只看 Codex 自述）

按 CLAUDE.md 双门 + 端到端铁律，**你自己在这台机器上真跑**：

- [ ] **Gate1 功能**
  1. `node server.mjs` 启动无报错。
  2. `curl -s localhost:8788/api/services` 返回服务清单 JSON。
  3. `curl -s localhost:8788/api/health` 返回各端口 up/down 映射，且与本机 `lsof -nP -iTCP -sTCP:LISTEN` 实际对得上（活着的服务=up，没起的=down）。
  4. 浏览器开 `localhost:8788`：tab 能切；服务卡片渲染正常；红绿灯颜色与实际一致；点 `hasUI` 服务能新标签打开；`hasUI:false` 的置灰不可跳。
- [ ] **Gate2 无回归**
  5. 现有任务看板：增/删/改/拖拽、3s 轮询、深色模式切换 —— 全部照常。
  6. `package.json` dependencies 仍为空；`server.mjs` 只 import 了 Node 内置模块。
- [ ] **收尾**：把本次改动同步进 task-board 的任务看板（新建任务→done，记录 files）。

Codex 若不达标，按 QUALITY-GATE 迭代 **≤3 轮**，超限升级给川哥。

---

## 4. 边界（不要做的事）

- 不引入**任何** npm 依赖 / CDN / 前端框架。
- 不改 `tasks.json` 结构、不动现有任务 API 与拖拽逻辑。
- 服务清单不硬编码进前端（必须走 `/api/services`）。
- 健康检查不在前端直接探目标端口（见 §2.2）。
- `services.json` 里的端口/服务**以执行机器实际为准**，可自行增删（§5 只是 Air 上 2026-07-01 的实测初值）。

---

## 5. `services.json` 初始内容（Air 实测端口，供参考，执行机自行核对增删）

> 端口为 2026-07-01 在 Air 上 `lsof` 实测【已验证】；`hasUI` 为推断【推断】，川哥/你可调整。
> 注：`cc-monitor` 是无端口的 menubar app、`python:18230`/`node:19825` 是两个未识别端口 —— 均**未纳入**初始清单，执行机确认后再决定是否加。

```json
{
  "services": [
    { "id": "task-board", "name": "任务看板",  "port": 8788,  "desc": "本看板(任务 + 服务门户)",        "hasUI": true,  "path": "/" },
    { "id": "mycc",       "name": "mycc 后端", "port": 18080, "desc": "飞书三通道 + 调度 + 记忆(API 为主)", "hasUI": true,  "path": "/" },
    { "id": "myjavis",    "name": "MyJavis",   "port": 3197,  "desc": "实时语音助手后端",                 "hasUI": true,  "path": "/" },
    { "id": "xray-mgr",   "name": "xray 面板", "port": 8888,  "desc": "代理管理器 com.xray.manager",      "hasUI": true,  "path": "/" },
    { "id": "xray-proxy", "name": "xray 出口", "port": 10808, "desc": "SOCKS/HTTP 代理,无网页",           "hasUI": false },
    { "id": "ollama",     "name": "Ollama",    "port": 11434, "desc": "本地 LLM API,无网页",              "hasUI": false }
  ]
}
```

---

## 6. 给执行 cc 的调用提示（omp 调 Codex）

按 `~/.claude/docs/engine-ops.md`：codex model=`gpt-5.5`，主网关 omp2（降级 omp3→omp1）。调用前 `source ~/.gateway.env`。

派 Codex 时 `--files` 至少带上：`server.mjs,index.html,scripts/lib.mjs`（让它读现有风格）。任务描述把本 spec 的 §1–§5 交给它。写完你按 §3 验收。
