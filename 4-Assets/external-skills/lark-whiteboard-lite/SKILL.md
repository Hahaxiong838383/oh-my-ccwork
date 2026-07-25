---
name: lark-whiteboard-lite
description: >
  在飞书文档画板中绘制流程图、思维导图、时序图、系统框图、UI 原型图、对比表。
  防呆流水线版：查表选模板 → 复制模板改文字 → 渲染 PNG → 跑机械校验 → 上传飞书。
  任何能执行 shell 命令的 AI Agent 均可使用，不要求视觉能力。
compatibility: Node.js 18+, Python 3.8+, lark-cli 已登录
---

# 飞书画板绘图（防呆版）

> 你的任务：把用户要的图变成飞书画板。**你不需要发挥创造力，只需要严格执行下面的流水线。**
> 模板已经把布局、配色、字号、间距全部做对了。你只做一件事：**把模板里的示例文字换成用户的内容**。

---

## 十条铁律（先读完再动手，违反任何一条 = 任务失败）

1. **NEVER 手写或手算 x/y 坐标。** 只允许：Mermaid（引擎自动布局）或本包 JSON 模板（Flex 自动排版）。模板里没有 x/y，你也永远不要加。
2. **NEVER 从零写 JSON。** 必须 `cp` 模板文件再修改。没有例外。
3. **NEVER 发明字段名。** 只能使用附录 A 白名单里的字段。`fontsize`、`color`、`bgColor`、`fill` 等都是错的。
4. **NEVER 自创颜色。** 用户没指定颜色时，只能用附录 B 色板里的色值（模板已预填，不动它就是对的）。
5. **connector（连线）只能放在顶层 `nodes` 数组里**，NEVER 放进任何 frame 的 `children` 里。
6. **含文字的节点，`height` 一律写 `"fit-content"`**，NEVER 写数字（会截断文字）。无文字的占位块（如图片占位灰块）才允许数字高度。
7. **每个 frame 必须同时有 `layout`、`gap`、`padding` 三个字段**，且 `layout` 为 `"horizontal"` 或 `"vertical"` 的 frame 的 children 里 NEVER 出现 x/y（会被引擎忽略，等于白写）。
8. **渲染成功 + `validate.py` 输出 `RESULT: PASS` 才算图做完。** FAIL 就按输出里的修法逐条修，最多修 3 轮；3 轮后仍 FAIL → 放弃 JSON 路径，改用 `templates/flowchart.mmd`（Mermaid）重做。
9. **NEVER 不经 `--dry-run` 就向一个已存在的画板 token 写入**（会摧毁用户原有的图，不可恢复）。
10. **NEVER 对含有 `<whiteboard token="...">` 的飞书文档使用 `--mode overwrite` 写正文**（画板引用会被静默丢弃）。改正文只用 `insert_before` / `insert_after`。

---

## STEP 0 · 环境自检（每次会话第一次画图前跑一遍）

依次执行，任何一条不符合期望 → **停止，把失败的命令和输出原样报告给用户**，不要自己猜着修环境。

```bash
node -v
```
期望：输出 `v18` 或更高版本号。

```bash
npx -y @larksuite/whiteboard-cli@^0.1.0 --version
```
期望：输出版本号（如 `0.1.x`）。首次运行会自动下载，属正常。

```bash
lark-cli auth status --verify
```
期望：输出包含有效的用户/token 状态。报 `keychain entry not found` 或 token 过期 → 停止并告知用户「lark-cli 未登录，请先完成 lark-cli auth login」。
（只画本地 PNG 不上传飞书时，这条失败可以继续，前两条必须通过。）

---

## STEP 1 · 选路径（查表，禁止自由发挥）

按用户的需求在下表**从上到下**找第一个匹配行。找不到就用最后一行兜底。

| 用户要画的是 | 用哪个模板 | 格式 |
|---|---|---|
| 流程图 / 步骤图 / 审批流 / 业务流程 | `templates/flowchart.mmd` | Mermaid |
| 思维导图 / 脑图 / 大纲图 / 知识结构 | `templates/mindmap.mmd` | Mermaid |
| 时序图 / 调用顺序 / 交互序列 | `templates/sequence.mmd` | Mermaid |
| 状态机 / 状态流转 | `templates/state.mmd` | Mermaid |
| 系统框图 / 架构图 / 技术方案图 / 分层图 | `templates/system-arch.json` | DSL JSON |
| 原型图 / 线框图 / APP 页面 / UI 草图 | `templates/prototype.json` | DSL JSON |
| 对比表 / 功能矩阵 / 方案对比 / 卡片墙 | `templates/grid-cards.json` | DSL JSON |
| **上表没有的一切图型**（拓扑、鱼骨、甘特、饼图…） | `templates/flowchart.mmd` 改造，或如实告诉用户「该图型建议用 Mermaid 流程图近似表达」 | Mermaid |

