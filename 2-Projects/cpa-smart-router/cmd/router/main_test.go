package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDefaultBackendReturnsRetryableUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		io.WriteString(w, `{"error":{"message":"no auth available"}}`)
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			BodyLimitBytes: 1 << 20,
			DefaultBackend: Candidate{
				ID:      "cpa-mixed",
				BaseURL: upstream.URL + "/v1",
				APIKey:  "upstream-key",
			},
			Routes: map[string]Route{},
		},
		clientKeys: map[string]struct{}{"client-key": {}},
		states:     map[string]*ProviderState{"cpa-mixed": {}},
		bindings:   map[string]SessionBinding{},
		httpClient: upstream.Client(),
		metricCh:   make(chan MetricEvent, 1),
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5.6-luna","input":"ping"}`))
	req.Header.Set("Authorization", "Bearer client-key")
	recorder := httptest.NewRecorder()

	server.handleLLM(recorder, req)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	if !strings.Contains(recorder.Body.String(), "no auth available") {
		t.Fatalf("body = %q, want upstream error", recorder.Body.String())
	}
	metric := <-server.metricCh
	if metric.Status != http.StatusServiceUnavailable || metric.ProviderID != "cpa-mixed" {
		t.Fatalf("metric = %#v", metric)
	}
}

func TestModelsForwardsClientVersionQuery(t *testing.T) {
	queryCh := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queryCh <- r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"models":[]}`)
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			DefaultBackend: Candidate{
				ID:      "cpa-mixed",
				BaseURL: upstream.URL + "/v1",
				APIKey:  "upstream-key",
			},
		},
		clientKeys: map[string]struct{}{"client-key": {}},
		httpClient: upstream.Client(),
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.145.0&include_hidden=true", nil)
	req.Header.Set("Authorization", "Bearer client-key")
	recorder := httptest.NewRecorder()

	server.handleModels(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := <-queryCh; got != "client_version=0.145.0&include_hidden=true" {
		t.Fatalf("query = %q, want client version query", got)
	}
}

func TestGrok46LatestRouteRewritesToCanonicalModel(t *testing.T) {
	modelCh := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read upstream body: %v", err)
		}
		var payload map[string]any
		if err = json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		modelCh <- payload["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"chatcmpl-test","model":"grok-4.6-build","choices":[{"message":{"role":"assistant","content":"OK"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			BodyLimitBytes: 1 << 20,
			Routes: map[string]Route{
				"grok-4.6-latest": {
					Candidates: []Candidate{{
						ID:      "cpa-grok46",
						BaseURL: upstream.URL + "/v1",
						APIKey:  "upstream-key",
						Model:   "grok-4.6",
					}},
				},
			},
		},
		clientKeys: map[string]struct{}{"client-key": {}},
		states:     map[string]*ProviderState{"cpa-grok46": {}},
		bindings:   map[string]SessionBinding{},
		httpClient: upstream.Client(),
		metricCh:   make(chan MetricEvent, 1),
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"grok-4.6-latest","messages":[{"role":"user","content":"ping"}]}`))
	req.Header.Set("Authorization", "Bearer client-key")
	recorder := httptest.NewRecorder()

	server.handleLLM(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if got := <-modelCh; got != "grok-4.6" {
		t.Fatalf("upstream model = %q, want grok-4.6", got)
	}
	metric := <-server.metricCh
	if metric.RouteModel != "grok-4.6-latest" || metric.ProviderID != "cpa-grok46" || metric.UpstreamModel != "grok-4.6-build" {
		t.Fatalf("metric = %#v", metric)
	}
}

func TestExtractUsageFromJSONSupportsChatCompletions(t *testing.T) {
	usage, ok := extractUsageFromJSON([]byte(`{"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`))
	if !ok {
		t.Fatal("extractUsageFromJSON returned no usage")
	}
	if usage != (usageInfo{Prompt: 11, Completion: 7, Total: 18}) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestExtractUsageFromJSONSupportsResponses(t *testing.T) {
	usage, ok := extractUsageFromJSON([]byte(`{"usage":{"input_tokens":200,"output_tokens":74,"total_tokens":274}}`))
	if !ok {
		t.Fatal("extractUsageFromJSON returned no usage")
	}
	if usage != (usageInfo{Prompt: 200, Completion: 74, Total: 274}) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestExtractUsageFromJSONSupportsNestedResponseEvent(t *testing.T) {
	usage, ok := extractUsageFromJSON([]byte(`{"type":"response.completed","response":{"usage":{"input_tokens":31,"output_tokens":13,"total_tokens":44}}}`))
	if !ok {
		t.Fatal("extractUsageFromJSON returned no usage")
	}
	if usage != (usageInfo{Prompt: 31, Completion: 13, Total: 44}) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestExtractSSEUsageSupportsNestedResponseEvent(t *testing.T) {
	usage, _, ok := extractSSEUsage([]byte(`data: {"type":"response.completed","response":{"usage":{"input_tokens":31,"output_tokens":13,"total_tokens":44}}}`))
	if !ok {
		t.Fatal("extractSSEUsage returned no usage")
	}
	if usage != (usageInfo{Prompt: 31, Completion: 13, Total: 44}) {
		t.Fatalf("usage = %#v", usage)
	}
}
