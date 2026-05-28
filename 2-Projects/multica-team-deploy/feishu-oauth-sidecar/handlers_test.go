package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type mockResp struct {
	stdout string
	stderr string
	err    error
	delay  time.Duration
}

type mockRunner struct {
	mu    sync.Mutex
	resp  map[string]mockResp
	calls []string
}

func (m *mockRunner) Run(ctx context.Context, script string, args ...string) (RunResult, error) {
	key := callKey(script, args...)
	m.mu.Lock()
	r, ok := m.resp[key]
	m.calls = append(m.calls, key)
	m.mu.Unlock()
	if !ok {
		return RunResult{}, errors.New("unexpected call: " + key)
	}
	if r.delay > 0 {
		select {
		case <-time.After(r.delay):
		case <-ctx.Done():
			return RunResult{}, &ExecError{Script: script, Args: args, Timeout: true, ExitCode: -1, Cause: ctx.Err()}
		}
	}
	return RunResult{Stdout: r.stdout, Stderr: r.stderr}, r.err
}

func callKey(script string, args ...string) string {
	return script + "|" + strings.Join(args, "\x1f")
}

func newTestHandler(t *testing.T, runner ScriptRunner, mappingContent string, withUserHome string) http.Handler {
	t.Helper()
	return newTestHandlerWithMapping(t, runner, mappingContent, withUserHome).router
}

// testEnv 抓住 mapping 文件路径,方便测试断言 self-heal 后磁盘已写入.
type testEnv struct {
	router       http.Handler
	mappingFile  string
	userHomesDir string
}

func newTestHandlerWithMapping(t *testing.T, runner ScriptRunner, mappingContent string, withUserHome string) testEnv {
	t.Helper()
	dir := t.TempDir()
	mapping := filepath.Join(dir, "user_mapping.json")
	if err := os.WriteFile(mapping, []byte(mappingContent), 0o644); err != nil {
		t.Fatal(err)
	}
	userHomes := filepath.Join(dir, "homes")
	if err := os.MkdirAll(userHomes, 0o755); err != nil {
		t.Fatal(err)
	}
	if withUserHome != "" {
		// statusHandler 期望 mc-user-<id> 目录名 (handlers.go:336),
		// 所以测试同样用 mc-user-<id> 而不是裸 <id>
		if err := os.MkdirAll(filepath.Join(userHomes, "mc-user-"+withUserHome), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cfg := Config{
		Port:           "18090",
		ScriptsDir:     "/tmp/scripts",
		MappingFile:    mapping,
		UserHomesDir:   userHomes,
		AllowedOrigins: []string{"*"},
		Version:        "test",
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := NewServer(cfg, runner, logger)
	return testEnv{router: s.Router(), mappingFile: mapping, userHomesDir: userHomes}
}

// writeFakeLarkBin 创建一个 mock lark-cli 脚本,固定输出指定 JSON 后 0 退出.
// 用 t.Setenv 把 LARK_BIN 指过去,让 tryHealMapping 不需要真 lark-cli.
func writeFakeLarkBin(t *testing.T, jsonOut string, exitCode int) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "lark-cli-fake")
	// 用 heredoc 避免在 shell 里 escape 嵌套引号
	script := "#!/bin/sh\ncat <<'JSON_EOF'\n" + jsonOut + "\nJSON_EOF\n"
	if exitCode != 0 {
		script += "exit " + itoa(exitCode) + "\n"
	}
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func parseBody(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestStartEndpoint(t *testing.T) {
	t.Run("happy", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("02_user_provision.sh", "u1"): {stdout: `{"ok":true}`},
			callKey("03_user_oauth_start.sh", "u1"): {
				stdout: "[WARN] proxy detected\n" + `{"ok":true,"device_code":"dc","verification_url":"https://x","user_code":"uc","expires_in":600,"qr_ascii":"b64"}`,
			},
		}}
		h := newTestHandler(t, r, "[]", "")

		req := httptest.NewRequest(http.MethodPost, "/api/feishu/device/start", strings.NewReader(`{"multica_user_id":"u1"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("want 200 got %d", rr.Code)
		}
		body := parseBody(t, rr)
		if body["device_code"] != "dc" {
			t.Fatalf("unexpected device_code: %v", body["device_code"])
		}
	})

	t.Run("missing param", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{}}
		h := newTestHandler(t, r, "[]", "")
		req := httptest.NewRequest(http.MethodPost, "/api/feishu/device/start", strings.NewReader(`{"multica_user_id":""}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("want 400 got %d", rr.Code)
		}
	})

	t.Run("script fail", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("02_user_provision.sh", "u1"): {err: &ExecError{Script: "02_user_provision.sh", ExitCode: 1}},
		}}
		h := newTestHandler(t, r, "[]", "")
		req := httptest.NewRequest(http.MethodPost, "/api/feishu/device/start", strings.NewReader(`{"multica_user_id":"u1"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("want 500 got %d", rr.Code)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("02_user_provision.sh", "u1"): {err: &ExecError{Script: "02_user_provision.sh", Timeout: true, ExitCode: -1}},
		}}
		h := newTestHandler(t, r, "[]", "")
		req := httptest.NewRequest(http.MethodPost, "/api/feishu/device/start", strings.NewReader(`{"multica_user_id":"u1"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("want 500 got %d", rr.Code)
		}
	})
}

