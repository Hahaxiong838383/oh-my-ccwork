package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestLoadConfigDefaultsBodyLimitTo64MiB(t *testing.T) {
	path := t.TempDir() + "/router.json"
	if err := os.WriteFile(path, []byte(`{"default_backend":{"base_url":"http://127.0.0.1:8317/v1"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BodyLimitBytes != 64<<20 {
		t.Fatalf("body limit = %d, want %d", cfg.BodyLimitBytes, 64<<20)
	}
}

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

func TestImagesForwardsBodyAndReplacesAuthorization(t *testing.T) {
	type upstreamRequest struct {
		Path          string
		Query         string
		Authorization string
		ContentType   string
		Body          string
	}
	requestCh := make(chan upstreamRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read upstream body: %v", err)
		}
		requestCh <- upstreamRequest{
			Path:          r.URL.Path,
			Query:         r.URL.RawQuery,
			Authorization: r.Header.Get("Authorization"),
			ContentType:   r.Header.Get("Content-Type"),
			Body:          string(body),
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Upstream", "image")
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{"data":[{"b64_json":"test"}]}`)
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
		},
		clientKeys: map[string]struct{}{"client-key": {}},
		httpClient: upstream.Client(),
	}

	payload := `{"model":"gpt-image-2","prompt":"draw a blue square"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations?response_format=b64_json", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.handleImages(recorder, req)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusCreated)
	}
	if recorder.Header().Get("X-Upstream") != "image" {
		t.Fatalf("missing upstream response header: %#v", recorder.Header())
	}
	got := <-requestCh
	if got.Path != "/v1/images/generations" || got.Query != "response_format=b64_json" {
		t.Fatalf("upstream target = %s?%s", got.Path, got.Query)
	}
	if got.Authorization != "Bearer upstream-key" {
		t.Fatalf("authorization = %q, want backend key", got.Authorization)
	}
	if got.ContentType != "application/json" || got.Body != payload {
		t.Fatalf("content type/body = %q / %q", got.ContentType, got.Body)
	}
}

func TestImageEditsPreservesMultipartContentType(t *testing.T) {
	contentTypeCh := make(chan string, 1)
	bodyCh := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read upstream body: %v", err)
		}
		contentTypeCh <- r.Header.Get("Content-Type")
		bodyCh <- string(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			BodyLimitBytes: 1 << 20,
			DefaultBackend: Candidate{BaseURL: upstream.URL + "/v1", APIKey: "upstream-key"},
		},
		clientKeys: map[string]struct{}{"client-key": {}},
		httpClient: upstream.Client(),
	}

	payload := "--boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-image-2\r\n--boundary--\r\n"
	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("Content-Type", "multipart/form-data; boundary=boundary")
	recorder := httptest.NewRecorder()

	server.handleImages(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := <-contentTypeCh; got != "multipart/form-data; boundary=boundary" {
		t.Fatalf("content type = %q", got)
	}
	if got := <-bodyCh; got != payload {
		t.Fatalf("body = %q", got)
	}
}

func TestImagesRejectsUnauthorizedAndOversizedRequests(t *testing.T) {
	server := &Server{
		cfg:        Config{BodyLimitBytes: 4},
		clientKeys: map[string]struct{}{"client-key": {}},
	}

	unauthorized := httptest.NewRecorder()
	server.handleImages(unauthorized, httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader("{}")))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	oversizedReq := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader("12345"))
	oversizedReq.Header.Set("Authorization", "Bearer client-key")
	oversized := httptest.NewRecorder()
	server.handleImages(oversized, oversizedReq)
	if oversized.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d", oversized.Code)
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