第一步永远是建工作目录并复制模板（skill 包目录可能是只读的，NEVER 在包目录里写文件；`<SKILL_DIR>` = 本包绝对路径，安装者会告知）：

```bash
mkdir -p ~/wb-out && cp <SKILL_DIR>/templates/system-arch.json ~/wb-out/my-diagram.json
```

`<SKILL_DIR>/out/` 下有每个模板的渲染效果图（`system-arch.png` 等），具备图像能力时可先看一眼确认选型。

---

## STEP 2 · 填模板

### 2A. Mermaid 模板怎么填（.mmd 文件）

打开复制出来的 `.mmd` 文件，模板里以 `%%` 开头的行是注释教学，改完后**保留或删除均可**。规则：

- **节点文字 ≤ 12 个字**。超长就缩写，细节放到连线标签或省略。
- 流程图步骤总数 ≤ 12 个。更多 → 合并同类步骤。
- 节点形状固定语义：开始/结束 `A([文字])`、判断 `B{文字}`、普通步骤 `C[文字]`。
- 判断分支必须带标签：`B -->|是| C` 和 `B -->|否| D`。
- 文字里含括号或特殊符号时用双引号包裹：`A["支付(微信)"]`。
- 流程窄而长用 `flowchart TD`（上到下），步骤多但层级浅用 `flowchart LR`（左到右）。
- 思维导图：一个 `root((中心主题))`，分支靠缩进表达层级，3 层为宜，每层分支 ≤ 6 个。

### 2B. JSON 模板怎么填（DSL 文件）

**你只被允许做以下 4 种修改，其余一律不动：**

| 操作 | 怎么做 |
|---|---|
| ① 改文字 | 只改 `"text"` 字段的值。含 `\n` 表示换行（如 `"用户服务\n注册登录鉴权"`）。JSON 里双引号写 `\"`。 |
| ② 加同类节点 | **整段复制**一个同级的兄弟对象（从 `{` 到 `}`，含逗号规则），粘贴在它旁边，然后只改 `text` 和 `id`。 |
| ③ 删节点 | 整段删除一个对象（连同分隔逗号）。若它的 `id` 被某条 connector 的 `from`/`to` 引用，把那条 connector 也删掉。 |
| ④ 换整套配色 | 按附录 B 的色板表，把模板中出现的某组颜色**全局替换**为另一组（fillColor 和 borderColor 必须配对换）。 |

**id 规则**：小写字母 + 数字 + 连字符（如 `n-2-3`、`screen-b`），**全文件唯一**。复制节点后忘改 id 是最常见错误，validate.py 会抓。

**加一层 / 加一屏怎么做**（操作②的放大版）：
- `system-arch.json` 加一层：整段复制一个 `row-layer-N` 对象（约 30 行，从 `"type": "frame", "id": "row-layer-2"` 那个 `{` 复制到配对的 `}`），改层标签文字、内部节点文字、所有 id 后缀。
- `prototype.json` 加一屏：整段复制一个 `screen-x` 对象，改屏名、内部文字、所有 id 后缀。

**节点数量约束**（超出会挤爆布局）：
- 架构图每层 3~6 个节点；一行超过 6 个 → 复制模板里的「行 frame」拆成两行。
- 数据层的 `cylinder`（圆柱）宽度必须是 120~200 的固定数字，NEVER 写 `"fill-container"`。
- 每屏原型图内容块 ≤ 8 个。

**连线（connector）约束**：
- 全图连线 ≤ 8 条。架构图分层结构本身已表达「上层调用下层」，**非必要不画连线**，最多 3~5 条关键路径。
- 新连线照抄 `templates/prototype.json` 顶层 nodes 数组末尾那个现成的 connector 对象，只改 `from`/`to`（填目标节点的 id）和 `label`。
- `lineShape` 默认用 `"polyline"`；`fromAnchor`/`toAnchor` 可以省略（引擎自动找路）。
- 连线颜色永远保持模板的灰色 `#BBBFC4`，NEVER 改成彩色。

---

## STEP 3 · 渲染 + 机械校验（成功判据黑白分明）

```bash
python3 <SKILL_DIR>/validate.py ~/wb-out/my-diagram.json
```
**看最后一行**：
- `RESULT: PASS` → 继续渲染。
- `RESULT: FAIL` → 上方每条 `[FAIL]` 都自带修法，逐条修完重跑。**最多 3 轮**，仍 FAIL → 铁律 8 降级 Mermaid。

