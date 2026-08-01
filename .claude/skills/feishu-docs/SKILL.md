---
name: feishu-docs
description: 查飞书开放平台开发文档（卡片 JSON、服务端 API、组件属性、字段枚举）。文档站是 SPA，WebFetch 只能拿到导航壳、正文全空，必须走浏览器工具；URL 不可猜，要从页面里抓真实链接。触发词："飞书文档"、"飞书卡片 JSON"、"open.feishu.cn/document"、"飞书组件属性"、"飞书 API 字段"、"卡片 2.0"
layer: 工具层
authorization: A区（只读浏览，无副作用）
output_levels: L1
---

# 查飞书开放平台文档

## 🔴 先看这条：WebFetch 拿不到正文

`open.feishu.cn/document/**` 是 **SPA**，正文由 JS 渲染。`WebFetch` 拿回来的
只有导航壳（「客户案例 / 应用中心 / 开发文档 …」）和一句「无法获取具体信息」，
**看起来像页面没内容，其实是没渲染**。

2026-08-01 实测：查卡片是否有「一键复制」组件，WebFetch 两次都只拿到壳，
差点据此答「飞书没有这个能力」——那会是个凭空捏造的结论。

**正确做法：用浏览器工具。**

## 标准流程

```
1. preview_start { url: "https://open.feishu.cn/document/<path>" }
2. get_page_text { max_chars: 6000 }        # 拿正文，够看结构和字段表
3. 需要跳别的页 → 见下方「URL 不可猜」
```

`get_page_text` 对这个站效果很好：字段表、JSON 示例、1.0/2.0 对照表都能拿到
纯文本。**不需要 read_page / screenshot**，那些更贵且没必要。

## 🔴 URL 不可猜——猜了就是 404

文档路径不是语义化的，形如：

```
/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text
             ↑ 这两段是不可推导的固定 token
```

我猜过 `/document/feishu-cards/card-json-v2-components/overview` → **文档不存在**。

**正确做法：从当前页面抓真实链接。** 随便打开一个同区文档页，然后：

```js
// javascript_tool
(() => {
  const links = [...document.querySelectorAll('a')]
    .map(a => ({ t: (a.textContent||'').trim(), h: a.getAttribute('href')||'' }))
    .filter(x => x.h.includes('<关键词>'));       // 如 'card-json-v2-components'
  const seen = new Set(); const out = [];
  for (const l of links) { const k = l.h.split('/').pop(); if (seen.has(k)) continue; seen.add(k); out.push(l.t + ' → ' + l.h); }
  return { count: out.length, items: out };
})()
```

左侧导航是全量渲染的，所以一页就能抓到整个分区的目录。

## 已验证的入口（2026-08-01）

| 要查什么 | 入口 |
|---|---|
| 卡片 2.0 结构变更 | `/document/feishu-cards/card-json-v2-breaking-changes-release-notes` |
| 卡片 2.0 组件 | 路径含 `card-json-v2-components/` |
| 卡片 1.0 组件 | 路径含 `card-components/` |

短路径（不带 `uAjLw4CM/ukzMukzMukzM`）**有些能直接打开**，有些不行——打不开就
回到能打开的页面抓链接，别在 URL 上反复试。

## lark-cli 内置文档：只有 API 域，没有卡片

`lark-cli skills list` / `skills read <name>` 给的是**功能域使用指南**
（lark-im / lark-calendar / lark-approval …），**不含卡片组件规格**。
查卡片只能走网页。查 API 参数/scope 则优先用 CLI，更快更准：

```bash
lark-cli schema <service>.<resource>.<method>    # 参数、类型、所需 scope、示例
lark-cli api ... --dry-run                       # 不执行，只看请求长什么样
```

## 结论要标证据等级

从文档里读到的写「已验证 · 官方文档 <URL>」；**没查到不等于不存在**——
飞书文档分区很散，说「飞书不支持 X」之前先确认自己查的是不是那个分区。
2026-08-01 关于「卡片有没有一键复制组件」的结论，是抓完 2.0 全部 13 个展示类
组件清单后才敢下的（结论：无原生复制组件，代码块只能靠富文本 markdown 渲染，
按钮只能跳链接或触发回调，摸不到剪贴板）。

## 卡片 2.0 实操坑（2026-08-01 真机）

### padding 多值必须写满四个值

```
"padding": "4px 8px"        ❌ → ErrMsg: invalid panel header padding
"padding": "4px 8px 4px 8px" ✅
"padding": "8px"             ✅ 单值也合法
```

文档字面写着「四个值必填，使用空格间隔」——**1.0 会静默忽略非法值，2.0 直接
报错**。迁 2.0 时任何写了两值/三值的 padding 都会炸。

### 报错信息给了精确路径，照着改就行

```json
"code": 230099,
"message": "ErrCode: 10002; ErrPath: ROOT -> body -> elements -> [2](tag: collapsible_panel); ErrMsg: invalid panel header padding"
```

`ErrPath` 直接定位到第几个 element、哪个 tag、哪个字段。**别猜别全量重写**，
按路径改那一处即可。

### 组件嵌套有硬约束，设计前先查

- **表格（table）不可内嵌在任何组件内**，只能放卡片根节点下；表格内也不能嵌组件。
  → 「表格塞进折叠面板」这种设计直接不成立，得改成表格在外、折叠面板放明细。
- 折叠面板不支持内嵌表单容器（form）。
- 容器最多嵌套五层。

### 客户端版本门槛不同，按最高的那个算

| 能力 | 最低客户端 |
|---|---|
| 卡片 JSON 2.0 | **7.20+**（低于此只显示标题 + 升级提示） |
| 折叠面板 | 7.9+ |

### 发送方式

```bash
lark-cli im +messages-send --as bot --user-id ou_xxx \
  --msg-type interactive --content "$(cat card.json)"
```

成功返回 `ok:true` + `message_id`。**API 通过 ≠ 渲染正常**——版本兼容、布局效果
只能真机看，要让用户确认。
