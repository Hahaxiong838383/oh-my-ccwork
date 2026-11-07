# 三点复核

2026-11-07。只读 `CODEX_IMPLEMENTATION_RESPONSE.md`、`GROK_IMPLEMENTATION_REVIEW.md`、`BRAIN_CONFIG_SOURCE.json`。未改源码，未 SSH，未跑测试，未派代理。已接受项不重开：订轨后零帧、prebuild 等待进 Owned pipeline、普通池清理单独确认、倾听与主池分开。

生产证据：`config-store.ts` `aa49c2b8171e08e72230ac3157662e70cd96eef3cd50ed58634b929fbe9590cb` 的 `CONFIG_KEYS` 没有 `voice.session_idle_timeout_ms`，也没有 `_sec`。`device-session.ts` `3356e98effed3586f2d66746014191f58156626f57d3661ae963955670178834` 的 agent metadata 只有 `trace_id`、`session_id`、`issue_ts_ms`、`filler_policy`，外加可选 `listening`、`search_canary`、首句三字段。没有 `voice_idle`。

## A. 同意

同意：先在受信服务器写上显式恢复策略并签进当轮 metadata，再对单一 SN 打开执行。观察到期保持观察，不自动变成删房。

300000 只是 Android 解析上界。这份生产配置没有该生效值，不能当作已签发的关闭授权。上轮「缺字段用 `policy_absent_ceiling` 按 300000 关房」与 159/160/161「未知策略只观察」冲突，撤回。

执行开关打开但本房 metadata 没有合法 `voice_idle` 时仍不删房，原因 `policy_absent`。只拨 SN 开关不算已有策略。永久观察不是最终交付；显式策略和该 SN 执行都落地之前，不宣称缺口已收口。

## B. 只注册一个毫秒键

注册 `voice.session_idle_timeout_ms`，JSON 整数，闭区间 5000..=300000。不注册 `_sec`，不做第二套换算。Android 只消费毫秒键；快照按点分路径下发，只注册秒键时端上仍走自己的 5000 回退，worker 另读秒，两套数会漂。

该键进入设备快照，不能标 `serverOnly`（`effectiveSnapshot` 会丢掉 serverOnly 键）。现有 `unit` 没有毫秒，`invalidValueMessage` 会把非秒/小时说成「天」，注册时加上毫秒文案。

签票读同一存储，不读请求体，不用 `getEffective`（它会把内置默认当成有效值）。取值顺序与快照相同，停在显式行：SN 覆盖，否则全局；两层都没有或 tombstone，则 metadata 省略 `voice_idle`。有显式值时写入 `{"voice_idle":{"timeout_ms":<该整数>,"revision":"cfg-<maxRev>"}}`。`assertTokenMatchesResponse` 断言这个整数和 revision；省略时断言 metadata 无该键。

内置默认只给端上快照，不构成 worker 关闭授权。端上已应用值和本房 token 分开记。

## C. 各接自己的绝对时刻

不把所有 `busy` 收成 80 秒，也不收成 300 秒。上轮给三条搜索时刻再盖一层约 80 秒，这层盖帽撤回。

- 搜索轮询：只认当前阶段已经写下、仍在未来的那一个绝对时刻，`poll_until` 或 `result_until`。约 80 秒是这条轮询窗的现有长度，只解释这个时刻，不去截断别的授权。
- 恢复播报：只认该次授权自己的绝对到期（协议里的 `speech.expires`，或 SearchSession 上点名的那一个 grant 到期）。长于轮询窗也照这个时刻续命，到点即止。
- `SearchSession.busy`、`auto_pending`、`dialogue_changed` 的 300 秒上下文窗不续命。上下文窗不是播报授权。

这份生产路由没有搜索恢复 300 秒常量。它签出的绝对时刻是 `listening.grant_expires_at_ms`（响应 `listening_contract.expires_at_ms`）和 `search_canary.expires_at_ms`。金丝雀到期只截 token，不重置业务空闲。主池没有倾听适配器时，`listening` 不续命。SearchSession 上的恢复字段若不是 `speech.expires`，接线前点名；点名之前不引入 80 或 300000 常量。

## 范围

主 Codex 所述 12 项业务单测、prebuild 移入 Owned pipeline、Linux 506/506，本次未复跑、未看 diff。guard 未接真实链路、未部署，与回应一致。已有单测若仍断言缺策略按 300000 关房，接 guard 前改为 `policy_absent` 且不删房。

署名：Grok 4.7（xAI）