```bash
npx -y @larksuite/whiteboard-cli@^0.1.0 -i ~/wb-out/my-diagram.json -o ~/wb-out/my-diagram.png
```
（Mermaid 同理：`-i ~/wb-out/my-diagram.mmd -o ~/wb-out/my-diagram.png`。.mmd 也可以先跑 `python3 <SKILL_DIR>/validate.py ~/wb-out/my-diagram.mmd` 做轻量检查。）

**成功判据**：命令退出码 0，且 `~/wb-out/my-diagram.png` 文件存在且大小 > 10KB。渲染报错 → 查附录 C 对照表。

**（可选）视觉复查**：如果你具备图像输入能力，查看 PNG 并对照附录 D 症状表修一轮。没有图像能力就跳过——validate.py 已覆盖主要问题。

**交付判据**：用户没要求上传飞书 → 把 PNG 文件路径给用户，任务结束。要求上传 → 进 STEP 4。

---

## STEP 4 · 上传飞书画板（仅当用户要求上传时）

### 4.1 拿到画板 token（三种情况查表）

| 用户给了什么 | 怎么拿 token |
|---|---|
| 直接给了画板 token | 直接用 |
| 给了文档 URL/doc_id，文档里**已有**要更新的画板 | `lark-cli docs +fetch --doc <DOC_TOKEN> --as user`，在输出里找 `<whiteboard token="XXX"/>`，XXX 即是 |
| 给了文档 URL/doc_id，需要**新建**画板 | 执行下面的「新建画板」命令，从响应 `data.board_tokens[0]` 取 token |

新建画板（在文档末尾追加一个空白画板）：
```bash
lark-cli docs +update --doc <DOC_TOKEN> --mode append --markdown '<whiteboard type="blank"></whiteboard>' --as user
```

### 4.2 新建的空白画板 → 直接上传

```bash
npx -y @larksuite/whiteboard-cli@^0.1.0 --to openapi -i ~/wb-out/my-diagram.json --format json | lark-cli docs +whiteboard-update --whiteboard-token <BOARD_TOKEN> --source - --yes --as user
```

⚠️ `--source -` 三个字符**必须存在**（`-` = 从管道读入）。少了它必报 `required flag(s) "source" not set`。
（Mermaid 文件的上传：把 `--to openapi -i ~/wb-out/my-diagram.json --format json` 换成 `-i ~/wb-out/my-diagram.mmd --to openapi --format json`，其余不变。）

### 4.3 已存在的画板 → 必须先 dry-run（铁律 9）

**第一条命令（探测，绝不能跳过）：**
```bash
npx -y @larksuite/whiteboard-cli@^0.1.0 --to openapi -i ~/wb-out/my-diagram.json --format json | lark-cli docs +whiteboard-update --whiteboard-token <BOARD_TOKEN> --source - --overwrite --dry-run --as user
```

**读输出做二选一：**
- 输出包含 `will be deleted`（如 `12 whiteboard nodes will be deleted`）→ 画板非空。**停下**，问用户：「目标画板已有 N 个节点，继续将清空原图且不可恢复，确认覆盖吗？」得到明确同意后才执行第二条。
- 没有该字样 → 画板是空的，直接执行第二条。

**第二条命令（真正写入，比第一条只少 `--dry-run`）：**
```bash
npx -y @larksuite/whiteboard-cli@^0.1.0 --to openapi -i ~/wb-out/my-diagram.json --format json | lark-cli docs +whiteboard-update --whiteboard-token <BOARD_TOKEN> --source - --overwrite --yes --as user
```

### 4.4 上传后验证 + 收尾

- 把画板所在的文档链接发给用户，说明「画板已写入」。
- 注意预期管理：飞书画板**没有增量修改接口**——以后要改这张图 = 用新 JSON 整张重传（覆盖）。用户在 UI 里手工调整过的布局会在重传时丢失。
- 若还需要在同一文档里写说明文字：只用 `--mode insert_before` / `insert_after` + `--selection-by-title "## 某标题"` 插入，**禁止 overwrite**（铁律 10）。

---

## 附录 A · DSL 字段白名单（不在表里的字段 = 禁止使用）

**文档骨架**：`{"version": 2, "nodes": [ ... ]}`　— version 恒为数字 2。

| 节点 type | 允许的字段 |
|---|---|
| `frame` | id, x, y, width, height, layout, gap, padding, justifyContent, alignItems, fillColor, borderColor, borderWidth, borderDash, borderRadius, children |
| `rect` / `ellipse` / `diamond` | id, x, y, width, height, fillColor, borderColor, borderWidth, borderDash, borderRadius, text, fontSize, textColor, textAlign, verticalAlign |
| `cylinder` | 同 rect（宽度必须 120~200 数字） |
| `text` | id, x, y, width, height, text, fontSize, textColor, textAlign, verticalAlign |
| `stickyNote` | id, x, y, width, height, fillColor(仅限 9 个便签色), text, fontSize, textColor, textAlign, verticalAlign |
| `connector` | id, connector（子对象，见下） |

