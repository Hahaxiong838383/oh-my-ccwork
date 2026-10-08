# Codex 搜索历史 502 兼容修复（2026-10-08）

## 结果与适用范围

CLIProxyAPI 8.0.12（2044a01f）上的条件补齐规则已通过生产 Smart API 验收。
当前规则只处理 `gpt-6*`、目标 `codex` 协议、来源 `responses` 的请求：
当输入历史有 `web_search_call`，但 `tools` 中缺少 `web_search*` 声明时，追加一个 `{"type":"web_search"}`。
不删除搜索历史，不覆盖现有工具，不修改 `tool_choice`、模型、推理级别或鉴权。
已有 `web_search` / `web_search_preview` 等声明时不追加；没有搜索历史时不触发。

配置模板：[config/codex-web-search-history.example.json](config/codex-web-search-history.example.json)。
这是 **CLIProxyAPI requests.payload 配置片段**，不是 Smart Router 的 router.json，也不是完整服务配置。
本次未升级二进制，未重启 CPA/Router。

## 证据与结论边界

服务器 Nginx、监听端口、CPA/Router 进程正常；502 日志显示上游 `internal_error` / `response protection is unavailable`。
当天所统计的 208 条错误均命中仍有效的 Pro 授权，不能归因为另一个账号降为 Free。

诊断脚本在内存中重建原会话上次压缩后的历史，并附加只输出测试标识、不执行原任务的请求。
这是历史回放，不是抓获的原始 App HTTP 请求：系统说明、工具声明等不完全等同于原客户端发包。
因此已证明的是以下触发条件及兼容补齐效果；尚未证明客户端在哪一层遗漏了声明，也未证明上游内部 protection 服务的实现原因。

| 诊断条件 | 结果 |
| --- | --- |
| Pro 上游短请求 | HTTP 200，response.completed |
| 原会话全部 359 条加密推理记录单独回放 | HTTP 200，158,055 input tokens，completed |
| 完整历史回放，未声明 web_search | 相同 502 |
| 仅移除加密推理记录，或仅移除图片 | 仍为相同 502 |
| 仅移除 17 条 web_search_call，保留其他历史 | HTTP 200，536,171 input tokens，completed |
| 单条旧 web_search_call，未声明工具 | 稳定复现相同 502 |
| 同一条旧记录，声明 tools=[{type:web_search}] | HTTP 200，completed |
| Header 限定规则，未由测试客户端补声明 | 单条及完整历史回放通过 |
| 已有声明 + Header 限定规则 | 通过，匹配条件排除重复补齐 |
| 正式规则，无测试 Header，完整 1,058 项历史 | HTTP 200，541,444 input / 8 output tokens，response.completed，CPA_RECOVERY_OK，12.91 秒 |

不要删除用户会话、丢弃全部推理历史或关闭保护机制来处理该报错。
不把一次回放成功泛化成所有 502 都已解决。

## 部署与回滚

1. 实时核对运行版本、运行态配置、现有 payload 规则、服务进程及账号套餐。
2. 在服务器 root-only 目录保存配置与运行态快照，敏感文件权限为 0600，不下载或提交完整配置。
3. 先添加仅匹配诊断 Header 的规则。模板中的 `override` 应合并到现有规则，不覆盖其他业务的列表。
4. 使用原生管理 API 更新 `/v8/management/config/requests/payload`，并回读 `/v0/management/config` 验证运行态；凭据仅在服务器内存中读取和使用。
5. 先验收单条搜索历史、已有声明的请求，再验收完整历史、completed 和预期输出。
6. 去掉诊断 Header 条件，正式限定 `gpt-6*`，再走公网真实回放。

注意：此次先原子替换 YAML 后，运行态仍无新规则；通过 v8 管理 API 更新才实际生效。
v8 API 会将旧配置布局规范化为 v8；本次回读比较确认有效配置仅 `payload` 改变。
后续不要只比较磁盘文本或只见 HTTP 200 就宣布热加载完成。

服务器备份与回执：

- `/root/cpa-upgrades/search-history-compat-20261008-110554/config.before.yaml`
- 同目录 `runtime.before.json`、`receipt.json`

回滚通过原生管理 API **仅移除与模板完全匹配的规则**，保留随后增加的规则和最新 OAuth 状态。
不要整份覆盖旧配置或凭据。原生 v8 配置布局也不需要为了回滚这一条规则而还原。

## Pro 优先是独立调度变更

实时套餐接口确认一份原 Pro 授权已成为 Free，另一份仍为 Pro（查询时周用量约 11%）。
旧 JWT 中两份都写 Pro，文件名也不能作为实时套餐依据。

通过 `PATCH /v0/management/auth-files/fields`，将有效 Pro 的 `priority` 设为 100，Free 设为 0。
运行态与 auth 文件均已验证，只有 `priority` 发生变化；账号保持启用，未轮换任何密钥或消费重置卡。
生产回放的新会话绑定已确认选中 Pro。

`session-affinity` 已有可用绑定高于优先级；优先级作用于新绑定、无绑定和故障切换。
本次没有强制迁移其他旧会话，也没有把 Free 账号设为全部 GPT-6 模型的可用兜底：它的相关模型探针明确返回不支持。

独立回滚元数据：`/root/cpa-upgrades/pro-priority-20261008-110056/priority-rollback.json`。
只恢复目标账号原来的 priority 值/缺省状态，不覆盖刷新后的 token 文件。

## 未完成的 App 验收

App 原会话的续聊和压缩中断尚未验收。观察到重启后上下文上限由 828,400 降到 258,400，而旧上下文约 583,616 token；该压缩失败需独立验证。
Air 当前配置使用官方 ChatGPT 登录且没有 smart-api base URL，不能把 CPA 回放通过当作这条官方路径的 App 验收。
本次未发送消息到原会话，未修改其历史，也未新建自动测试任务。
