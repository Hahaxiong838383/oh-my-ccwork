# 04 · 配置表索引（V0.1）

> 9 张配置表，demo 阶段用 JSON 模拟 Excel。所有业务逻辑必须通过加载器读取，**禁止硬编码**。

| 表名 | 文件 | 主键 | 关键字段 | 加载时机 |
|---|---|---|---|---|
| Dictionary | `config/tables/dictionary.json` | key | value (number/string) | 启动时全量 |
| DropTable | `config/tables/drop-table.json` | (使用天数, 宝箱次序) | 所需专注时长 / 宝箱等级 / 奖励 ID | 启动时全量 |
| EcoTank | `config/tables/eco-tank.json` | part_id | name / level / 资源 ID / 语音 ID / 首次/重复家族币 | 启动时全量 |
| CollectionItem | `config/tables/collection-item.json` | item_id | 名称 / 品质 / 性别归属 / 资源 / 首次/重复家族币 | 按需加载 |
| NewbiePhase | `config/tables/newbie-phase.json` | phase_id | 起始天 / 结束天 / 光环资源 / 星尘倍率 / 升级权重 | 启动时全量 |
| SkinConfig | `config/tables/skin-config.json` | skin_id | 名称 / 价格 / 动画 / 语音 / 是否默认 | 启动时全量 |
| AudioConfig | `config/tables/audio-config.json` | audio_id | 路径 / 音量基准 / 备注 | 启动时全量 |
| ParticleConfig | `config/tables/particle-config.json` | particle_id | 参数（粒子数/大小/颜色/生命） | 按需加载 |
| SaveId | `config/tables/save-id.json` | field_key | 字段类型 / 默认值 / 说明 | 启动时全量 |

---

## Dictionary 关键 key 清单

来自产品文档汇总：

| key | 类型 | 含义 | 示例值（demo） |
|---|---|---|---|
| Shortleave | int (sec) | 短暂离阈值 | 30 |
| Longleave | int (sec) | 长时离开阈值 | 3600 |
| Backtime | int (sec) | 返回确认人在值 | 5 |
| Offlinetime | int (hour) | 切换欢迎动画的离线时长阈值 | 48 |
| NoanswerTime | int (sec) | 状态询问无应答超时 | 10 |
| RewardPerHour | int | 每小时离线星尘 | 10 |
| MaxHours | int | 离线收益上限小时 | 12 |
| LowSupplies | int (sec) | 物资堆低阈值（demo 缩到 30s） | 60 |
| MiddleSupplies | int (sec) | 中阈值 | 180 |
| HighSupplies | int (sec) | 高阈值 | 360 |
| ConfirmExitTimeout | int (sec) | 二次确认超时 | 30 |
| SettingsAutoClose | int (sec) | 设置面板无操作自动关 | 10 |
| TodayCutoffHour | int | 跨日界点（北京时间小时） | 0 |
| SleepStartHour | int | 自动息屏（北京时间） | 20 |
| SleepEndHour | int | 自动亮屏 | 8 |

**严禁**业务代码出现 `30 * 1000`、`60 * 60` 这类魔法数字。必须 `getDict('Shortleave')`。

---

## DropTable 结构

每行 = "使用天数 + 宝箱次序" 的复合 key，决定该次专注的第 N 个宝箱：

```json
[
  { "use_day": 1, "box_index": 1, "focus_seconds": 15, "box_level": 1, "reward_id": 100001 },
  { "use_day": 1, "box_index": 2, "focus_seconds": 35, "box_level": 2, "reward_id": 100002 },
  { "use_day": 1, "box_index": 3, "focus_seconds": 99999, "box_level": 3, "reward_id": 100003 },
  ...
  { "use_day": -1, "box_index": 1, "focus_seconds": 15, "box_level": 1, "reward_id": 100001 }
]
```

`use_day=-1` 是兜底（用户使用天数未配置时）。最后一个 box 用极大值保证产出保底。

---

## EcoTank 结构

V1.0 五个部件 × 3 级 = 15 行：

```json
[
  {
    "part_id": 1301001,
    "name": "底",
    "level": 0,
    "is_default": true,
    "resource": "ecosystem/base/lv0.png",
    "voice_id": null,
    "first_get_coins": 0,
    "repeat_get_coins": 0
  },
  {
    "part_id": 1302001,
    "name": "星光草",
    "level": 1,
    "resource_seq": "ecosystem/parts/starGrass_lv1/frame_{00..05}.png",
    "particle_id": 500011,
    "unlock_voice_id": 4200011,
    "first_get_coins": 100,
    "repeat_get_coins": 10
  },
  { "part_id": 1302002, "name": "星光草", "level": 2, ... },
  ...
]
```

---

## NewbiePhase 结构

```json
[
  {
    "phase_id": 1,
    "name": "金色新舰长",
    "start_day": 1,
    "end_day": 3,
    "halo_resource": "newbie/halo_gold.png",
    "stardust_multiplier": 2.0,
    "first_box_upgrade_weights": { "+0": 10, "+1": 30, "+2": 40, "+3": 20 },
    "daily_greet_voice_id": 4100201
  },
  { "phase_id": 2, "name": "紫色新舰长", "start_day": 4, "end_day": 7, ... },
  { "phase_id": 3, "name": "蓝色新舰长", "start_day": 8, "end_day": 14, ... }
]
```

---

## AudioConfig 关键 ID 段（从产品文档归集）

| ID 段 | 用途 |
|---|---|
| 4000001-4000099 | 系统语音（欢迎/告别/二次确认） |
| 4000010-4000020 | 状态询问相关 |
| 4000030-4000040 | 二次确认/无宝箱提示 |
| 4100001-4100099 | 唤醒后回应语音（随机库） |
| 4100201-4100299 | 新手期阶段问候 |
| 4200001-4299999 | 生态缸解锁/升级语音 |
| 4300001-4399999 | 藏品获得语音 |
| 4500001-4599999 | 音效（按钮/弹窗/购买/换肤特效） |
| 40000001 | UI 默认按钮音 |

---

## 加载器约束

```ts
// apps/web/src/config/loader.ts
import { z } from 'zod';
import dictionarySchema from './schemas/dictionary';
import dictionaryJson from './tables/dictionary.json';

const dictionary = dictionarySchema.parse(dictionaryJson);
// ↑ 启动失败 = 配置不合规，立刻报错

export function getDict<K extends DictKey>(key: K): DictValue<K> {
  const v = dictionary[key];
  if (v === undefined) throw new Error(`dict miss: ${key}`);
  return v;
}
```

**所有 systems 函数签名**：
```ts
// ❌ 不行
function focusTick(state, now) { if (away > 30000) ... }

// ✅ 正确
function focusTick(state, now, config) {
  if (away > config.shortleaveMs) ...
}
// 再在外层注入 config = loadFocusConfig()
```

---

## 配置变更工作流

1. 改 `config/tables/*.json`
2. 跑 `pnpm config:validate`（Zod 全表校验）
3. 必要时改 schema（`config/schemas/`）
4. 单元测试 + visual regression（关键参数变更必须有截图对比）
5. 提 PR，PR 模板里强制勾选"配置变更是否影响存档兼容性"

---

## 与未来真后端的契约

服务器最终会接管这些配置表：
- 客户端冷启动调 `GET /api/config/{table}` 拿最新
- ETag 缓存，无变化不重传
- 客户端用 `config_cache` 表本地缓存
- demo 阶段 mock server 直接返回 JSON 文件内容
