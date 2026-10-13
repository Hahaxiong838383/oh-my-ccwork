# P003 容量增量发布与回退记录（2026-10-13）

**结果：容量增量已在采集关闭状态部署；回退尚未执行。** 2026-10-13 15:58:34 CST部署 `9b63e7e9` 的10文件，只重启analytics；未购机、未迁库、未开放真实采集。

| 项目 | 实际记录 |
|---|---|
| 正向release-id | `analytics-release-capacity-20261013T075722Z` |
| 恢复点 | `/opt/p003/server/backups/analytics-releases/analytics-capacity-predeploy-20261013T075722Z` |
| 快照根已有文件 | `analytics-release-apply.py`（新版私有副本，0600）、`forward.tar.gz`、`reverse.tar.gz`、`source-only.tar.gz`、`state.json` |
| 私有备份 | `protected/.env.analytics`、`protected/analytics-control.json`、`protected/database/analytics-20261013T075722628039Z.sqlite3`及其JSON回执 |
| 旧配置证据 | `state.json`含5个旧文件SHA、新增清单、包SHA及进程状态；旧生态配置在源码归档的`deploy/analytics.ecosystem.cjs`，原kill_timeout为5,000 ms；未依赖整份旧PM2 dump |
| 正向包SHA256 | `06befd730422cd9a5b852abcc68ac5fa62ea66d6e9ba8db2061abb6b2d9a41a1` |
| 反向包SHA256 | `c658bb87ceb11f7d85ab61a94b9deaeab3bdcea17633b5417fa01dce55fb81e1` |
| 已完成的回退准备 | 5文件反向预检PASS；反向apply与实际回退重启尚未执行 |
| 部署后PM2 | analytics PID2899018 / restart 0 / kill_timeout 35000；3001 PID2817417 / restart 23、3002 PID1626403 / restart 0保持；这些是当时证据，回退时重新取当前状态 |

TTL修正后的隔离重叠验收：84,000条完整对账、全项PASS；P95 454.186 ms、P99 809.460 ms、最大999.071 ms、RSS峰值256,286,720字节、193.646秒，健康探针增量2.959 ms。维护20.485秒、exit 0、rebuilt 2 / failed 0 / partial false；每维实际939,160条fact，未越过100万预算。旧方案在负载开始25秒后启动维护，仅17,000条即失败、90秒wrapper截断；原预算为30秒/维度/日，生产维护CLI超时240秒，证据保留且未放大阈值。隔离库最终1,006,360条事件、2,012,720条fact，三处隔离服务端口已停，合成数据保留。

16:00:59 CST公网复核7个GET为200，匿名/无效凭据401，有效凭据关闭上传503且Retry-After 900，完整配置cfg11关闭且覆盖数0，生产event/seen/batch仍为0。16:03:14复核10文件SHA、3001/3002 PID、两timer active及两维护service最近Result success/exit 0；16:02:29 Studio备份任务实拉1份、核验2份成功。这些是发布验收，不能写成回退已经演练成功。

## 回退范围

反向仅恢复原本存在的5文件：`src/analytics/index.ts`、`src/analytics/store.ts`、`src/analytics/rollup.ts`、`deploy/analytics.ecosystem.cjs`、`deploy/analytics-release-apply.py`。新增的`src/analytics/fact-layout.ts`、`writer.ts`、`writer-thread.ts`、`writer-bootstrap.mjs`及`scripts/analytics-fact-layout.ts`保留，旧入口不再引用。

本轮无新增依赖，未部署package.json。不改3001/3002、admin、nginx、DB/WAL/SHM、seen、settlement、HMAC或env；不逆向迁移fact布局/索引，不恢复整个config.db/devices.db。保持上传关闭，旧源码恢复意味着回到已知性能基线。

**禁止执行旧`analytics-rollback.py --code`，它会重启3001。** 首次完整manifest `backups/analytics-releases/analytics-release-20261013/manifest.json`经本轮核对未变，原完整快照`analytics-predeploy-20261013T005846Z`继续保留。反向必须用新的唯一release-id，不能复用默认ID或覆盖正向manifest。

## 实际回退命令（尚未执行）