func TestCompleteEndpoint(t *testing.T) {
	t.Run("happy", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("04_user_oauth_complete.sh", "u1", "dc"): {stdout: `{"ok":true,"multicaUserId":"u1","larkUserOpenId":"ou_1","larkUserName":"bob","scopes":["im:message"]}`},
		}}
		h := newTestHandler(t, r, "[]", "")
		req := httptest.NewRequest(http.MethodPost, "/api/feishu/device/complete", strings.NewReader(`{"multica_user_id":"u1","device_code":"dc"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200 got %d", rr.Code)
		}
	})

	t.Run("missing param", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{}}
		h := newTestHandler(t, r, "[]", "")
		req := httptest.NewRequest(http.MethodPost, "/api/feishu/device/complete", strings.NewReader(`{"multica_user_id":"u1"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("want 400 got %d", rr.Code)
		}
	})

	t.Run("script fail", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("04_user_oauth_complete.sh", "u1", "dc"): {err: &ExecError{Script: "04_user_oauth_complete.sh", ExitCode: 2}},
		}}
		h := newTestHandler(t, r, "[]", "")
		req := httptest.NewRequest(http.MethodPost, "/api/feishu/device/complete", strings.NewReader(`{"multica_user_id":"u1","device_code":"dc"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("want 400 got %d", rr.Code)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("04_user_oauth_complete.sh", "u1", "dc"): {err: &ExecError{Script: "04_user_oauth_complete.sh", Timeout: true, ExitCode: -1}},
		}}
		h := newTestHandler(t, r, "[]", "")
		req := httptest.NewRequest(http.MethodPost, "/api/feishu/device/complete", strings.NewReader(`{"multica_user_id":"u1","device_code":"dc"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("want 400 got %d", rr.Code)
		}
	})
}

