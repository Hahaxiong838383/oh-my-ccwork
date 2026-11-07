私有目录写入被工作区写根拒绝，下面就是可直接归档的完整结论。

# Grok CNAME TTL 终审 2026-11-08

实际模型：Grok 4.7（xAI）。这是用户所称 Grok175 的限定复查。

审查范围只包括：`CODEX_CNAME_TTL_FINDING.md`、`dns-cname-ttl-boundary.rs`、`worker-dns-cname-ttl-boundary.log`、`worker-dns-cname-ttl-final-v3.log`、`source-dns-cname-ttl-final-v3.json`、`PROBE_CLEANUP_V2_FINAL.json`、`DNS_CNAME_CANDIDATE_20261108.md`，以及 Hickory 0.26.3 的 `cache.rs`、`caching_client.rs`、`resolver.rs` 里 TTL 与 `clear_lookup_cache` 相关部分。运行逻辑只核 `ca5f95b4243cfddeaa3370e8e7ad85e7600e541d` 的 `voice_connect.rs`。工作区该文件 SHA256 为 `f49596c20a9351ef6325b5a1430d001cb8f50e48859738bcdd4127a6d234be8d`，与 v3 日志头和 source manifest 一致。未联网、未跑探针、未装依赖、未改代码、未另启代理、未重查线上。

## 1. 撤回旧结论，接受红测

撤回上一份增量审查里「85229df 的 TTL 非阻断」。红测成立。

`worker-dns-cname-ttl-boundary.log`：543 passed，1 failed。失败点是 `cname_target_in_additional_is_not_discarded_as_no_addresses`，当时 `voice_connect.rs:172`，断言 `additional address must not extend DNS TTL`，left 1，right 2。夹具是 CNAME TTL 60、目标 A 在 ADDITIONAL 且 TTL 1、无关 glue TTL 60。两次 dial 后查询数为 1；睡眠 1.15 秒后再 dial 仍然成功，但没有新的 A 查询。旧候选因此继续使用已经过期的 ADDITIONAL 地址。

Hickory 0.26.3 `cache.rs` 168–177 行：非 NS 查询的缓存寿命只取 ANSWER 里查询类型或 CNAME 的最小 TTL。`Entry::updated_ttl` 232–246 行对 ADDITIONAL 递减，减到 0 仍返回整条缓存。这与红测一致。

`282a4167` / 正式包 `59e5bb26` 维持禁止部署。生产按已有记录未切换。

## 2. 新的定向清缓存没有具体阻断

`ca5f95b` 的运行变化是 `voice_connect.rs` 42–49 行和 69–79 行。只有选中的地址来自 ADDITIONAL 时，`uses_additional` 才为真；随后只 `clear_lookup_cache` 本次 host 和实际遍历到的 IN CNAME 链，类型仅限本次 A 或 AAAA。`resolver.rs` 246–254 行按单个 Query 删除。owner 与地址族过滤仍在 63–75 行。普通 ANSWER 不进入清除分支。

没有能打穿这 15 行的反例。同包 ADDITIONAL 的缓存键就是本次查询名，48–49 行会清掉；多跳同包的中间名也在 `seen` 里。追逐查询若把目标 A 并入 ANSWER，缓存寿命会跟着该 A 的 TTL；递归夹具由 3 次查询到期后再增到 6 次，且 `uses_additional` 为假。清除发生在 `lookup` 返回之后、TCP await 之前。

v3 日志：547 passed，0 failed，1 ignored。已覆盖 ADDITIONAL 目标不再吃到 60 秒缓存、普通 CNAME 答案仍按较短 ANSWER TTL 缓存、TTL 0、多跳同包、递归原名缓存、IPv6 ADDITIONAL 可用。

非阻断代价：同一地址同时出现在 ANSWER 和 ADDITIONAL 时也会清该名缓存，只是多一次查询。AAAA 用例没有单独断言到期重查，但走同一分支。

## 3. 发布

同意新候选在下列条件同时满足时进入主池受控发布：发布物必须是 `ca5f95b` / `voice_connect.rs` `f49596c2…` 的新正式构建；paired rollback 保留现役 `3dd0430a` 与 env `5c15`；空房、无未完成 job、其它池不漂移；该新版本正式 RTC 的普通与 ordered 都通过。旧 `59e5bb26` 不得替代。

本轮没有重查这些门槛是否已经执行。`PROBE_CLEANUP_V2_FINAL.json` 三轮均为 exit 0、`ffi_subscribers_after_cleanup` 0、`natural_room_gone` true，候选哈希是现役 `3dd0430a`，只补上旧探针缺口。

历史 4.704 秒 / 386 毫秒 DNS 长等待仍为 OPEN。这次修复不关闭该问题。
