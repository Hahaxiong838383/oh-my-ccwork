# 云端收益 P0 操作说明

P0 是独立只读试算工具，不接语音主路径，不开正式结算。Node24、项目既有 tsx/zod，无新增依赖。

## 真实数据回放

在 `apps/server` 运行，环境提供 `ANALYTICS_DB_PATH`、`TELEMETRY_DB_PATH`、`ANALYTICS_DEVICE_KEY_SECRET`。凭据不得放命令行、报告或 Git。

```sh
node --experimental-sqlite --import tsx scripts/economy-shadow.ts \
  --subject BJP00326070803800006 --day 2026-10-31 \
  --cutoff-ms 1793462967006 --output-dir /独立私有目录/reports
```

- 日期是北京时间自然日的查询窗，不自动等同游戏逻辑日；cutoff固定接收截止，后到数据另开一轮，不覆盖旧回执。截止至多日末之后31天。
- 子进程最多5秒；源库SQLite readOnly/query_only，每源最多10000条+1检测截断。两库各自读快照，不声称跨库原子一致。额外读取前14天范围的相关GM否决证据，不能被异常发生时钟过滤掉。
- 当前输入来自保留的原始事件；TTL清理后不能重建完整旧输入。影子库保留输入摘要/报告，不复制个人原始正文，不能承诺任意历史完整重放。
- 同输入集合、规则、截止和引擎版本只留一份报告；输出JSON/Markdown和影子库。影子库1000份上限，达到需人工归档，不自动删除审计。
- 无数据、断档、GM、版本未知不解释为0使用。上传批次的内容版本不证明事件发生时版本。

## 离线复现及候选规则

`--input /私有/input.json --output-dir /其他目录/reports` 读取冻结观察包，格式见 `contracts.ts`，不同时提供subject/day/cutoff。

显式添加 `--rule scenario.example.json --basis checkpoint_max` 或 `telemetry_union` 可做数学条件试算。**示例数值纯测试，不是当前游戏规则。** 有对应时长且无已检测异常才计算；永远scenario_only、ready_for_settlement=false、certified_eligible_ms=null。

首版数学规则仅覆盖递增累计阈值与固定数量候选奖励，不支持正式G1首日/常规日、语义触发、使用日覆盖、序列奖励、消耗或领取；不可据此发布正式配表。同revision不同内容拒绝保存。source_sha256仅为提供者声明，不代表已验证当前设备正在使用。规则变化新revision，引擎语义变化必须更新ENGINE_VERSION，避免旧运行ID混入新解释。

## 测试及回滚

```sh
node --experimental-sqlite --import tsx scripts/economy-shadow.test.ts
node --experimental-sqlite --import tsx scripts/economy-shadow-storage.test.ts
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck src/economy-shadow/*.ts scripts/economy-shadow*.ts
```

工具部署在独立版本目录，无系统服务、计划任务或公共接口。停止调用即停止试算；保留回执/SHA，不重置生产库、不回滚钱包。未来正式接管的账本迁移/补偿必须单独设计。
