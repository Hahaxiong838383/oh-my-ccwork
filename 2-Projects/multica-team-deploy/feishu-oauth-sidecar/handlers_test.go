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
		if err := os.MkdirAll(filepath.Join(userHomes, withUserHome), 0o755); err != nil {
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
	return s.Router()
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

	t.Run("no mapping but home exists", func(t *testing.T) {
		r := &mockRunner{resp: map[string]mockResp{}}
		h := newTestHandler(t, r, "[]", "u2")
		req := httptest.NewRequest(http.MethodGet, "/api/feishu/device/status?multica_user_id=u2", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200 got %d", rr.Code)
		}
		body := parseBody(t, rr)
		if body["token_status"] != "not_authorized" {
			t.Fatalf("unexpected token_status: %v", body["token_status"])
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
