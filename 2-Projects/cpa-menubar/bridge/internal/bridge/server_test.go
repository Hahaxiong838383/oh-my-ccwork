package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testDesktopToken = "0123456789abcdef0123456789abcdef"

func TestProtectedEndpointsRequireBearerToken(t *testing.T) {
	server := newTestServer(t, t.TempDir())

	for _, header := range []string{"", testDesktopToken, "Basic " + testDesktopToken, "Bearer wrong"} {
		request := httptest.NewRequest(http.MethodGet, "/desktop/v1/summary", nil)
		request.Header.Set("Authorization", header)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("header %q returned %d, want 401", header, response.Code)
		}
	}

	request := httptest.NewRequest(http.MethodGet, "/desktop/v1/summary", nil)
	request.Header.Set("Authorization", "bearer "+testDesktopToken)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid bearer token returned %d", response.Code)
	}
}

func TestAccountsResponseDoesNotLeakCredentials(t *testing.T) {
	authDir := t.TempDir()
	secretValues := []string{"access-secret", "refresh-secret", "id-secret"}
	payload := map[string]any{
		"type":          "codex",
		"email":         "person@example.com",
		"account_id":    "account-secret",
		"access_token":  secretValues[0],
		"refresh_token": secretValues[1],
		"id_token":      secretValues[2],
		"disabled":      true,
	}
	writeFixture(t, filepath.Join(authDir, "codex.json"), payload)
	server := newTestServer(t, authDir)

	request := httptest.NewRequest(http.MethodGet, "/desktop/v1/accounts", nil)
	request.Header.Set("Authorization", "Bearer "+testDesktopToken)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("accounts returned %d: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, secret := range append(secretValues, "account-secret", "person@example.com") {
		if strings.Contains(body, secret) {
			t.Fatalf("response leaked %q: %s", secret, body)
		}
	}
	if !strings.Contains(body, "pe***@example.com") {
		t.Fatalf("response did not contain masked email: %s", body)
	}
}

func TestSanitizeUsageUsesAllowlistAndRemovesSensitiveNestedFields(t *testing.T) {
	input := []byte(`{
		"plan_type":"plus",
		"rate_limit":{"primary_window":{"used_percent":42,"access_token":"secret"}},
		"email":"person@example.com",
		"access_token":"top-secret",
		"other":{"value":1}
	}`)
	sanitized, err := sanitizeUsage(input)
	if err != nil {
		t.Fatal(err)
	}
	body := string(sanitized)
	for _, forbidden := range []string{"secret", "person@example.com", "other", "access_token"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("sanitized usage contains %q: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `"used_percent":42`) {
		t.Fatalf("sanitized usage lost allowed data: %s", body)
	}
}

func TestOAuthSessionRejectsExpiredState(t *testing.T) {
	server := newTestServer(t, t.TempDir())
	server.sessions["expired"] = &oauthSession{
		State:     "expired",
		Verifier:  "verifier",
		ExpiresAt: time.Now().Add(-time.Minute),
		Status:    "pending",
	}

	request := httptest.NewRequest(http.MethodPost, "/desktop/v1/oauth/codex/callback", strings.NewReader(`{"state":"expired","code":"code"}`))
	request.Header.Set("Authorization", "Bearer "+testDesktopToken)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("expired OAuth state returned %d", response.Code)
	}
}

func TestExchangeAndSavePreservesOperationalFields(t *testing.T) {
	authDir := t.TempDir()
	existingPath := filepath.Join(authDir, "codex-existing.json")
	writeFixture(t, existingPath, map[string]any{
		"account_id":      "acct-1",
		"priority":        9,
		"excluded-models": []string{"example-model"},
		"prefix":          "preferred",
		"proxy_url":       "http://127.0.0.1:9999",
	})

	server := newTestServer(t, authDir)
	server.client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != codexTokenURL {
			t.Fatalf("unexpected token URL: %s", request.URL)
		}
		response := tokenResponse{
			AccessToken:  "new-access",
			RefreshToken: "new-refresh",
			IDToken:      testJWT(t, "person@example.com", "acct-1", "plus"),
			ExpiresIn:    3600,
		}
		data, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(string(data))),
			Header:     make(http.Header),
		}, nil
	})}

	masked, err := server.exchangeAndSave(context.Background(), "code", "verifier")
	if err != nil {
		t.Fatal(err)
	}
	if masked != "pe***@example.com" {
		t.Fatalf("masked email = %q", masked)
	}
	data, err := os.ReadFile(existingPath)
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	if err = json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved["access_token"] != "new-access" || saved["refresh_token"] != "new-refresh" {
		t.Fatalf("new credentials not saved")
	}
	if saved["priority"] != float64(9) || saved["prefix"] != "preferred" || saved["proxy_url"] != "http://127.0.0.1:9999" {
		t.Fatalf("operational fields not preserved: %#v", saved)
	}
	info, err := os.Stat(existingPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("auth file mode = %o, want 600", info.Mode().Perm())
	}
}

func TestReadLimitedRejectsOversizedResponses(t *testing.T) {
	if _, err := readLimited(strings.NewReader("12345"), 4); err == nil {
		t.Fatal("expected oversized response error")
	}
	data, err := readLimited(strings.NewReader("1234"), 4)
	if err != nil || string(data) != "1234" {
		t.Fatalf("exact-limit response = %q, %v", data, err)
	}
}

func newTestServer(t *testing.T, authDir string) *Server {
	t.Helper()
	server, err := NewServer(Config{
		AuthDir:      authDir,
		DesktopToken: testDesktopToken,
		CLIProxyURL:  "http://127.0.0.1:1",
		RouterURL:    "http://127.0.0.1:1",
		UsageTimeout: time.Second,
		OAuthTimeout: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func writeFixture(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func testJWT(t *testing.T, email, accountID, plan string) string {
	t.Helper()
	payload := map[string]any{
		"email": email,
		"exp":   time.Now().Add(time.Hour).Unix(),
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": accountID,
			"chatgpt_plan_type":  plan,
		},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	return encode([]byte(`{"alg":"none"}`)) + "." + encode(data) + ".signature"
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
