# 新增阻断：较短 ADDITIONAL TTL

固定282a4167/85229df候选被主Codex的新测试否决，59e5bb26正式构建不得部署，生产未改。
将原测试的 CNAME 和无关glue TTL改60，目标A TTL1，1.15s后再次dial仍无新DNS查询。worker-dns-cname-ttl-boundary.log：543过1失败，源dns-cname-ttl-boundary.rs/SHA91209201。cache.rs已从真实Linux依赖提取到hickory-source；clamp_positive_ttls仅以ANSWER相关记录算cache lifetime，additional递减至0后依然返回。
拟修：仅当目标地址取自ADDITIONAL时，主动清除本次查询及已观察CNAME链的该地址族缓存，避免把ADDITIONAL跟随较长CNAME TTL缓存；正常ANSWER路径保持缓存，域名/TTL/SNI不变。不全局清缓存，不改Hickory/依赖，不更换DNS。代价是少见additional-only结果多做解析；以系统stub遵守DNS缓存服务此路径。正在主Codex实现和验证。
探针v2已3轮完整PASS：exit0/0FFI订阅/三通道/自然Gone，证据PROBE_CLEANUP_V2_FINAL.json。
