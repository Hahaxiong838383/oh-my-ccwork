package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestUsageStoreAggregatesTodayByAccount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	store, err := newUsageStore(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	records := []nativeUsageRecord{
		{
			Timestamp:           now.Add(-time.Hour),
			LatencyMS:           900,
			TTFTMS:              300,
			AuthIndex:           "account-a",
			Provider:            "codex",
			Model:               "gpt-5.5",
			ServiceTier:         "priority",
			ResponseServiceTier: "default",
			Tokens: nativeUsageTokens{
				InputTokens:         100,
				OutputTokens:        50,
				ReasoningTokens:     20,
				CacheReadTokens:     40,
				CacheCreationTokens: 10,
				TotalTokens:         150,
			},
		},
		{
			Timestamp:           now.Add(-30 * time.Minute),
			LatencyMS:           1_100,
			TTFTMS:              500,
			AuthIndex:           "account-a",
			Provider:            "codex",
			Model:               "gpt-5.5",
			ServiceTier:         "priority",
			ResponseServiceTier: "priority",
			Failed:              true,
			Fail: struct {
				StatusCode int `json:"status_code"`
			}{StatusCode: http.StatusTooManyRequests},
		},
		{
			Timestamp: now.Add(-time.Hour),
			AuthIndex: "xai-account",
			Provider:  "xai",
			Model:     "grok-4.3",
			Tokens: nativeUsageTokens{
				InputTokens:  600,
				OutputTokens: 399,
				TotalTokens:  999,
			},
		},
		{
			Timestamp: now.Add(-25 * time.Hour),
			Provider:  "codex",
			Tokens:    nativeUsageTokens{TotalTokens: 777},
		},
	}
	if err = store.add(records, now); err != nil {
		t.Fatal(err)
	}

	total, accounts := store.snapshot(now)
	if total.Requests != 2 || total.Successes != 1 || total.Errors != 1 {
		t.Fatalf("unexpected totals: %+v", total)
	}
	if total.TotalTokens != 150 || total.ReasoningTokens != 20 || total.CacheReadTokens != 40 {
		t.Fatalf("unexpected token totals: %+v", total)
	}
	if total.AverageLatencyMS != 1_000 || total.AverageTTFTMS != 400 {
		t.Fatalf("unexpected latency totals: %+v", total)
	}
	if total.FastRequested != 2 || total.FastActual != 1 || total.TopModel != "gpt-5.5" {
		t.Fatalf("unexpected fast/model totals: %+v", total)
	}
	account := accounts["account-a"]
	if account.Requests != 2 || account.LastErrorStatus != http.StatusTooManyRequests {
		t.Fatalf("unexpected account usage: %+v", account)
	}
	xaiAccount := accounts["xai-account"]
	if xaiAccount.Requests != 1 || xaiAccount.TotalTokens != 999 || xaiAccount.TopModel != "grok-4.3" {
		t.Fatalf("unexpected xAI account usage: %+v", xaiAccount)
	}

	reloaded, err := newUsageStore(path)
	if err != nil {
		t.Fatal(err)
	}
	reloadedTotal, _ := reloaded.snapshot(now)
	if reloadedTotal.Requests != total.Requests || reloadedTotal.TotalTokens != total.TotalTokens {
		t.Fatalf("reloaded totals = %+v, want %+v", reloadedTotal, total)
	}
}

func TestUsageCollectorReadsManagementQueue(t *testing.T) {
	now := time.Now()
	recordTimestamp := now.Add(-time.Minute).UTC().Format(time.RFC3339)
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("Authorization") != "Bearer management-secret" {
			t.Fatal("missing management authorization")
		}
		response.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			_, _ = response.Write([]byte(fmt.Sprintf(`[{"timestamp":%q,"provider":"codex","auth_index":"account-a","model":"gpt-5.5","latency_ms":600,"ttft_ms":200,"tokens":{"input_tokens":10,"output_tokens":5,"total_tokens":15},"fail":{"status_code":200}}]`, recordTimestamp)))
			return
		}
		_, _ = response.Write([]byte(`[]`))
	}))
	defer upstream.Close()

	store, err := newUsageStore(filepath.Join(t.TempDir(), "usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	collector := newUsageCollector(Config{
		CLIProxyURL:           upstream.URL,
		CLIProxyManagementKey: "management-secret",
		UsagePollInterval:     time.Second,
	}, upstream.Client(), store)
	collector.poll(context.Background())

	status, message := collector.publicStatus()
	if status != "ok" || message != "" {
		t.Fatalf("collector status = %q, %q", status, message)
	}
	if requests != 1 {
		t.Fatalf("request count = %d, want 1", requests)
	}
	total, _ := store.snapshot(now)
	if total.Requests != 1 || total.TotalTokens != 15 {
		t.Fatalf("unexpected collected usage: %+v", total)
	}
}

func TestAuthRuntimeIndexMatchesCLIProxyAlgorithm(t *testing.T) {
	authDir := t.TempDir()
	for _, testCase := range []struct {
		provider string
		fileName string
	}{
		{provider: "codex", fileName: "codex.json"},
		{provider: "xai", fileName: "xai.json"},
	} {
		path := filepath.Join(authDir, testCase.fileName)
		seed := testCase.provider + ":" + path
		digest := sha256.Sum256([]byte(seed))
		want := hex.EncodeToString(digest[:8])
		if got := authRuntimeIndex(testCase.provider, authDir, testCase.fileName); got != want {
			t.Fatalf("%s auth index = %q, want %q", testCase.provider, got, want)
		}
	}
}