func TestStatusEndpoint(t *testing.T) {
	mapping := `[{"multica_user_id":"u1","lark_user_open_id":"ou_1","lark_user_name":"bob","home":"/h/u1","provisioned_at":"2026-05-27T10:46:09Z"}]`

	t.Run("happy", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("05_agent_spawn.sh", "u1", "auth", "status"): {stdout: `{"tokenStatus":"valid","expiresAt":"2026-05-27T20:46:09+08:00","scopes":["im:message"]}`},
		}}
		h := newTestHandler(t, r, mapping, "")
		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status?multica_user_id=u1", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200 got %d", rr.Code)
		}
		body := parseBody(t, rr)
		if body["bound"] != true {
			t.Fatalf("want bound true got %v", body["bound"])
		}
	})

	t.Run("missing param", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{}}
		h := newTestHandler(t, r, mapping, "")
		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("want 400 got %d", rr.Code)
		}
	})

	t.Run("script fail", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("05_agent_spawn.sh", "u1", "auth", "status"): {err: &ExecError{Script: "05_agent_spawn.sh", ExitCode: 3}},
		}}
		h := newTestHandler(t, r, mapping, "")
		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status?multica_user_id=u1", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("want 500 got %d", rr.Code)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{
			callKey("05_agent_spawn.sh", "u1", "auth", "status"): {err: &ExecError{Script: "05_agent_spawn.sh", Timeout: true, ExitCode: -1}},
		}}
		h := newTestHandler(t, r, mapping, "")
		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status?multica_user_id=u1", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("want 500 got %d", rr.Code)
		}
	})

	t.Run("no mapping but home exists self heal fails", func(t *testing.T) {
		// home 存在但 lark-cli 假 binary 报错 → 应该 fallback 返回 not_authorized
		t.Setenv("LARK_BIN", "/usr/bin/false")
		r := &mockRunner{resp: map[string]mockResp{}}
		h := newTestHandler(t, r, "[]", "u2")
		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status?multica_user_id=u2", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200 got %d", rr.Code)
		}
		body := parseBody(t, rr)
		if body["bound"] != false {
			t.Fatalf("want bound false got %v", body["bound"])
		}
		if body["token_status"] != "not_authorized" {
			t.Fatalf("unexpected token_status: %v", body["token_status"])
		}
	})

	t.Run("no mapping no home returns no_token", func(t *testing.T) {
		// mapping 空且 home 不存在 → no_token (跟 not_authorized 区分)
		t.Setenv("LARK_BIN", "/usr/bin/false")
		r := &mockRunner{resp: map[string]mockResp{}}
		h := newTestHandler(t, r, "[]", "")
		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status?multica_user_id=ughost", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200 got %d", rr.Code)
		}
		body := parseBody(t, rr)
		if body["token_status"] != "no_token" {
			t.Fatalf("want no_token got %v", body["token_status"])
		}
	})

	t.Run("self heal happy path", func(t *testing.T) {
		// home 存在 + lark-cli 返回 valid openId → tryHealMapping 写 mapping → 后续 05_agent_spawn 拿 token status
		fakeLark := writeFakeLarkBin(t, `{"identities":{"user":{"openId":"ou_healed_3","userName":"alice"}}}`, 0)
		t.Setenv("LARK_BIN", fakeLark)

		r := &mockRunner{resp: map[string]mockResp{
			callKey("05_agent_spawn.sh", "u3", "auth", "status"): {
				stdout: `{"tokenStatus":"valid","expiresAt":"2026-05-30T20:46:09+08:00","scopes":["im:message"]}`,
			},
		}}
		env := newTestHandlerWithMapping(t, r, "[]", "u3")

		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status?multica_user_id=u3", nil)
		rr := httptest.NewRecorder()
		env.router.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200 got %d body=%s", rr.Code, rr.Body.String())
		}
		body := parseBody(t, rr)
		if body["bound"] != true {
			t.Fatalf("want bound true got %v", body["bound"])
		}
		if body["lark_user_open_id"] != "ou_healed_3" {
			t.Fatalf("want ou_healed_3 got %v", body["lark_user_open_id"])
		}
		if body["token_status"] != "valid" {
			t.Fatalf("want token_status valid got %v", body["token_status"])
		}

		// 验证: self-heal 已把新 entry 持久化到 mapping 文件
		raw, err := os.ReadFile(env.mappingFile)
		if err != nil {
			t.Fatalf("read mapping after heal: %v", err)
		}
		var entries []map[string]any
		if err := json.Unmarshal(raw, &entries); err != nil {
			t.Fatalf("unmarshal mapping: %v", err)
		}
		if len(entries) != 1 || entries[0]["multica_user_id"] != "u3" || entries[0]["lark_user_open_id"] != "ou_healed_3" {
			t.Fatalf("mapping not self-healed correctly: %v", entries)
		}
	})

	t.Run("self heal fails when lark output missing openId", func(t *testing.T) {
		// lark-cli 返回 JSON 但没 openId → tryHealMapping 应失败 → fallback not_authorized,且 mapping 不该写
		fakeLark := writeFakeLarkBin(t, `{"identities":{"user":{"userName":"orphan"}}}`, 0)
		t.Setenv("LARK_BIN", fakeLark)
		r := &mockRunner{resp: map[string]mockResp{}}
		env := newTestHandlerWithMapping(t, r, "[]", "u4")

		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status?multica_user_id=u4", nil)
		rr := httptest.NewRecorder()
		env.router.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200 got %d", rr.Code)
		}
		body := parseBody(t, rr)
		if body["token_status"] != "not_authorized" {
			t.Fatalf("want not_authorized got %v", body["token_status"])
		}
		// mapping 文件应该保持 [] 不被脏写
		raw, _ := os.ReadFile(env.mappingFile)
		if strings.TrimSpace(string(raw)) != "[]" {
			t.Fatalf("mapping should remain empty, got: %s", raw)
		}
	})
}

func TestOAuthUIEndpoint(t *testing.T) {
	r := &mockRunner{resp: map[string]mockResp{}}
	h := newTestHandler(t, r, "[]", "")
	req := httptest.NewRequest(http.MethodGet, "/oauth-ui", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("want 200 got %d", rr.Code)
	}
	if got := rr.Header().Get("Content-Type"); !strings.Contains(got, "text/html") {
		t.Fatalf("unexpected content-type: %s", got)
	}
	if got := rr.Header().Get("Cache-Control"); !strings.Contains(got, "max-age=300") {
		t.Fatalf("unexpected cache-control: %s", got)
	}
	if !strings.Contains(rr.Body.String(), "飞书扫码授权") {
		t.Fatalf("unexpected body")
	}
}
