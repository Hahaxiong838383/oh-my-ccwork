# multica 多用户飞书授权 PoC API 设计（路径 A：User OAuth）

## 1. 目标与范围

1. 目标：让 multica agent 使用“团队成员本人”的飞书身份调用 lark-cli。
2. 范围：仅覆盖 Device Flow 授权、绑定落库、运行时按用户路由 HOME。
3. 非目标：
   - 不改 lark-cli 内部实现。
   - 不处理多租户 appId 隔离（当前固定同一 appId）。
   - 不实现复杂 RBAC，仅做用户级绑定与状态检查。

## 2. 关键约束（已决策）

1. lark-cli profile 不能同 app 多 profile。
2. 多用户隔离必须走多 HOME。
3. token 文件按用户独立，appsecret 与 master.key 可共享拷贝。
4. mini 侧先执行一次 keychain downgrade，确保子进程可读。

## 3. 目录与文件约定

1. 用户 HOME 根目录：`/var/lib/multica/user-homes/`
2. 每个用户目录：`/var/lib/multica/user-homes/mc-user-<multica_user_id>/`
3. 授权映射持久层：
   - PoC 文件：`/var/lib/multica/user_mapping.json`
   - 正式版：PostgreSQL `multica_lark_bindings`
4. 脚本工具目录：`/tmp/lark_multi_user/`

## 4. API 概览

### 4.1 Endpoint 列表

1. `POST /api/feishu/device/start`
2. `POST /api/feishu/device/complete`
3. `GET /api/feishu/device/status`

### 4.2 交互时序（简化）

1. 前端点“飞书授权” -> `start`
2. 后端 provision + 申请 device_code + 返回二维码
3. 用户扫码授权
4. 前端提交 `device_code` -> `complete`
5. 后端 polling 完成、落库绑定
6. agent 执行任务时按 `multica_user_id` 选择 HOME

## 5. 数据模型（Go）

```go
package feishu

import "time"

type DeviceStartRequest struct {
    MulticaUserID string `json:"multica_user_id"`
    Domains       string `json:"domains,omitempty"` // 默认 im,calendar,contact
}

type DeviceStartResponse struct {
    OK              bool   `json:"ok"`
    MulticaUserID   string `json:"multica_user_id"`
    DeviceCode      string `json:"device_code"`
    VerificationURL string `json:"verification_url"`
    UserCode        string `json:"user_code,omitempty"`
    ExpiresIn       int64  `json:"expires_in"`
    QRAsciiBase64   string `json:"qr_ascii"`
}

type DeviceCompleteRequest struct {
    MulticaUserID string `json:"multica_user_id"`
    DeviceCode    string `json:"device_code"`
}

type DeviceCompleteResponse struct {
    OK             bool     `json:"ok"`
    MulticaUserID  string   `json:"multica_user_id"`
    LarkUserOpenID string   `json:"lark_user_open_id"`
    LarkUserName   string   `json:"lark_user_name"`
    Scopes         []string `json:"scopes"`
}

type DeviceStatusResponse struct {
    OK              bool      `json:"ok"`
    Bound           bool      `json:"bound"`
    MulticaUserID   string    `json:"multica_user_id"`
    LarkUserOpenID  string    `json:"lark_user_open_id,omitempty"`
    LarkUserName    string    `json:"lark_user_name,omitempty"`
    UserHome        string    `json:"user_home,omitempty"`
    TokenState      string    `json:"token_state,omitempty"` // valid / invalid / no_token / unknown
    LastAuthorizedAt time.Time `json:"last_authorized_at,omitempty"`
}
```

## 6. Go Handler 签名

```go
package handlers

import "net/http"

// POST /api/feishu/device/start
func (h *FeishuHandler) StartDeviceOAuth(w http.ResponseWriter, r *http.Request)

// POST /api/feishu/device/complete
func (h *FeishuHandler) CompleteDeviceOAuth(w http.ResponseWriter, r *http.Request)

// GET /api/feishu/device/status?multica_user_id=xxx
func (h *FeishuHandler) GetDeviceOAuthStatus(w http.ResponseWriter, r *http.Request)
```