`connector` 子对象字段：`from`, `to`（节点 id 字符串）, `fromAnchor`, `toAnchor`（top/right/bottom/left）, `lineShape`（polyline/straight/curve/rightAngle）, `lineColor`, `lineWidth`, `lineStyle`（solid/dashed/dotted）, `startArrow`, `endArrow`（none/arrow/triangle/circle/diamond）, `label`, `labelPosition`。

**取值规则速查**：
- `width`/`height`：数字（像素）或 `"fit-content"` 或 `"fill-container"`。
- `"fill-container"` 只在 flex 父容器里生效，且祖先链上必须有一个固定数字尺寸。
- `layout`：只有 `"horizontal"` / `"vertical"` / `"none"` 三个值。本包禁用 `"none"`（那是手算坐标的路）。
- `padding`：数字，或 `[上下, 左右]`，或 `[上, 右, 下, 左]`。
- `textAlign`：left/center/right；`verticalAlign`：top/middle/bottom。
- 富文本：`text` 可以是数组 `[{"content":"标题\n","bold":true,"fontSize":16},{"content":"正文","fontSize":13}]`——仅在需要一节点内混排粗细字号时使用。

## 附录 B · 色板（经典款；换色板 = 整组替换）

| 分组角色 | fillColor（容器浅底） | borderColor（边框/深色） |
|---|---|---|
| 第 1 组 · 蓝 | `#F0F4FC` | `#5178C6` |
| 第 2 组 · 紫 | `#EAE2FE` | `#8569CB` |
| 第 3 组 · 绿 | `#DFF5E5` | `#509863` |
| 第 4 组 · 黄 | `#FEF1CE` | `#D4B45B` |
| 第 5 组 · 红 | `#FEE3E2` | `#D25D5A` |

**用法公式（模板已按此做好）**：
- 分组容器（层背景）= 该组浅底 fillColor + 该组深色 borderColor。
- 组内具体节点 = 白色 `#FFFFFF` 填充 + **所属组的深色**做 borderColor。同组节点样式必须完全一致。
- 强调/表头 = `#1F2329` 深底 + 白字 `#FFFFFF`。
- 文字色只有三档：正文 `#1F2329`、辅助说明 `#646A73`、深底上白字 `#FFFFFF`。
- 连线永远 `#BBBFC4` 灰。
- 统一参数：`borderWidth: 2`，`borderRadius: 8`，正文 `fontSize: 14`，标题 24，辅助 13。
- stickyNote 便签只能用这 9 色：`#FEF1CE #F5D1A7 #DFF5E5 #CDF7CC #C9E8EF #D6DCF3 #D3CCEE #F1C5E7 #F6C8C8`。

## 附录 C · 渲染/上传报错对照表

| 报错关键词 | 原因 | 修法 |
|---|---|---|
| `Unexpected token` / JSON parse | JSON 语法坏了（多逗号/少括号/引号没转义） | 跑 `python3 -m json.tool 文件` 定位行号修复 |
| Schema 校验错 / unknown property | 用了白名单外的字段 | 对照附录 A 删掉或改名 |
| `required flag(s) "source" not set` | 上传命令少了 `--source -` | 补上 |
| `whiteboard nodes will be deleted` | 不是错误，是 dry-run 告警 | 按 STEP 4.3 询问用户 |
| token 找不到 / 404 | 画板 token 错误，或那是「字面 mermaid 文本」不是真画板 | 重新 `docs +fetch` 确认存在 `<whiteboard token="...">` |
| `keychain entry not found` / 401 | lark-cli 未登录或 token 过期 | 停止，报告用户去登录 |
| 渲染成功但 PNG 极小（<10KB） | 内容为空或全部节点尺寸塌陷为 0 | 检查根 frame 是否有固定数字 width |

## 附录 D · 症状 → 修复表（可选，仅具备图像输入能力时用）

| 看到的问题 | 改什么 |
|---|---|
| 文字被截断 | 该节点 height 改 `"fit-content"` |
| 文字溢出容器右侧 | 增大该节点 width，或缩短文字 |
| 节点挤成一团 / 粘连 | 增大父 frame 的 gap（≥12）和 padding（≥16） |
| 连线穿过节点 | 增大节点间距（有连线时 gap ≥ 40），或删掉该连线 |
| 大面积空白 | 缩小根 frame 宽度（如 1200 → 1000） |
| 分不清哪些节点是一组 | 按附录 B 公式重新上色：同组同色，容器浅底、节点白底同组边框 |
