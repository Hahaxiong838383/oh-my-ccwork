# 05 · 服务器/客户端契约（V0.1）

> Mock server (MSW) 实现 + 未来真后端对接契约。所有数据模型用 Zod schema 双侧共享。

---

## 设计原则

1. **服务器是单一权威**：星尘/家族币/解锁/新手状态/夜航完成标记，**客户端只渲染不存档**。
2. **关键时机推送**：进入专注 / 夜航结束 / 每开一个宝箱完毕 → 服务器主动 push 资产变更。
3. **配置表只下行**：客户端不修改配置，只读。
4. **存档双向**：客户端定期上传，服务器持有 3 份镜像。
5. **时间唯一可信源**：服务器时间（避免本机时间被改）。

---

## 接口清单

### 用户 / 资产

```
GET  /api/user/me
→ {
    user_id: string,
    gender: 'male' | 'female',
    register_at: number,
    use_days: number,                    // 实际使用天数（非自然日）
    stardust: number,
    family_coin: number,
    newbie_phase: { phase_id, days_left } | null,
    skin_id_current: string,
    skin_ids_owned: string[],
    server_now: number                   // 服务器当前时间戳
  }
```

### 夜航报告

```
POST /api/night-report/claim
body: { client_lid_open_at: number }    // 客户端开盖时间（参考）
→ {
    base: {
      offline_hours: number,
      capped_hours: number,
      stardust: number,                  // 已乘新手倍率
      supplies_level: 'low' | 'middle' | 'high' | 'none'
    } | null,
    bonus_discovery: {
      box_level: 1 | 2 | 3 | 4,
      rewards: Reward[],
      voice_id: number
    } | null,
    use_day_after: number                // 本次结算后的使用天数
  }

POST /api/night-report/done
body: { received_at: number }
→ { ok: true }                          // 客户端完整播完才发，否则下次重算
```

### 开箱

```
POST /api/treasure/open
body: { source: 'focus' | 'night_report_bonus', box_id?: string }
→ {
    box_id: string,
    box_level: 1 | 2 | 3 | 4,
    rewards: Reward[],                   // 服务器决定
    upgraded_by_newbie: boolean,         // 触发新手暴击
    sequence_pool_index: number | null,  // 4 级宝箱的序列位置
    voice_id: number
  }

POST /api/treasure/open-done
body: { box_id: string }
→ { ok: true }
```

`Reward` 类型：

```ts
type Reward =
  | { type: 'stardust'; amount: number }
  | { type: 'family_coin'; amount: number }
  | { type: 'collectible'; item_id: number; first_time: boolean }
  | { type: 'eco_part'; part_id: number; is_upgrade: boolean }
  | { type: 'skin'; skin_id: string };
```

### 生态缸

```
GET  /api/ecosystem/state
→ {
    unlocked_parts: { part_id: number; level: number }[],
    pending_anims: {
      anim_id: string;
      part_id: number;
      action: 'unlock' | 'upgrade';
      voice_id: number;
      created_at: number
    }[]
  }

POST /api/ecosystem/anim-done
body: { anim_id: string }
→ { ok: true }
```

### 专注会话

```
POST /api/focus/start
body: { mode: 'explore' | 'companion', client_now: number }
→ { session_id: string, server_now: number }

POST /api/focus/heartbeat
body: { session_id, focused_seconds, away_seconds, boxes_generated: BoxId[] }
→ { ok: true }                          // 服务器校验防作弊

POST /api/focus/end
body: { session_id, reason: 'exit' | 'forced_offline' }
→ {
    pending_boxes: BoxId[],              // 让客户端进入 reward machine
    last_offline_start: number | null
  }
```

### 存档

```
GET  /api/save/{slot}                   // slot: current | yesterday | prev
→ {
    snapshot: SaveData,
    saved_at: number,
    checksum: string
  }

PUT  /api/save/{slot}
body: { snapshot: SaveData, saved_at: number }
→ { ok: true, checksum: string }
```

`SaveData` 字段来自 `SaveId.xlsx`，包含：用户偏好（亮度/色温/音量/LED）、当前皮肤、本地缓存的解锁列表 hash。

### 设置硬件

```
PUT /api/settings/hardware
body: {
  led_on?: boolean,
  brightness?: 1 | 2 | 3,
  color_temp?: 1 | 2 | 3,
  volume?: number  // 0-100, step 5
}
→ { ok: true, applied: { ... } }
```

demo 阶段直接落 Dexie + 反映到设备外壳 UI。

### 语音

```
POST /api/voice/log
body: {
  session_id: string,
  wake_at: number,
  command: string,        // 解析后的命令
  raw_text?: string,      // STT 原文（隐私允许时）
  duration_ms: number,
  result: 'executed' | 'rejected' | 'unknown'
}
→ { ok: true }
```

仅用于运营埋点，不阻断业务。

### 配置表

```
GET /api/config/{table_name}
headers: { If-None-Match: <etag> }
→ 200 { data: TableData, etag: string }
→ 304 (未变化)
```

---

## 错误处理统一格式

```ts
type ApiError = {
  code: string;             // 'NETWORK_ERROR' | 'AUTH_REQUIRED' | 'VALIDATION_FAILED' | ...
  message: string;          // 用户可见
  detail?: object;          // 调试用
  retryable: boolean;
};
```

客户端处理矩阵：

| code | 表现 |
|---|---|
| NETWORK_ERROR | tips "网络连接不稳定" + 自动 retry 3 次 |
| AUTH_REQUIRED | demo 阶段不会出现 |
| VALIDATION_FAILED | 工程模式日志，用户层用通用提示 |
| SERVER_BUSY | tips "服务器繁忙，稍后再试" |
| UNKNOWN | 通用 tips + 详细日志 |

---

## 防作弊基线（real server 必做，mock 不验证）

- 专注时长 heartbeat 频次 < 客户端理论上限的 1.5×
- 开宝箱接口必须能在 server 侧根据 user_id + 时长重算等级
- 序列奖池索引完全 server 侧推进
- 存档 checksum 校验

---

## 与配置表的关系

服务器 = 配置表 + 用户状态 → 计算奖励
客户端 = 服务器返回 → 渲染

例：开箱
1. 客户端调 `POST /api/treasure/open`
2. 服务器读 `NewbiePhase`（是否新手） + `DropTable`（等级） + `CollectionItem`（藏品库 by 性别）
3. 决定本次奖励 + 是否暴击
4. 写库（扣除/增加货币、记录获得）
5. 返回 `rewards` + `upgraded_by_newbie` + `voice_id`
6. 客户端播动画 + 调 `treasure/open-done`

**客户端不参与奖励决策**，避免修改前端绕过。

---

## OpenAPI 契约源

未来用 `openapi.yaml` 作为单一真相源，生成：
- TypeScript types（前端）
- MSW handler 类型签名
- 真后端 controller stub（NestJS / Hono）
- Postman / Bruno 测试集合

工具：`openapi-typescript` + `msw/openapi`。