## 7. Handler 责任边界

### 7.1 StartDeviceOAuth

1. 校验 `multica_user_id` 非空、字符白名单。
2. 调 `02_user_provision.sh`（幂等）。
3. 调 `03_user_oauth_start.sh`。
4. 透传脚本 JSON 到 API response。
5. 记录审计日志：
   - who: multica_user_id
   - action: start_device_oauth
   - result: success/fail

### 7.2 CompleteDeviceOAuth

1. 校验 `multica_user_id` + `device_code`。
2. 调 `04_user_oauth_complete.sh`（内部 180s timeout）。
3. 脚本已落 PoC mapping；正式版同时 upsert PostgreSQL。
4. 返回绑定结果（open_id / name / scopes）。
5. 审计日志记录 complete 成败。

### 7.3 GetDeviceOAuthStatus

1. 参数：`multica_user_id`（query）。
2. 查 PostgreSQL binding 是否存在。
3. 若存在：读取 `home`，执行 `HOME=<home> lark-cli auth status`。
4. 统一 token 状态为：`valid|invalid|no_token|unknown`。
5. 输出状态 JSON。

## 8. PostgreSQL Schema

```sql
CREATE TABLE IF NOT EXISTS multica_lark_bindings (
    id BIGSERIAL PRIMARY KEY,
    multica_user_id TEXT NOT NULL,
    lark_user_open_id TEXT NOT NULL,
    lark_user_name TEXT NOT NULL,
    lark_app_id TEXT NOT NULL,
    user_home TEXT NOT NULL,
    token_state TEXT NOT NULL DEFAULT 'unknown',
    scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_token_check_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
```

### 8.1 唯一约束

```sql
ALTER TABLE multica_lark_bindings
    ADD CONSTRAINT uq_multica_lark_bindings_multica_user_id
    UNIQUE (multica_user_id);

ALTER TABLE multica_lark_bindings
    ADD CONSTRAINT uq_multica_lark_bindings_lark_user_open_id
    UNIQUE (lark_user_open_id);
```

说明：

1. 一个 multica 用户只能绑定一个飞书身份。
2. 一个飞书身份不能被多个 multica 用户重复绑定。

### 8.2 索引

```sql
CREATE INDEX IF NOT EXISTS idx_multica_lark_bindings_token_state
    ON multica_lark_bindings (token_state)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_multica_lark_bindings_updated_at
    ON multica_lark_bindings (updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_multica_lark_bindings_app_id
    ON multica_lark_bindings (lark_app_id)
    WHERE deleted_at IS NULL;
```

### 8.3 更新时间触发器（建议）

```sql
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_multica_lark_bindings_updated_at
ON multica_lark_bindings;

CREATE TRIGGER trg_touch_multica_lark_bindings_updated_at
BEFORE UPDATE ON multica_lark_bindings
FOR EACH ROW
EXECUTE PROCEDURE touch_updated_at();
```

## 9. Repository 层接口建议

```go
package repo

import "context"

type LarkBinding struct {
    ID               int64
    MulticaUserID    string
    LarkUserOpenID   string
    LarkUserName     string
    LarkAppID        string
    UserHome         string
    TokenState       string
    Scopes           []string
    LastAuthorizedAt string
    LastTokenCheckAt *string
    CreatedAt        string
    UpdatedAt        string
}

type LarkBindingRepo interface {
    UpsertByMulticaUserID(ctx context.Context, b LarkBinding) error
    GetByMulticaUserID(ctx context.Context, multicaUserID string) (*LarkBinding, error)
    UpdateTokenState(ctx context.Context, multicaUserID, tokenState string) error
}
```

## 10. 脚本调用封装（Go）

### 10.1 基础执行器

