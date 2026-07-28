package main

import (
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