以下在已验证的公司HK主机、同一维护shell执行。既有快照/包只读使用；`rollback-*`是届时新建的诊断目录，不是已经存在的恢复点。完整PM2 JSON可能含环境秘密，只落私有目录、不回显。重复反向apply使用同一包字节和同一release-id，不重新打包。

```bash
set -euo pipefail
umask 077
cd /opt/p003/server
analytics_snapshot='/opt/p003/server/backups/analytics-releases/analytics-capacity-predeploy-20261013T075722Z'
analytics_apply_tool="$analytics_snapshot/analytics-release-apply.py"
analytics_rollback_id='analytics-release-capacity-rollback-20261013T075722Z'
analytics_attempt="$analytics_snapshot/rollback-$(date -u +%Y%m%dT%H%M%SZ)"
analytics_node='/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node'
mkdir -m 700 "$analytics_attempt"
python3 -B - "$analytics_snapshot" <<'PY'
import hashlib,json,sys,tarfile
from pathlib import Path
p=Path(sys.argv[1]); sha=lambda b:hashlib.sha256(b).hexdigest()
assert sha((p/'forward.tar.gz').read_bytes())=='06befd730422cd9a5b852abcc68ac5fa62ea66d6e9ba8db2061abb6b2d9a41a1'
assert sha((p/'reverse.tar.gz').read_bytes())=='c658bb87ceb11f7d85ab61a94b9deaeab3bdcea17633b5417fa01dce55fb81e1'
with tarfile.open(p/'forward.tar.gz','r:gz') as t: forward=json.load(t.extractfile('release.json'))
entry=next(x for x in forward['entries'] if x['target']=='/opt/p003/server/deploy/analytics-release-apply.py')
assert sha((p/'analytics-release-apply.py').read_bytes())==entry['sha256']
print('包与私有新版工具SHA核验通过')
PY
sha256sum backups/analytics-releases/analytics-release-20261013/manifest.json \
  backups/analytics-releases/analytics-release-capacity-20261013T075722Z/manifest.json \
  .env.analytics .env.local > "$analytics_attempt/preserved.sha256"
pm2 jlist > "$analytics_attempt/pm2-before.json"
python3 -B "$analytics_apply_tool" --bundle "$analytics_snapshot/reverse.tar.gz" \
  --release-id "$analytics_rollback_id"
```

先核当前正向manifest的bundle SHA与上述正向包一致，以及PM2中analytics实际路径/解释器和35,000 ms超时。任何SHA/CAS冲突、锁冲突、缺失旧文件或同ID异包均停止，不删manifest/锁绕过保护。仅apply支持逐文件幂等；不要把完整停启流程盲目重跑。

```bash
python3 -B scripts/analytics-control.py --control /opt/p003/server/data/analytics-control.json --disable
"$analytics_node" --env-file=.env.local deploy/analytics-config-off.mjs
for analytics_unit in p003-analytics-rollup.timer p003-analytics-backup.timer; do
  systemctl show "$analytics_unit" -p ActiveState -p UnitFileState > "$analytics_attempt/${analytics_unit}.before"
done
systemctl stop p003-analytics-rollup.timer p003-analytics-backup.timer \
  p003-analytics-rollup.service p003-analytics-backup.service
python3 -B scripts/analytics-backup.py --database /opt/p003/server/data/analytics.db \
  --destination "$analytics_attempt/database" --keep 2 > "$analytics_attempt/database.json"
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3006/ready > "$analytics_attempt/ready-before.json"
```

配置关闭API不传`--initialize-closed`，不重置revision。若API失联，总闸保持关闭，报告配置同步未完成。确认4个维护unit已停、无维护子进程，在线一致备份完整性通过；不得裸cp主库代替SQLite backup API。检查ready：`gate_enabled=false`、`allowlist_count=0`、`in_flight=0`。服务失活时先记录原因并按实际进程状态处理，不能把curl失败当成功。

**先按新版35秒超时停完writer，再恢复旧5秒配置。** 新writer最多30秒排空，不得先加载旧生态配置再停新版；停机步骤不套90秒整段wrapper、不直接强杀。

