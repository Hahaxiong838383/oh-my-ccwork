# KidsHub Growth Insight M3 / Day 8–11 验收记录

> 日期：2026-08-05
> 结论：M3 已完成开发、自检、部署与 GitHub/Studio 提交一致性验证，等待川哥真实体验确认。

## 1. 交付范围

- 五个独立入口：品类、品牌/竞品、关键词、达人、商品。
- root/editor 可新增、编辑、软删除；viewer 只读。
- root 可查看并恢复软删除记录，editor 恢复接口为 403。
- 品类支持上级品类；品牌和关键词可关联品类；商品可关联品牌。
- 达人和商品支持跨源别名合并。
- 同一 `entity_type + source + source_id` 可重新指向新的主实体。
- 已删除别名只允许 root 恢复，editor 不能通过再次合并绕过恢复权限。
- 所有成功写操作写入 append-only 审计日志。

## 2. 自动验收

最终 Studio 回归：

```text
schema verification passed
M2 verification passed
Day 7 verification passed
M3 verification passed
{"entities":5,"aliases":2,"viewerWrite":403,"editorRestore":403,"auditCount":29}
```

M3 验收覆盖：

- 五类实体逐类 create / read / update / soft-delete / root restore。
- viewer 五类列表和页面均可读，写接口为 403。
- editor 可写但不能恢复。
- root 可查看删除项并恢复。
- 达人别名重新指向另一个主实体。
- 商品别名软删除、editor 恢复 403、editor 重新合并复活 403、root 恢复 200。
- 重复来源业务键返回 409。
- 29 条测试写操作均产生审计记录。

## 3. 负向验证

临时把创建主数据权限错误地开放给 viewer，隔离端口实例中 `ops:verify-m3` 准确失败：

```text
viewer create category expected 403, got 201
```

负向实例与正式 `3200` 隔离。恢复正确权限后，正式实例 M1/M2/Day 7/M3 全回归通过。

## 4. 数据与运行态

- 正式数据库仍只保留 1 个 active root 和 1 个有效 Session。
- 五类主数据和别名均为空，未替川哥预填品类、品牌或竞品。
- 所有自动验收账号、Session、审计测试数据和业务测试数据已清理。
- `cn.kidshub.insight.web` 为 running，最终 PID 与重启前不同。
- Studio Git HEAD 与 GitHub main 均为 `8fae20c207deb6bcd0631f1cd1836f5c304111af`，Studio 工作区 0 行脏状态。
- GitHub push 明确经过 xray `JP-Linode-V1`。

## 5. 经验教训

1. **检查脚本的失败原因也必须验证。** 第一轮负向运行确实红了，但原因是 HTML 页面被当 JSON 解析，不是权限 bug；修正 content-type 判定后重新注入，才命中预期的 viewer=201。
2. **所有测试写入都要带可清理标识。** 原先“预期被拒绝”的 viewer 请求没带测试 source，权限 bug 生效后留下 1 条正式库记录；已按精确 ID 清理，并让失败路径也带 run source。
3. **恢复权限不能只守 restore 路由。** Alias upsert 原本会把 `deleted_at` 清空，editor 可通过再次合并绕过 root-only 恢复；必须在 upsert 前检查已删除状态和角色。
4. **隔离实例的启动方式要先实测。** 临时目录复用 pnpm symlink 时，`pnpm exec` 会尝试重装依赖并因无 TTY 失败；改用已安装且已核对帮助的 `next dev [directory]` 直接启动。
5. **只读 UI 不应只隐藏按钮。** viewer 的表单字段也应 disabled，避免看起来可编辑；真正权限仍由服务端 403 保证。
6. **非受控输入在刷新后要强制重建。** 行内编辑使用 `defaultValue` 时，保存后需用 `updatedAt` 参与 key，否则服务端新值不会刷新到现有 DOM。

## 6. 体验入口

- 首页：`http://192.168.61.177:3200`
- 品类：`http://192.168.61.177:3200/master-data/category`
- 品牌/竞品：`http://192.168.61.177:3200/master-data/brand`
- 关键词：`http://192.168.61.177:3200/master-data/keyword`
- 达人：`http://192.168.61.177:3200/master-data/creator`
- 商品：`http://192.168.61.177:3200/master-data/product`

## 7. 下一步边界

川哥体验通过后再进入 Day 12–13 / M4：数据源配置、Token 不回显、活性校验、脱敏与配额。当前未提前实现。