```go
package shell

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "os/exec"
    "time"
)

type JSONResult map[string]any

func RunJSON(ctx context.Context, bin string, args ...string) (JSONResult, string, error) {
    cmd := exec.CommandContext(ctx, bin, args...)
    var out bytes.Buffer
    var errBuf bytes.Buffer
    cmd.Stdout = &out
    cmd.Stderr = &errBuf

    err := cmd.Run()
    stderr := errBuf.String()
    if err != nil {
        return nil, stderr, fmt.Errorf("run %s failed: %w", bin, err)
    }

    var payload JSONResult
    if uerr := json.Unmarshal(out.Bytes(), &payload); uerr != nil {
        return nil, stderr, fmt.Errorf("invalid json stdout: %w", uerr)
    }
    return payload, stderr, nil
}

func TimeoutCtx(parent context.Context, seconds int) (context.Context, context.CancelFunc) {
    return context.WithTimeout(parent, time.Duration(seconds)*time.Second)
}
```

### 10.2 在 Handler 内使用

1. start：`02` + `03`。
2. complete：`04`。
3. status：可直接查 DB + 命令行 status。

## 11. Agent Runtime 接入方案

### 11.1 方案 A：daemon 全局 wrapper（推荐）

1. daemon 启动参数增加：`--agent-wrapper /tmp/lark_multi_user/05_agent_spawn.sh`
2. agent runtime 在执行 lark skill 时，统一由 wrapper 注入 user context。
3. 调用形式：
   - `/tmp/lark_multi_user/05_agent_spawn.sh <multica_user_id> im send --chat-id ...`
4. 优点：
   - 接入集中。
   - token 校验与重授权提示统一。
   - 便于审计与灰度。

### 11.2 方案 B：lark skill metadata 注入 HOME

1. skill metadata 增加模板变量：`env: { HOME: "{{multica_user_home}}" }`
2. runtime 先查 binding，解析 HOME 后直接起 lark-cli。
3. 优点：路径更短、少一层 shell。
4. 风险：每个 skill 都要保持一致，容易漏。

### 11.3 推荐结论

1. PoC 与首版生产先上方案 A。
2. 方案 B 作为后续性能优化或精细化控制选项。

## 12. 错误码约定

### 12.1 API 错误码

1. `INVALID_ARGUMENT`
2. `PROVISION_FAILED`
3. `DEVICE_START_FAILED`
4. `DEVICE_COMPLETE_TIMEOUT`
5. `DEVICE_COMPLETE_FAILED`
6. `BINDING_NOT_FOUND`
7. `TOKEN_INVALID`
8. `INTERNAL_ERROR`

### 12.2 JSON 错误结构

```json
{
  "ok": false,
  "error": "TOKEN_INVALID",
  "message": "user must re-auth",
  "request_id": "req_xxx"
}
```

## 13. 安全与审计

1. 文件权限：
   - `/var/lib/multica/user-homes` 700。
   - `mc-user-*` 700。
   - `user_mapping.json` 600。
2. 禁止在日志打印：
   - access token
   - refresh token
   - master key 内容
3. 审计字段建议：
   - `request_id`
   - `multica_user_id`
   - `lark_user_open_id`
   - `action`
   - `result`
   - `latency_ms`

## 14. 并发与幂等

1. `02_user_provision.sh` 必须幂等。
2. `complete` 需要防重复提交：
   - 可基于 `(multica_user_id, device_code)` 做短时幂等键。
3. DB upsert 用事务。
4. 同一用户并发 complete 时以最后一次成功为准。

## 15. 迁移策略（PoC -> 正式）

1. PoC 阶段：脚本写 `user_mapping.json`。
2. 正式阶段：
   - complete 成功后先写 DB，再异步回写 JSON（可选）。
   - status 以 DB 为准，CLI 为校验。
3. 灰度方式：
   - 先 10% 用户。
   - 再 50%。
   - 再全量。

## 16. 观测指标

1. `feishu_device_start_total{result}`
2. `feishu_device_complete_total{result}`
3. `feishu_device_complete_latency_ms`
4. `feishu_token_invalid_total`
5. `feishu_agent_spawn_total{result}`

## 17. 最小联调清单

1. 执行 `01_mini_init.sh` 成功。
2. 触发 `start`，拿到 `device_code + qr_ascii`。
3. 手机扫码授权。
4. 触发 `complete`，拿到 `lark_user_open_id`。
5. 运行 wrapper 执行 `lark-cli auth status` 成功。
6. 运行 wrapper 执行一个实际命令（如 `im` 相关）验证身份。

