结论：通过，无阻断问题。只做允许名单配置适配；鉴权与源码未改，教学总闸和 V2 未开。

名单等于既有 ARK 身份，已断言与 SEARCH 相同，单个 device-BJP003…。不是夹具 worker-service，无通配，token 未改。apply 成功，源码哈希未变；仅 p003-voice 重启（2341004→2342902，13→14）。回滚副本 brain-service-identity-before.env。

先核 HS256、issuer p003、audience kidshub、过期、role=device 和名单。错身份、错 role、错签名、过期、无 token 都在解析和打开 store 前 403。正确身份才到参数校验；空 body 为 400 invalid_request，memory_write=none，未查 grant、未写教学数据。写入仍要合法 grant。后续空 body 若 400，只证明服务鉴权已过，不是教学写入或真机通过。

node22/node24 测试 exit 0。材料无真实探针，不把 400 记为已完成。
