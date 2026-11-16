# Grok 独立复审：997fe832 记录故障隔离

评审人：grok。日期：2026-11-16。对象提交 `997fe83243134407237e923ff632fd80edb562fd`。从 git archive 核 diff 并在隔离临时库复跑，只读业务树，未部署，未连接生产、C 机或绑定开关，未发同事消息，未 commit / push，未新建工作树，未调用下层代理。

## 结论

此次上线**没有隔离实现阻断**。`recordsDashboard` 对记录查询故障返回空覆盖/`dependency_unavailable`，原 `data.ark` / `data.usage` / `data.device` / `today` / `week` 保持不变；未知金额保持 `null`，不会写成 0；上传与家长分页仍 503 且无 ACK；错误家长仍 404；原 `ark_current` 故障仍 503；恢复表后原记录仍在且可按原 ID 重试。

发布仍保持关闭。主13正在用现役 Node22 在 Linux 临时隔离目录复跑，尚未部署。允许名单、真实设备与三方冻结不在本复审范围内。旧 Telemetry 换绑、三个语音路由、TS 旧错、两个产品摘要 `policy_pending` 按来信不扩大、不改判。

## 固定提交范围

HEAD 等于候选。父提交 `a4a9ec823e83ad976c968ab3fd83de3d7034eaaf`（合同散文对齐 item_references / 10,000 条 / 32MiB）。再上一层 `fe76919c` 即会话356已隔离通过的运行候选。

`a4a9ec82..997fe832` 只改 7 个文件：

| 文件 | 作用 |
| --- | --- |
| `src/ark/records-service.ts` | `recordsStore().dashboard` 包 try/catch，失败返回空覆盖 `dependency_unavailable` |
| `docs/records-r1/schema.mjs` | 摘要 reason 增加 `dependency_unavailable` |
| `scripts/ark-records.test.ts` | 真实 SQL 故障隔离用例；`t.after` 只清新增合成 fixture 的 grant/允许名单，不改生产 32 台上限 |
| 合同/INTEGRATION/交接文档 | 描述隔离语义 |

六文件发布清单里，本 SHA 只动 `records-service.ts`。`src/routes/telemetry.ts` 外层 try 仍包 `dashboardArk`，Ark 依赖失败继续 503。

核 diff 来源：`git archive 997fe83243134407237e923ff632fd80edb562fd`。归档内 `records-service.ts` SHA256 `90e2a237071988931c45b098ebf7df1c97d93d0175784dc594d5e75d5a089ddf` 与 `git show` 该路径逐字节一致。

## 隔离实现核对

```ts
export function recordsDashboard(publicId:string,owner:string){
 const dev=deviceRegistryStore.getByPublicId(publicId);
 if(!dev||dev.parent_account_id!==owner||!recordsAllowed(dev.sn))return dashboardRecords(emptyCoverage(),'not_enabled');
 try { return recordsStore().dashboard(publicId,owner); }
 catch { return dashboardRecords(emptyCoverage(),'dependency_unavailable'); }
}
```

`dashboardRecords(..., 'dependency_unavailable')` 固定 `available=false`、`family_coin/stardust=null`、`items=[]`、`updated_at_ms=null`。schema 有 `unavailable_income_requires_null`：不可用摘要写 0 会校验失败。错误 owner 在 `parentTelemetryRoute` 的 `ownedDevice` 上先 404，进不到该 catch。上传/分页走 `recordsDeviceRoute` / `recordsParentRoute`，不经过该 catch，SQL 失败仍 503 且 `data` 为空。

主13红灯证据：改名前 dashboard 503（`dashboard-isolation-red.log`）。修后全套第一次 31/32，失败是末例 `invalid_scope`（新 fixture 占满原 Ark 32 台授权），不是隔离断言；只给新用例加结束清理后 `dashboard-isolation-green-final.log` 为 32/32。本复审从 archive 独立复跑亦 32/32，确认清理未抬生产上限。

## 独立验证

Node `/Users/fu-121/.local/node-v24/bin/node` v24.19.0。使用归档里已有的 `tsx`/`hono`/`jose`/`zod` 只读符号链接，没有安装新依赖。测试进程 `chdir` 到 `/tmp/ark-records-r1-*`。schema 复制到 `schema-tmp` 再跑，业务树 `examples.json` 未被改写（工作树 `git status` 空）。

| 证据 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| `scripts/ark-records.test.ts` | `node --experimental-sqlite --import tsx --test --test-concurrency=1 scripts/ark-records.test.ts` | 0 | 32 通过 / 0 失败，16680.842ms。日志 `ark-records-test.log` |
| 复制后的 `validate.mjs` | `node --import tsx validate.mjs` | 0 | 59 通过。日志 `schema-validate.log` |
| 追加隔离反例 `probe-isolation.mts` | `node --experimental-sqlite --import tsx probe-isolation.mts` | 0 | 8 项通过。日志 `probe-isolation.log` |

追加反例在套件之外先写入真实 Ark 快照 `family_coin=7` / `stardust=4` / 补勤卡 2，再把 `ark_record` 改名：

- dashboard 200；`ark`/`usage`/`device` 与基线逐字段相等；钱包仍是 7/4，不是 0
- 记录摘要 `dependency_unavailable`，金额 `null`（不是 0，也不是 7），`source_mode=null`，物品空
- schema 拒绝把该摘要的 `family_coin` 改成 0
- context 在表改名期间仍 200
- 分页/上传 503，无 `accepted_record_ids`
- 错误家长 404
- 恢复表后原 1 条仍在，`during-failure` 按原 ID 200 ACK，变为 2 条
- 再改名 `ark_current`，dashboard 仍 503

## 非阻断观察

`catch {}` 吞掉 `dashboard()` 的全部异常，包括编程错误。这是本次隔离的显式取舍，外层 `dashboardArk` 失败仍 503，不把记录故障伪装成原资产故障。覆盖 `reason` 仍是合同常量 `partial_history`；客户端必须以两个摘要的 `reason=dependency_unavailable` 为准。该 catch 不打日志，现场只能靠摘要 reason 发现记录依赖不可用。

## 不计入本次通过

没有重跑 16 个归档脚本、Telemetry 内部 37 项、旧 ark-currency 三个语音路由、`listening-content.ts` 旧类型错误。没有真机、公网、真实家长 A/B、安卓 outbox、手机页面。没有复核主13正在进行的 Node22 Linux 隔离复跑，也没有部署。两个产品摘要仍 `policy_pending`，按范围不展开。

署名：grok | 2026-11-16