```bash
analytics_counts() {
  python3 -B - <<'PY'
import json,sqlite3
tables=('analytics_event','analytics_event_seen','analytics_batch','analytics_settlement')
with sqlite3.connect('file:/opt/p003/server/data/analytics.db?mode=ro',uri=True,timeout=5) as db:
    db.execute('BEGIN')
    print(json.dumps({t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in tables},sort_keys=True))
PY
}
pm2 stop p003-analytics
pm2 jlist > "$analytics_attempt/pm2-stopped.json"
# 确认analytics已stopped且PID退出，再执行；其他PM2进程保持运行。
analytics_counts > "$analytics_attempt/counts-before.json"
python3 -B "$analytics_apply_tool" --bundle "$analytics_snapshot/reverse.tar.gz" \
  --release-id "$analytics_rollback_id"
python3 -B "$analytics_apply_tool" --bundle "$analytics_snapshot/reverse.tar.gz" \
  --release-id "$analytics_rollback_id" --apply > "$analytics_attempt/apply.json"
pm2 restart deploy/analytics.config.cjs --only p003-analytics
pm2 jlist > "$analytics_attempt/pm2-after.json"
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3006/ready > "$analytics_attempt/ready-after.json"
analytics_counts > "$analytics_attempt/counts-after.json"
cmp "$analytics_attempt/counts-before.json" "$analytics_attempt/counts-after.json"
sha256sum --check "$analytics_attempt/preserved.sha256"
```

上述只读计数在停写后、反向apply前及恢复后、重启timer前比对，不输出设备ID或事件内容。**始终执行快照根里的新版工具**：反向会将现役apply恢复成旧版，但不会覆盖私有工具。每文件要求当前SHA为本次正向新SHA或快照旧SHA，第三方改动会拒绝；多文件替换不是整体事务，中途I/O失败可出现部分恢复，保持analytics停止并用原包CAS续作，不强制覆盖。

必须从恢复的`analytics.config.cjs` wrapper加载旧参数，不能只执行`pm2 restart p003-analytics`。核实际kill_timeout恢复为快照记录的5,000 ms，并核cwd、script、interpreter/node_args、fork单实例及内存阈值；若未刷新，仅停止并删除**已恢复旧版的**analytics定义，再以wrapper重建，禁止恢复整份旧dump：

```bash
# 仅参数核对失败时执行，随后重做所有验收。
pm2 stop p003-analytics
pm2 delete p003-analytics
pm2 start deploy/analytics.config.cjs --only p003-analytics
```

PM2配置与退出超时依据：[应用声明](https://pm2.keymetrics.io/docs/usage/application-declaration/)、[优雅退出](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/)。以实际PM2与服务状态验收，不以命令返回0代替。

## 验收与恢复维护

- 5文件旧SHA、两个既有manifest及env指纹通过；新增模块保留且旧入口不引用；反向manifest保存到本次反向release-id目录。备份、包、state与私有工具都保留，DB/WAL/seen/HMAC未回退。
- analytics的health/ready为200，SQLite安全版本、FULL(2)、autocheckpoint=0、checkpoint与WAL健康；采集关闭且allowlist空。受控有效凭据仍返回JSON 503/ANALYTICS_UPLOAD_DISABLED/Retry-After 900；不打开采集验证，不输出凭据。
- 停写前后四表count不减；3001/3002及其他进程相对本次`pm2-before.json`的PID/restart数无本次操作引起的变化，健康通过。旧源码与当前fact schema兼容；失败时保留关闭状态和JSON 503兜底，不能拿旧库“救启动”。
- 核对后`pm2 save`保存当前正确列表。先确认旧维护代码在当前schema正常运行，再仅恢复回退前原本active的两个timer，不改变enabled属性；若仍有维护故障，保持对应timer暂停并记入回执，不能报告全部恢复。

```bash
pm2 save
# 分别查看上面保存的两个timer状态；仅对原ActiveState=active且兼容核对通过者执行。
# systemctl start p003-analytics-rollup.timer
# systemctl start p003-analytics-backup.timer
```

回执必须记录触发原因、反向release-id/manifest、逐文件SHA、数据库一致备份结果、实际超时、PM2及健康结果、timer最终状态。**回退后保持真实上传关闭，容量优化重新验收；本文不宣称回退已经执行。**

署名：codex（OpenAI）| 2026-10-13
