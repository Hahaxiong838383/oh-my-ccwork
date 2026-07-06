package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Listen          string           `json:"listen"`
	ClientAPIKeyEnv string           `json:"client_api_key_env"`
	ClientAPIKeys   []string         `json:"client_api_keys"`
	BodyLimitBytes  int64            `json:"body_limit_bytes"`
	MaxRetries      int              `json:"max_retries"`
	MetricsPath     string           `json:"metrics_path"`
	DefaultBackend  Candidate        `json:"default_backend"`
	Routes          map[string]Route `json:"routes"`
}

type Route struct {
	Sticky     bool        `json:"sticky"`
	Candidates []Candidate `json:"candidates"`
}

type Candidate struct {
	ID              string `json:"id"`
	BaseURL         string `json:"base_url"`
	APIKeyEnv       string `json:"api_key_env"`
	APIKey          string `json:"api_key"`
	Model           string `json:"model"`
	Priority        int    `json:"priority"`
	DailyTokenLimit int64  `json:"daily_token_limit"`
}

type ProviderState struct {
	Successes     int64
	Failures      int64
	Consecutive   int
	LatencyEWMA   float64
	TokensToday   int64
	TokenDay      string
	CooldownUntil time.Time
}

type SessionBinding struct {
	ProviderID string
	ExpiresAt  time.Time
}

type MetricEvent struct {
	TS            string `json:"ts"`
	Path          string `json:"path"`
	RouteModel    string `json:"route_model"`
	ProviderID    string `json:"provider_id"`
	UpstreamModel string `json:"upstream_model,omitempty"`
	Status        int    `json:"status"`
	LatencyMS     int64  `json:"latency_ms"`
	InputTokens   int64  `json:"input_tokens,omitempty"`
	OutputTokens  int64  `json:"output_tokens,omitempty"`
	TotalTokens   int64  `json:"total_tokens,omitempty"`
	Error         string `json:"error,omitempty"`
}

type Server struct {
	cfg        Config
	clientKeys map[string]struct{}
	states     map[string]*ProviderState
	bindings   map[string]SessionBinding
	mu         sync.Mutex
	httpClient *http.Client
	metricCh   chan MetricEvent
}

func main() {
	configPath := flag.String("config", "config/router.example.json", "config path")
	flag.Parse()
	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	server, err := NewServer(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer server.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", server.handleHealthz)
	mux.HandleFunc("/debug/state", server.handleDebugState)
	mux.HandleFunc("/v1/models", server.handleModels)
	mux.HandleFunc("/v1/chat/completions", server.handleLLM)
	mux.HandleFunc("/v1/responses", server.handleLLM)

	addr := cfg.Listen
	if addr == "" {
		addr = ":8327"
	}
	log.Printf("cpa-smart-router listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func loadConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.BodyLimitBytes <= 0 {
		cfg.BodyLimitBytes = 32 << 20
	}
	if cfg.MaxRetries < 0 {
		cfg.MaxRetries = 0
	}
	if cfg.MaxRetries > 2 {
		cfg.MaxRetries = 2
	}
	if cfg.MetricsPath == "" {
		cfg.MetricsPath = "router-metrics.jsonl"
	}
	return cfg, nil
}

func NewServer(cfg Config) (*Server, error) {
	keys := map[string]struct{}{}
	for _, key := range cfg.ClientAPIKeys {
		if key != "" {
			keys[key] = struct{}{}
		}
	}
	if cfg.ClientAPIKeyEnv != "" {
		if key := os.Getenv(cfg.ClientAPIKeyEnv); key != "" {
			keys[key] = struct{}{}
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("no client API key configured")
	}

	states := map[string]*ProviderState{}
	for _, route := range cfg.Routes {
		for _, c := range route.Candidates {
			states[c.ID] = &ProviderState{}
		}
	}
	if cfg.DefaultBackend.ID != "" {
		states[cfg.DefaultBackend.ID] = &ProviderState{}
	}

	s := &Server{
		cfg:        cfg,
		clientKeys: keys,
		states:     states,
		bindings:   map[string]SessionBinding{},
		httpClient: &http.Client{Timeout: 10 * time.Minute},
		metricCh:   make(chan MetricEvent, 1024),
	}
	go s.metricWriter(cfg.MetricsPath)
	return s, nil
}

func (s *Server) Close() { close(s.metricCh) }

func (s *Server) metricWriter(path string) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		log.Printf("metrics disabled: %v", err)
		for range s.metricCh {
		}
		return
	}
	defer file.Close()
	writer := bufio.NewWriterSize(file, 64*1024)
	defer writer.Flush()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case event, ok := <-s.metricCh:
			if !ok {
				return
			}
			line, _ := json.Marshal(event)
			writer.Write(line)
			writer.WriteByte('\n')
		case <-ticker.C:
			writer.Flush()
		}
	}
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, `{"ok":true}`)
}

func (s *Server) handleDebugState(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	type debugState struct {
		Successes     int64   `json:"successes"`
		Failures      int64   `json:"failures"`
		Consecutive   int     `json:"consecutive_failures"`
		LatencyEWMA   float64 `json:"latency_ewma_ms"`
		TokensToday   int64   `json:"tokens_today"`
		TokenDay      string  `json:"token_day"`
		CooldownUntil string  `json:"cooldown_until,omitempty"`
		Score         float64 `json:"score"`
	}
	result := map[string]debugState{}
	for _, route := range s.cfg.Routes {
		for _, candidate := range route.Candidates {
			s.ensureDayLocked(candidate.ID, now)
			state := s.states[candidate.ID]
			item := debugState{Score: s.scoreLocked(candidate, now)}
			if state != nil {
				item.Successes = state.Successes
				item.Failures = state.Failures
				item.Consecutive = state.Consecutive
				item.LatencyEWMA = state.LatencyEWMA
				item.TokensToday = state.TokensToday
				item.TokenDay = state.TokenDay
				if state.CooldownUntil.After(now) {
					item.CooldownUntil = state.CooldownUntil.Format(time.RFC3339)
				}
			}
			result[candidate.ID] = item
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.proxyRaw(w, r, s.cfg.DefaultBackend)
}

func (s *Server) handleLLM(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := readLimited(r.Body, s.cfg.BodyLimitBytes)
	if err != nil {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	model, _ := payload["model"].(string)
	if model == "" {
		http.Error(w, "missing model", http.StatusBadRequest)
		return
	}
	stream, _ := payload["stream"].(bool)

	route, ok := s.cfg.Routes[model]
	if !ok || len(route.Candidates) == 0 {
		candidate := s.cfg.DefaultBackend
		if candidate.Model == "" {
			candidate.Model = model
		}
		s.forwardWithCandidate(w, r, body, payload, model, candidate, stream)
		return
	}
	if r.URL.Path == "/v1/responses" {
		route.Sticky = true
	}

	sessionKey := s.sessionKey(r, payload, body)
	candidates := s.rankCandidates(route.Candidates)
	if route.Sticky && sessionKey != "" {
		if bound, ok := s.getBinding(sessionKey); ok {
			if c, found := findCandidate(candidates, bound); found && !s.isCooling(c.ID) {
				candidates = append([]Candidate{c}, removeCandidate(candidates, c.ID)...)
			}
		}
	}

	attempts := 1 + s.cfg.MaxRetries
	if attempts > len(candidates) {
		attempts = len(candidates)
	}
	var lastErr string
	for i := 0; i < attempts; i++ {
		candidate := candidates[i]
		status, retryable, metric := s.tryCandidate(w, r, body, payload, model, candidate, stream)
		metric.Path = r.URL.Path
		s.record(metric)
		if (status >= 200 && status < 500) || !retryable {
			if route.Sticky && sessionKey != "" && status >= 200 && status < 300 {
				s.setBinding(sessionKey, candidate.ID, time.Hour)
			}
			return
		}
		lastErr = metric.Error
	}
	http.Error(w, "all candidates failed: "+lastErr, http.StatusBadGateway)
}

func (s *Server) authorized(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	key := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	_, ok := s.clientKeys[key]
	return ok
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	limited := io.LimitReader(reader, limit+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("too large")
	}
	return data, nil
}

func (s *Server) tryCandidate(w http.ResponseWriter, r *http.Request, body []byte, payload map[string]any, routeModel string, candidate Candidate, stream bool) (int, bool, MetricEvent) {
	start := time.Now()
	upstreamBody, err := rewriteModel(body, payload, candidate.Model)
	if err != nil {
		return 0, false, s.metric(routeModel, candidate.ID, 0, start, "rewrite model: "+err.Error(), nil)
	}
	url := upstreamURL(candidate.BaseURL, r.URL.Path)
	req, err := http.NewRequestWithContext(context.Background(), r.Method, url, bytes.NewReader(upstreamBody))
	if err != nil {
		return 0, false, s.metric(routeModel, candidate.ID, 0, start, err.Error(), nil)
	}
	copyHeaders(req.Header, r.Header)
	key := candidate.APIKey
	if key == "" && candidate.APIKeyEnv != "" {
		key = os.Getenv(candidate.APIKeyEnv)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		s.updateState(candidate.ID, 0, time.Since(start), 0, err.Error())
		return 0, true, s.metric(routeModel, candidate.ID, 0, start, err.Error(), nil)
	}
	defer resp.Body.Close()

	if isRetryableStatus(resp.StatusCode) {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		errMsg := strings.TrimSpace(string(data))
		s.updateState(candidate.ID, resp.StatusCode, time.Since(start), 0, errMsg)
		return resp.StatusCode, true, s.metric(routeModel, candidate.ID, resp.StatusCode, start, errMsg, nil)
	}

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	var responseBody []byte
	var usage usageInfo
	if stream {
		_, err = io.Copy(w, resp.Body)
	} else {
		responseBody, err = io.ReadAll(resp.Body)
		if err == nil {
			usage = extractUsage(responseBody)
			_, err = w.Write(responseBody)
		}
	}
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	s.updateState(candidate.ID, resp.StatusCode, time.Since(start), usage.Total, errMsg)
	metric := s.metric(routeModel, candidate.ID, resp.StatusCode, start, errMsg, &usage)
	metric.UpstreamModel = extractModel(responseBody)
	return resp.StatusCode, false, metric
}

func (s *Server) forwardWithCandidate(w http.ResponseWriter, r *http.Request, body []byte, payload map[string]any, routeModel string, candidate Candidate, stream bool) {
	_, _, metric := s.tryCandidate(w, r, body, payload, routeModel, candidate, stream)
	metric.Path = r.URL.Path
	s.record(metric)
}

func rewriteModel(body []byte, payload map[string]any, model string) ([]byte, error) {
	if model == "" {
		return body, nil
	}
	clone := make(map[string]any, len(payload))
	for k, v := range payload {
		clone[k] = v
	}
	clone["model"] = model
	return json.Marshal(clone)
}

func upstreamURL(baseURL, requestPath string) string {
	path := requestPath
	if strings.HasPrefix(path, "/v1/") {
		path = strings.TrimPrefix(path, "/v1")
	}
	return strings.TrimRight(baseURL, "/") + path
}

func copyHeaders(dst, src http.Header) {
	for k, vals := range src {
		lk := strings.ToLower(k)
		if lk == "authorization" || lk == "host" || lk == "content-length" {
			continue
		}
		for _, v := range vals {
			dst.Add(k, v)
		}
	}
}

func copyResponseHeaders(dst, src http.Header) {
	for k, vals := range src {
		lk := strings.ToLower(k)
		if lk == "content-length" || lk == "connection" {
			continue
		}
		for _, v := range vals {
			dst.Add(k, v)
		}
	}
}

func isRetryableStatus(status int) bool {
	switch status {
	case 403, 408, 429, 500, 502, 503, 504:
		return true
	}
	return false
}

func (s *Server) rankCandidates(candidates []Candidate) []Candidate {
	now := time.Now()
	ranked := append([]Candidate(nil), candidates...)
	s.mu.Lock()
	defer s.mu.Unlock()
	sort.SliceStable(ranked, func(i, j int) bool { return s.scoreLocked(ranked[i], now) > s.scoreLocked(ranked[j], now) })
	return ranked
}

func (s *Server) scoreLocked(c Candidate, now time.Time) float64 {
	s.ensureDayLocked(c.ID, now)
	st := s.states[c.ID]
	if st == nil {
		return float64(c.Priority)
	}
	if st.CooldownUntil.After(now) {
		return -1e9
	}
	total := st.Successes + st.Failures
	health := 1.0
	if total > 0 {
		health = float64(st.Successes) / float64(total)
	}
	latency := 1.0
	if st.LatencyEWMA > 0 {
		latency = math.Max(0, 1-math.Min(st.LatencyEWMA/10000.0, 1))
	}
	quota := 1.0
	if c.DailyTokenLimit > 0 {
		quota = math.Max(0, 1-math.Min(float64(st.TokensToday)/float64(c.DailyTokenLimit), 1))
	}
	priority := math.Min(float64(c.Priority)/100.0, 1)
	return 100 * (0.35*health + 0.25*latency + 0.20*quota + 0.20*priority)
}

func (s *Server) isCooling(providerID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.states[providerID]
	return st != nil && st.CooldownUntil.After(time.Now())
}

func (s *Server) updateState(providerID string, status int, latency time.Duration, tokens int64, errMsg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureDayLocked(providerID, time.Now())
	st := s.states[providerID]
	if st == nil {
		st = &ProviderState{}
		s.states[providerID] = st
	}
	ms := float64(latency.Milliseconds())
	if st.LatencyEWMA == 0 {
		st.LatencyEWMA = ms
	} else {
		st.LatencyEWMA = 0.8*st.LatencyEWMA + 0.2*ms
	}
	st.TokensToday += tokens
	if status >= 200 && status < 500 && errMsg == "" {
		st.Successes++
		st.Consecutive = 0
		return
	}
	st.Failures++
	st.Consecutive++
	if st.Consecutive >= 5 {
		st.CooldownUntil = time.Now().Add(10 * time.Minute)
	} else if st.Consecutive >= 3 {
		st.CooldownUntil = time.Now().Add(2 * time.Minute)
	}
}

func (s *Server) ensureDayLocked(providerID string, now time.Time) {
	st := s.states[providerID]
	if st == nil {
		st = &ProviderState{}
		s.states[providerID] = st
	}
	day := cstDay(now)
	if st.TokenDay == "" {
		st.TokenDay = day
		return
	}
	if st.TokenDay != day {
		st.TokenDay = day
		st.TokensToday = 0
	}
}

func cstDay(now time.Time) string {
	loc := time.FixedZone("CST", 8*60*60)
	return now.In(loc).Format("2006-01-02")
}

func (s *Server) sessionKey(r *http.Request, payload map[string]any, body []byte) string {
	for _, header := range []string{"X-Session-ID", "Session_id", "X-Client-Request-Id"} {
		if v := strings.TrimSpace(r.Header.Get(header)); v != "" {
			return "h:" + header + ":" + v
		}
	}
	for _, key := range []string{"conversation_id", "previous_response_id"} {
		if v, ok := payload[key].(string); ok && v != "" {
			return "p:" + key + ":" + v
		}
	}
	if meta, ok := payload["metadata"].(map[string]any); ok {
		if v, ok := meta["user_id"].(string); ok && v != "" {
			return "m:user_id:" + v
		}
	}
	first := firstMessageHash(payload)
	client := clientKeyHash(r.Header.Get("Authorization"))
	if first != "" || client != "" {
		return "fallback:" + client + ":" + first
	}
	sum := sha256.Sum256(body)
	return "body:" + hex.EncodeToString(sum[:8])
}

func firstMessageHash(payload map[string]any) string {
	messages, ok := payload["messages"].([]any)
	if !ok || len(messages) == 0 {
		return ""
	}
	data, _ := json.Marshal(messages[0])
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}

func clientKeyHash(auth string) string {
	if auth == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(auth))
	return hex.EncodeToString(sum[:8])
}

func (s *Server) getBinding(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[key]
	if !ok || binding.ExpiresAt.Before(time.Now()) {
		return "", false
	}
	return binding.ProviderID, true
}

func (s *Server) setBinding(key, providerID string, ttl time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bindings[key] = SessionBinding{ProviderID: providerID, ExpiresAt: time.Now().Add(ttl)}
}

func findCandidate(candidates []Candidate, id string) (Candidate, bool) {
	for _, c := range candidates {
		if c.ID == id {
			return c, true
		}
	}
	return Candidate{}, false
}

func removeCandidate(candidates []Candidate, id string) []Candidate {
	out := make([]Candidate, 0, len(candidates))
	for _, c := range candidates {
		if c.ID != id {
			out = append(out, c)
		}
	}
	return out
}

type usageInfo struct{ Prompt, Completion, Total int64 }

func extractUsage(body []byte) usageInfo {
	var payload struct {
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			TotalTokens      int64 `json:"total_tokens"`
		} `json:"usage"`
	}
	json.Unmarshal(body, &payload)
	return usageInfo{Prompt: payload.Usage.PromptTokens, Completion: payload.Usage.CompletionTokens, Total: payload.Usage.TotalTokens}
}

func extractModel(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var payload struct {
		Model string `json:"model"`
	}
	json.Unmarshal(body, &payload)
	return payload.Model
}

func (s *Server) metric(routeModel, providerID string, status int, start time.Time, errMsg string, usage *usageInfo) MetricEvent {
	event := MetricEvent{TS: time.Now().Format(time.RFC3339), RouteModel: routeModel, ProviderID: providerID, Status: status, LatencyMS: time.Since(start).Milliseconds(), Error: errMsg}
	if usage != nil {
		event.InputTokens = usage.Prompt
		event.OutputTokens = usage.Completion
		event.TotalTokens = usage.Total
	}
	return event
}

func (s *Server) record(event MetricEvent) {
	select {
	case s.metricCh <- event:
	default:
		log.Printf("metric dropped: provider=%s", event.ProviderID)
	}
}

func (s *Server) proxyRaw(w http.ResponseWriter, r *http.Request, candidate Candidate) {
	url := upstreamURL(candidate.BaseURL, r.URL.Path)
	req, err := http.NewRequestWithContext(r.Context(), r.Method, url, nil)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	copyHeaders(req.Header, r.Header)
	key := candidate.APIKey
	if key == "" && candidate.APIKeyEnv != "" {
		key = os.Getenv(candidate.APIKeyEnv)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := s.httpClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
