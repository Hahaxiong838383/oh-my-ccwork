package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"html/template"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Config struct {
	Listen           string           `json:"listen"`
	ClientAPIKeyEnv  string           `json:"client_api_key_env"`
	ClientAPIKeyEnvs []string         `json:"client_api_key_envs"`
	ClientAPIKeys    []string         `json:"client_api_keys"`
	BodyLimitBytes   int64            `json:"body_limit_bytes"`
	MaxRetries       int              `json:"max_retries"`
	MetricsPath      string           `json:"metrics_path"`
	SQLitePath       string           `json:"sqlite_path"`
	DashboardEnabled bool             `json:"dashboard_enabled"`
	BlockedModels    []string         `json:"blocked_models"`
	DefaultBackend   Candidate        `json:"default_backend"`
	Routes           map[string]Route `json:"routes"`
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
	TS            string              `json:"ts"`
	Path          string              `json:"path"`
	RouteModel    string              `json:"route_model"`
	ProviderID    string              `json:"provider_id"`
	UpstreamModel string              `json:"upstream_model,omitempty"`
	Status        int                 `json:"status"`
	LatencyMS     int64               `json:"latency_ms"`
	InputTokens   int64               `json:"input_tokens,omitempty"`
	OutputTokens  int64               `json:"output_tokens,omitempty"`
	TotalTokens   int64               `json:"total_tokens,omitempty"`
	Error         string              `json:"error,omitempty"`
	ResponseProbe *ResponseProbeEvent `json:"response_probe,omitempty"`
}

type ResponseProbeEvent struct {
	Stream                bool   `json:"stream"`
	StoreValue            string `json:"store_value"`
	ResponseID            string `json:"response_id,omitempty"`
	ParentResponseID      string `json:"parent_response_id,omitempty"`
	ParentSeen            bool   `json:"parent_seen"`
	ParentProviderID      string `json:"parent_provider_id,omitempty"`
	ParentAgeMS           int64  `json:"parent_age_ms,omitempty"`
	ProviderMatchesParent *bool  `json:"provider_matches_parent,omitempty"`
	CaptureStatus         string `json:"capture_status"`
	CaptureEvent          string `json:"capture_event,omitempty"`
	UpstreamErrorSample   string `json:"upstream_error_sample,omitempty"`
}

type responseCapture struct {
	ID     string
	Status string
	Event  string
}

type Server struct {
	cfg        Config
	clientKeys map[string]struct{}
	states     map[string]*ProviderState
	bindings   map[string]SessionBinding
	mu         sync.Mutex
	httpClient *http.Client
	metricCh   chan MetricEvent
	db         *sql.DB
	wg         sync.WaitGroup
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
	mux.HandleFunc("/debug/summary", server.handleDebugSummary)
	mux.HandleFunc("/dashboard", server.handleDashboard)
	mux.HandleFunc("/v1/models", server.handleModels)
	mux.HandleFunc("/v1/chat/completions", server.handleLLM)
	mux.HandleFunc("/v1/responses", server.handleLLM)
	mux.HandleFunc("/v1/images/generations", server.handleImages)
	mux.HandleFunc("/v1/images/edits", server.handleImages)

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
		cfg.BodyLimitBytes = 64 << 20
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
	for _, env := range cfg.ClientAPIKeyEnvs {
		if key := os.Getenv(env); key != "" {
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

	var db *sql.DB
	if cfg.SQLitePath != "" {
		var err error
		db, err = openMetricsDB(cfg.SQLitePath)
		if err != nil {
			return nil, err
		}
	}

	s := &Server{
		cfg:        cfg,
		clientKeys: keys,
		states:     states,
		bindings:   map[string]SessionBinding{},
		httpClient: &http.Client{Timeout: 10 * time.Minute},
		metricCh:   make(chan MetricEvent, 1024),
		db:         db,
	}
	s.wg.Add(1)
	go s.metricWriter(cfg.MetricsPath)
	return s, nil
}

func (s *Server) Close() {
	close(s.metricCh)
	s.wg.Wait()
	if s.db != nil {
		s.db.Close()
	}
}

func (s *Server) metricWriter(path string) {
	defer s.wg.Done()
	var file *os.File
	var writer *bufio.Writer
	if path != "" {
		var err error
		file, err = os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			log.Printf("jsonl metrics disabled: %v", err)
		} else {
			defer file.Close()
			writer = bufio.NewWriterSize(file, 64*1024)
			defer writer.Flush()
		}
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case event, ok := <-s.metricCh:
			if !ok {
				return
			}
			if writer != nil {
				line, _ := json.Marshal(event)
				writer.Write(line)
				writer.WriteByte('\n')
			}
			if s.db != nil {
				if err := insertMetric(s.db, event); err != nil {
					log.Printf("sqlite metric write failed: %v", err)
				}
			}
		case <-ticker.C:
			if writer != nil {
				writer.Flush()
			}
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

func (s *Server) handleDebugSummary(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if s.db == nil {
		http.Error(w, "sqlite disabled", http.StatusServiceUnavailable)
		return
	}
	summary, err := s.summary(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(summary)
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.DashboardEnabled {
		http.NotFound(w, r)
		return
	}
	if !s.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Basic realm="cpa-smart-router"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if s.db == nil {
		http.Error(w, "sqlite disabled", http.StatusServiceUnavailable)
		return
	}
	summary, err := s.summary(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if err := dashboardTemplate.Execute(w, summary); err != nil {
		log.Printf("dashboard render failed: %v", err)
	}
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.proxyRaw(w, r, s.cfg.DefaultBackend)
}

func (s *Server) handleImages(w http.ResponseWriter, r *http.Request) {
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
	s.proxyBody(w, r, s.cfg.DefaultBackend, body)
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
	if s.modelBlocked(model) {
		http.Error(w, "model blocked by smart-router policy", http.StatusForbidden)
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
	if _, password, ok := r.BasicAuth(); ok {
		_, ok := s.clientKeys[password]
		return ok
	}
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

func (s *Server) modelBlocked(model string) bool {
	for _, blocked := range s.cfg.BlockedModels {
		if model == blocked {
			return true
		}
	}
	return false
}

func (s *Server) newResponseProbe(r *http.Request, payload map[string]any, providerID string, stream bool) *ResponseProbeEvent {
	if r.URL.Path != "/v1/responses" {
		return nil
	}
	probe := &ResponseProbeEvent{
		Stream:        stream,
		StoreValue:    storeValue(payload),
		CaptureStatus: "missing",
	}
	if parent, ok := payload["previous_response_id"].(string); ok && parent != "" {
		probe.ParentResponseID = parent
		if s.db != nil {
			parentProvider, parentTS, found := lookupObservedResponse(s.db, parent)
			if found {
				probe.ParentSeen = true
				probe.ParentProviderID = parentProvider
				if parsed, err := time.Parse(time.RFC3339, parentTS); err == nil {
					probe.ParentAgeMS = time.Since(parsed).Milliseconds()
				}
				matches := providerID == parentProvider
				probe.ProviderMatchesParent = &matches
			}
		}
	}
	return probe
}

func storeValue(payload map[string]any) string {
	value, ok := payload["store"]
	if !ok {
		return "missing"
	}
	switch v := value.(type) {
	case bool:
		if v {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	default:
		return "other"
	}
}

func lookupObservedResponse(db *sql.DB, responseID string) (string, string, bool) {
	var providerID, ts string
	err := db.QueryRow(`SELECT provider_id, ts FROM responses_observe WHERE response_id = ? ORDER BY ts DESC LIMIT 1`, responseID).Scan(&providerID, &ts)
	if err != nil {
		return "", "", false
	}
	return providerID, ts, true
}

func attachResponseCaptureProbe(probe *ResponseProbeEvent, capture responseCapture) {
	if probe == nil {
		return
	}
	if capture.Status != "" {
		probe.CaptureStatus = capture.Status
	}
	probe.ResponseID = capture.ID
	probe.CaptureEvent = capture.Event
}

func attachResponseErrorProbe(probe *ResponseProbeEvent, body []byte) {
	if probe == nil || len(body) == 0 {
		return
	}
	probe.UpstreamErrorSample = errorSample(body, 512)
}

func errorSample(body []byte, limit int) string {
	var payload struct {
		Error any `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err == nil && payload.Error != nil {
		if data, err := json.Marshal(payload.Error); err == nil {
			body = data
		}
	}
	text := strings.TrimSpace(string(body))
	if len(text) > limit {
		text = text[:limit]
	}
	return text
}

func (s *Server) tryCandidate(w http.ResponseWriter, r *http.Request, body []byte, payload map[string]any, routeModel string, candidate Candidate, stream bool) (int, bool, MetricEvent) {
	start := time.Now()
	probe := s.newResponseProbe(r, payload, candidate.ID, stream)
	upstreamBody, err := rewriteModel(body, payload, candidate.Model, stream && r.URL.Path == "/v1/chat/completions")
	if err != nil {
		return 0, false, s.metric(routeModel, candidate.ID, 0, start, "rewrite model: "+err.Error(), nil, probe)
	}
	upstream := upstreamURL(candidate.BaseURL, r.URL.Path, r.URL.RawQuery)
	req, err := http.NewRequestWithContext(context.Background(), r.Method, upstream, bytes.NewReader(upstreamBody))
	if err != nil {
		return 0, false, s.metric(routeModel, candidate.ID, 0, start, err.Error(), nil, probe)
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
		return 0, true, s.metric(routeModel, candidate.ID, 0, start, err.Error(), nil, probe)
	}
	defer resp.Body.Close()

	if isRetryableStatus(resp.StatusCode) {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		errMsg := strings.TrimSpace(string(data))
		attachResponseErrorProbe(probe, data)
		s.updateState(candidate.ID, resp.StatusCode, time.Since(start), 0, errMsg)
		return resp.StatusCode, true, s.metric(routeModel, candidate.ID, resp.StatusCode, start, errMsg, nil, probe)
	}

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	var responseBody []byte
	var usage usageInfo
	var upstreamModel string
	capture := responseCapture{Status: "not_applicable"}
	if stream {
		usage, upstreamModel, capture, err = streamAndExtractUsage(w, resp.Body, r.URL.Path == "/v1/responses")
	} else {
		responseBody, err = io.ReadAll(resp.Body)
		if err == nil {
			usage = extractUsage(responseBody)
			upstreamModel = extractModel(responseBody)
			capture = captureResponseIDFromBody(responseBody, r.URL.Path == "/v1/responses")
			_, err = w.Write(responseBody)
		}
	}
	attachResponseCaptureProbe(probe, capture)
	if resp.StatusCode >= 400 {
		attachResponseErrorProbe(probe, responseBody)
	}
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	s.updateState(candidate.ID, resp.StatusCode, time.Since(start), usage.Total, errMsg)
	metric := s.metric(routeModel, candidate.ID, resp.StatusCode, start, errMsg, &usage, probe)
	metric.UpstreamModel = upstreamModel
	return resp.StatusCode, false, metric
}

func (s *Server) forwardWithCandidate(w http.ResponseWriter, r *http.Request, body []byte, payload map[string]any, routeModel string, candidate Candidate, stream bool) {
	status, retryable, metric := s.tryCandidate(w, r, body, payload, routeModel, candidate, stream)
	metric.Path = r.URL.Path
	s.record(metric)
	if !retryable {
		return
	}
	if status == 0 {
		status = http.StatusBadGateway
	}
	message := strings.TrimSpace(metric.Error)
	if message == "" {
		message = http.StatusText(status)
	}
	http.Error(w, message, status)
}

func rewriteModel(body []byte, payload map[string]any, model string, includeStreamUsage bool) ([]byte, error) {
	if model == "" && !includeStreamUsage {
		return body, nil
	}
	clone := make(map[string]any, len(payload))
	for k, v := range payload {
		clone[k] = v
	}
	if model != "" {
		clone["model"] = model
	}
	if includeStreamUsage {
		options := map[string]any{}
		if existing, ok := clone["stream_options"].(map[string]any); ok {
			for k, v := range existing {
				options[k] = v
			}
		}
		options["include_usage"] = true
		clone["stream_options"] = options
	}
	return json.Marshal(clone)
}

func upstreamURL(baseURL, requestPath, rawQuery string) string {
	path := requestPath
	if strings.HasPrefix(path, "/v1/") {
		path = strings.TrimPrefix(path, "/v1")
	}
	upstream := strings.TrimRight(baseURL, "/") + path
	if rawQuery == "" {
		return upstream
	}
	parsed, err := url.Parse(upstream)
	if err != nil {
		return upstream
	}
	parsed.RawQuery = rawQuery
	return parsed.String()
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

func streamAndExtractUsage(w http.ResponseWriter, reader io.Reader, captureResponse bool) (usageInfo, string, responseCapture, error) {
	buffered := bufio.NewReader(reader)
	var usage usageInfo
	var upstreamModel string
	capture := responseCapture{Status: "not_applicable"}
	if captureResponse {
		capture.Status = "missing"
	}
	for {
		line, readErr := buffered.ReadBytes('\n')
		if len(line) > 0 {
			if _, writeErr := w.Write(line); writeErr != nil {
				return usage, upstreamModel, capture, writeErr
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			if chunkUsage, model, ok := extractSSEUsage(line); ok {
				usage = chunkUsage
				if model != "" {
					upstreamModel = model
				}
			} else if model != "" {
				upstreamModel = model
			}
			if captureResponse && capture.ID == "" {
				if next := extractSSEResponseID(line); next.ID != "" || next.Status == "parse_error" {
					capture = next
				}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return usage, upstreamModel, capture, nil
			}
			return usage, upstreamModel, capture, readErr
		}
	}
}

func extractSSEUsage(line []byte) (usageInfo, string, bool) {
	text := strings.TrimSpace(string(line))
	if !strings.HasPrefix(text, "data:") {
		return usageInfo{}, "", false
	}
	data := strings.TrimSpace(strings.TrimPrefix(text, "data:"))
	if data == "" || data == "[DONE]" {
		return usageInfo{}, "", false
	}
	usage, hasUsage := extractUsageFromJSON([]byte(data))
	return usage, extractModel([]byte(data)), hasUsage
}

func extractSSEResponseID(line []byte) responseCapture {
	text := strings.TrimSpace(string(line))
	if !strings.HasPrefix(text, "data:") {
		return responseCapture{Status: "missing"}
	}
	data := strings.TrimSpace(strings.TrimPrefix(text, "data:"))
	if data == "" || data == "[DONE]" {
		return responseCapture{Status: "missing"}
	}
	capture := captureResponseIDFromBody([]byte(data), true)
	if capture.ID != "" {
		if event := extractSSEEventName([]byte(text)); event != "" {
			capture.Event = event
		}
		if capture.Event == "" {
			capture.Event = "sse_data"
		}
	}
	return capture
}

func extractSSEEventName(line []byte) string {
	text := strings.TrimSpace(string(line))
	if !strings.HasPrefix(text, "event:") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(text, "event:"))
}

func captureResponseIDFromBody(body []byte, captureResponse bool) responseCapture {
	if !captureResponse {
		return responseCapture{Status: "not_applicable"}
	}
	if len(body) == 0 {
		return responseCapture{Status: "missing"}
	}
	var payload struct {
		ID       string `json:"id"`
		Response *struct {
			ID string `json:"id"`
		} `json:"response"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return responseCapture{Status: "parse_error"}
	}
	if payload.ID != "" {
		return responseCapture{ID: payload.ID, Status: "captured", Event: "json_body"}
	}
	if payload.Response != nil && payload.Response.ID != "" {
		return responseCapture{ID: payload.Response.ID, Status: "captured", Event: "response.created"}
	}
	return responseCapture{Status: "missing"}
}

func extractUsage(body []byte) usageInfo {
	usage, _ := extractUsageFromJSON(body)
	return usage
}

func extractUsageFromJSON(body []byte) (usageInfo, bool) {
	type rawUsage struct {
		PromptTokens     *int64 `json:"prompt_tokens"`
		CompletionTokens *int64 `json:"completion_tokens"`
		InputTokens      *int64 `json:"input_tokens"`
		OutputTokens     *int64 `json:"output_tokens"`
		TotalTokens      *int64 `json:"total_tokens"`
	}
	var payload struct {
		Usage    *rawUsage `json:"usage"`
		Response *struct {
			Usage *rawUsage `json:"usage"`
		} `json:"response"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return usageInfo{}, false
	}
	usage := payload.Usage
	if usage == nil && payload.Response != nil {
		usage = payload.Response.Usage
	}
	if usage == nil {
		return usageInfo{}, false
	}
	prompt := int64Value(usage.PromptTokens, usage.InputTokens)
	completion := int64Value(usage.CompletionTokens, usage.OutputTokens)
	total := prompt + completion
	if usage.TotalTokens != nil {
		total = *usage.TotalTokens
	}
	return usageInfo{Prompt: prompt, Completion: completion, Total: total}, true
}

func int64Value(primary, fallback *int64) int64 {
	if primary != nil {
		return *primary
	}
	if fallback != nil {
		return *fallback
	}
	return 0
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

func (s *Server) metric(routeModel, providerID string, status int, start time.Time, errMsg string, usage *usageInfo, probe *ResponseProbeEvent) MetricEvent {
	event := MetricEvent{TS: time.Now().Format(time.RFC3339), RouteModel: routeModel, ProviderID: providerID, Status: status, LatencyMS: time.Since(start).Milliseconds(), Error: errMsg, ResponseProbe: probe}
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
	s.proxyBody(w, r, candidate, nil)
}

func (s *Server) proxyBody(w http.ResponseWriter, r *http.Request, candidate Candidate, body []byte) {
	upstream := upstreamURL(candidate.BaseURL, r.URL.Path, r.URL.RawQuery)
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, upstream, reader)
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

func openMetricsDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  route_model TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  upstream_model TEXT,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_log_day_provider ON request_log(day, provider_id);
CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts);
CREATE INDEX IF NOT EXISTS idx_request_log_route_model ON request_log(route_model);
CREATE TABLE IF NOT EXISTS responses_observe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  route_model TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  upstream_model TEXT,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  stream BOOLEAN NOT NULL,
  store_value TEXT NOT NULL,
  response_id TEXT,
  parent_response_id TEXT,
  parent_seen BOOLEAN NOT NULL DEFAULT 0,
  parent_provider_id TEXT,
  parent_age_ms INTEGER,
  provider_matches_parent BOOLEAN,
  capture_status TEXT NOT NULL,
  capture_event TEXT,
  upstream_error_sample TEXT
);
CREATE INDEX IF NOT EXISTS idx_responses_observe_response_id ON responses_observe(response_id);
CREATE INDEX IF NOT EXISTS idx_responses_observe_parent ON responses_observe(parent_response_id);
CREATE INDEX IF NOT EXISTS idx_responses_observe_ts ON responses_observe(ts);
CREATE INDEX IF NOT EXISTS idx_responses_observe_provider ON responses_observe(provider_id);
`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func insertMetric(db *sql.DB, event MetricEvent) error {
	ts := event.TS
	parsed, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		parsed = time.Now()
		ts = parsed.Format(time.RFC3339)
	}
	_, err = db.Exec(`INSERT INTO request_log (
ts, day, path, route_model, provider_id, upstream_model, status, latency_ms,
input_tokens, output_tokens, total_tokens, error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ts, cstDay(parsed), event.Path, event.RouteModel, event.ProviderID, event.UpstreamModel,
		event.Status, event.LatencyMS, event.InputTokens, event.OutputTokens, event.TotalTokens, event.Error)
	if err != nil {
		return err
	}
	if event.ResponseProbe != nil {
		return insertResponseProbe(db, ts, event)
	}
	return nil
}

func insertResponseProbe(db *sql.DB, ts string, event MetricEvent) error {
	probe := event.ResponseProbe
	var providerMatches any
	if probe.ProviderMatchesParent != nil {
		providerMatches = *probe.ProviderMatchesParent
	}
	_, err := db.Exec(`INSERT INTO responses_observe (
ts, route_model, provider_id, upstream_model, status, latency_ms, stream, store_value,
response_id, parent_response_id, parent_seen, parent_provider_id, parent_age_ms,
provider_matches_parent, capture_status, capture_event, upstream_error_sample
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ts, event.RouteModel, event.ProviderID, event.UpstreamModel, event.Status, event.LatencyMS,
		probe.Stream, probe.StoreValue, probe.ResponseID, probe.ParentResponseID, probe.ParentSeen,
		probe.ParentProviderID, probe.ParentAgeMS, providerMatches, probe.CaptureStatus,
		probe.CaptureEvent, probe.UpstreamErrorSample)
	return err
}

type Summary struct {
	GeneratedAt   string               `json:"generated_at"`
	Since         string               `json:"since"`
	Hours         int                  `json:"hours"`
	Total         SummaryBucket        `json:"total"`
	Providers     []ProviderDebug      `json:"providers"`
	ResponseProbe ResponseProbeSummary `json:"response_probe"`
	ByProvider    []SummaryBucket      `json:"by_provider"`
	ByModel       []SummaryBucket      `json:"by_model"`
	RecentErrors  []RecentError        `json:"recent_errors"`
}

type ResponseProbeSummary struct {
	Requests              int64                 `json:"requests"`
	WithPrevious          int64                 `json:"with_previous_response_id"`
	PreviousRate          float64               `json:"previous_response_id_rate"`
	StreamRequests        int64                 `json:"stream_requests"`
	StreamRate            float64               `json:"stream_rate"`
	Captured              int64                 `json:"captured"`
	CaptureRate           float64               `json:"capture_rate"`
	ParentSeen            int64                 `json:"parent_seen"`
	ParentSeenRate        float64               `json:"parent_seen_rate"`
	ProviderMismatches    int64                 `json:"provider_mismatches"`
	MismatchErrors        int64                 `json:"mismatch_errors"`
	StoreDistribution     []DistributionBucket  `json:"store_distribution"`
	CaptureDistribution   []DistributionBucket  `json:"capture_distribution"`
	ProviderBindingCounts []DistributionBucket  `json:"provider_binding_counts"`
	RecentResponseErrors  []ResponseErrorSample `json:"recent_response_errors"`
}

type DistributionBucket struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

type ResponseErrorSample struct {
	TS                    string `json:"ts"`
	ProviderID            string `json:"provider_id"`
	RouteModel            string `json:"route_model"`
	Status                int    `json:"status"`
	ParentResponseID      string `json:"parent_response_id,omitempty"`
	ParentSeen            bool   `json:"parent_seen"`
	ProviderMatchesParent *bool  `json:"provider_matches_parent,omitempty"`
	ErrorSample           string `json:"error_sample"`
}

type ProviderDebug struct {
	ID              string  `json:"id"`
	RouteModel      string  `json:"route_model"`
	UpstreamModel   string  `json:"upstream_model"`
	Priority        int     `json:"priority"`
	DailyTokenLimit int64   `json:"daily_token_limit"`
	Successes       int64   `json:"successes"`
	Failures        int64   `json:"failures"`
	Health          float64 `json:"health"`
	LatencyEWMA     float64 `json:"latency_ewma_ms"`
	LatencyScore    float64 `json:"latency_score"`
	TokensToday     int64   `json:"tokens_today"`
	QuotaScore      float64 `json:"quota_score"`
	Score           float64 `json:"score"`
	CooldownUntil   string  `json:"cooldown_until,omitempty"`
	Reason          string  `json:"reason"`
}

type SummaryBucket struct {
	Name          string  `json:"name"`
	Requests      int64   `json:"requests"`
	Successes     int64   `json:"successes"`
	Errors        int64   `json:"errors"`
	SuccessRate   float64 `json:"success_rate"`
	AvgLatencyMS  float64 `json:"avg_latency_ms"`
	InputTokens   int64   `json:"input_tokens"`
	OutputTokens  int64   `json:"output_tokens"`
	TotalTokens   int64   `json:"total_tokens"`
	LastRequestAt string  `json:"last_request_at,omitempty"`
}

type RecentError struct {
	TS         string `json:"ts"`
	ProviderID string `json:"provider_id"`
	RouteModel string `json:"route_model"`
	Status     int    `json:"status"`
	Error      string `json:"error"`
}

func (s *Server) summary(r *http.Request) (Summary, error) {
	hours := 24
	if raw := r.URL.Query().Get("hours"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return Summary{}, errors.New("invalid hours")
		}
		if parsed > 24*31 {
			parsed = 24 * 31
		}
		hours = parsed
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour).Format(time.RFC3339)
	total, err := querySummaryBucket(s.db, since, "total", "")
	if err != nil {
		return Summary{}, err
	}
	byProvider, err := queryGroupedSummary(s.db, since, "provider_id")
	if err != nil {
		return Summary{}, err
	}
	byModel, err := queryGroupedSummary(s.db, since, "route_model")
	if err != nil {
		return Summary{}, err
	}
	providers := s.providerDebug()
	responseProbe, err := queryResponseProbeSummary(s.db, since)
	if err != nil {
		return Summary{}, err
	}
	recentErrors, err := queryRecentErrors(s.db, since)
	if err != nil {
		return Summary{}, err
	}
	return Summary{
		GeneratedAt:   time.Now().Format(time.RFC3339),
		Since:         since,
		Hours:         hours,
		Total:         total,
		Providers:     providers,
		ResponseProbe: responseProbe,
		ByProvider:    byProvider,
		ByModel:       byModel,
		RecentErrors:  recentErrors,
	}, nil
}

func (s *Server) providerDebug() []ProviderDebug {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []ProviderDebug{}
	for routeModel, route := range s.cfg.Routes {
		for _, candidate := range route.Candidates {
			s.ensureDayLocked(candidate.ID, now)
			state := s.states[candidate.ID]
			item := ProviderDebug{
				ID:              candidate.ID,
				RouteModel:      routeModel,
				UpstreamModel:   candidate.Model,
				Priority:        candidate.Priority,
				DailyTokenLimit: candidate.DailyTokenLimit,
				Score:           s.scoreLocked(candidate, now),
			}
			item.Health = 1
			item.LatencyScore = 1
			item.QuotaScore = 1
			if state != nil {
				item.Successes = state.Successes
				item.Failures = state.Failures
				item.LatencyEWMA = state.LatencyEWMA
				item.TokensToday = state.TokensToday
				total := state.Successes + state.Failures
				if total > 0 {
					item.Health = float64(state.Successes) / float64(total)
				}
				if state.LatencyEWMA > 0 {
					item.LatencyScore = math.Max(0, 1-math.Min(state.LatencyEWMA/10000.0, 1))
				}
				if candidate.DailyTokenLimit > 0 {
					item.QuotaScore = math.Max(0, 1-math.Min(float64(state.TokensToday)/float64(candidate.DailyTokenLimit), 1))
				}
				if state.CooldownUntil.After(now) {
					item.CooldownUntil = state.CooldownUntil.Format(time.RFC3339)
				}
			}
			item.Reason = providerReason(item)
			items = append(items, item)
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].Score > items[j].Score })
	return items
}

func providerReason(item ProviderDebug) string {
	if item.CooldownUntil != "" {
		return "cooldown"
	}
	parts := []string{}
	if item.Health >= 0.98 {
		parts = append(parts, "health ok")
	} else {
		parts = append(parts, "health low")
	}
	if item.LatencyScore >= 0.7 {
		parts = append(parts, "latency ok")
	} else {
		parts = append(parts, "latency high")
	}
	if item.QuotaScore >= 0.8 {
		parts = append(parts, "quota ok")
	} else {
		parts = append(parts, "quota tight")
	}
	return strings.Join(parts, " / ")
}

func querySummaryBucket(db *sql.DB, since, name, where string, args ...any) (SummaryBucket, error) {
	query := `SELECT COUNT(*),
COALESCE(SUM(CASE WHEN status >= 200 AND status < 500 AND COALESCE(error, '') = '' THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN status = 0 OR status >= 500 OR COALESCE(error, '') != '' THEN 1 ELSE 0 END), 0),
COALESCE(AVG(latency_ms), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
COALESCE(SUM(total_tokens), 0), COALESCE(MAX(ts), '') FROM request_log WHERE ts >= ?`
	queryArgs := append([]any{since}, args...)
	if where != "" {
		query += " AND " + where
	}
	var bucket SummaryBucket
	bucket.Name = name
	if err := db.QueryRow(query, queryArgs...).Scan(&bucket.Requests, &bucket.Successes, &bucket.Errors, &bucket.AvgLatencyMS, &bucket.InputTokens, &bucket.OutputTokens, &bucket.TotalTokens, &bucket.LastRequestAt); err != nil {
		return SummaryBucket{}, err
	}
	bucket.SuccessRate = successRate(bucket.Successes, bucket.Requests)
	return bucket, nil
}

func queryGroupedSummary(db *sql.DB, since, column string) ([]SummaryBucket, error) {
	if column != "provider_id" && column != "route_model" {
		return nil, errors.New("invalid summary column")
	}
	rows, err := db.Query(`SELECT `+column+`, COUNT(*),
COALESCE(SUM(CASE WHEN status >= 200 AND status < 500 AND COALESCE(error, '') = '' THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN status = 0 OR status >= 500 OR COALESCE(error, '') != '' THEN 1 ELSE 0 END), 0),
COALESCE(AVG(latency_ms), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
COALESCE(SUM(total_tokens), 0), COALESCE(MAX(ts), '')
FROM request_log WHERE ts >= ? GROUP BY `+column+` ORDER BY COUNT(*) DESC, `+column, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var buckets []SummaryBucket
	for rows.Next() {
		var bucket SummaryBucket
		if err := rows.Scan(&bucket.Name, &bucket.Requests, &bucket.Successes, &bucket.Errors, &bucket.AvgLatencyMS, &bucket.InputTokens, &bucket.OutputTokens, &bucket.TotalTokens, &bucket.LastRequestAt); err != nil {
			return nil, err
		}
		bucket.SuccessRate = successRate(bucket.Successes, bucket.Requests)
		buckets = append(buckets, bucket)
	}
	if buckets == nil {
		buckets = []SummaryBucket{}
	}
	return buckets, rows.Err()
}

func queryRecentErrors(db *sql.DB, since string) ([]RecentError, error) {
	rows, err := db.Query(`SELECT ts, provider_id, route_model, status, COALESCE(error, '')
FROM request_log WHERE ts >= ? AND (status = 0 OR status >= 500 OR COALESCE(error, '') != '')
ORDER BY ts DESC LIMIT 20`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var errorsList []RecentError
	for rows.Next() {
		var item RecentError
		if err := rows.Scan(&item.TS, &item.ProviderID, &item.RouteModel, &item.Status, &item.Error); err != nil {
			return nil, err
		}
		errorsList = append(errorsList, item)
	}
	if errorsList == nil {
		errorsList = []RecentError{}
	}
	return errorsList, rows.Err()
}

func queryResponseProbeSummary(db *sql.DB, since string) (ResponseProbeSummary, error) {
	var summary ResponseProbeSummary
	if err := db.QueryRow(`SELECT COUNT(*),
COALESCE(SUM(CASE WHEN parent_response_id IS NOT NULL AND parent_response_id != '' THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN stream THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN response_id IS NOT NULL AND response_id != '' THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN parent_seen THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN provider_matches_parent = 0 THEN 1 ELSE 0 END), 0),
COALESCE(SUM(CASE WHEN provider_matches_parent = 0 AND status >= 400 THEN 1 ELSE 0 END), 0)
FROM responses_observe WHERE ts >= ?`, since).Scan(&summary.Requests, &summary.WithPrevious, &summary.StreamRequests, &summary.Captured, &summary.ParentSeen, &summary.ProviderMismatches, &summary.MismatchErrors); err != nil {
		return ResponseProbeSummary{}, err
	}
	summary.PreviousRate = successRate(summary.WithPrevious, summary.Requests)
	summary.StreamRate = successRate(summary.StreamRequests, summary.Requests)
	summary.CaptureRate = successRate(summary.Captured, summary.Requests)
	summary.ParentSeenRate = successRate(summary.ParentSeen, summary.WithPrevious)
	var err error
	summary.StoreDistribution, err = queryDistribution(db, since, "store_value")
	if err != nil {
		return ResponseProbeSummary{}, err
	}
	summary.CaptureDistribution, err = queryDistribution(db, since, "capture_status")
	if err != nil {
		return ResponseProbeSummary{}, err
	}
	summary.ProviderBindingCounts, err = queryProviderBindingCounts(db, since)
	if err != nil {
		return ResponseProbeSummary{}, err
	}
	summary.RecentResponseErrors, err = queryResponseErrorSamples(db, since)
	if err != nil {
		return ResponseProbeSummary{}, err
	}
	return summary, nil
}

func queryDistribution(db *sql.DB, since, column string) ([]DistributionBucket, error) {
	if column != "store_value" && column != "capture_status" {
		return nil, errors.New("invalid distribution column")
	}
	rows, err := db.Query(`SELECT `+column+`, COUNT(*) FROM responses_observe WHERE ts >= ? GROUP BY `+column+` ORDER BY COUNT(*) DESC, `+column, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDistribution(rows)
}

func queryProviderBindingCounts(db *sql.DB, since string) ([]DistributionBucket, error) {
	rows, err := db.Query(`SELECT provider_id, COUNT(*) FROM responses_observe WHERE ts >= ? AND response_id IS NOT NULL AND response_id != '' GROUP BY provider_id ORDER BY COUNT(*) DESC, provider_id`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDistribution(rows)
}

func scanDistribution(rows *sql.Rows) ([]DistributionBucket, error) {
	items := []DistributionBucket{}
	for rows.Next() {
		var item DistributionBucket
		if err := rows.Scan(&item.Name, &item.Count); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func queryResponseErrorSamples(db *sql.DB, since string) ([]ResponseErrorSample, error) {
	rows, err := db.Query(`SELECT ts, provider_id, route_model, status, COALESCE(parent_response_id, ''), parent_seen, provider_matches_parent, COALESCE(upstream_error_sample, '')
FROM responses_observe WHERE ts >= ? AND status >= 400 ORDER BY ts DESC LIMIT 20`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ResponseErrorSample{}
	for rows.Next() {
		var item ResponseErrorSample
		var providerMatches sql.NullBool
		if err := rows.Scan(&item.TS, &item.ProviderID, &item.RouteModel, &item.Status, &item.ParentResponseID, &item.ParentSeen, &providerMatches, &item.ErrorSample); err != nil {
			return nil, err
		}
		if providerMatches.Valid {
			value := providerMatches.Bool
			item.ProviderMatchesParent = &value
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func successRate(successes, requests int64) float64 {
	if requests == 0 {
		return 0
	}
	return float64(successes) / float64(requests)
}

var dashboardTemplate = template.Must(template.New("dashboard").Funcs(template.FuncMap{
	"pct": func(value float64) string { return strconv.FormatFloat(value*100, 'f', 1, 64) + "%" },
	"ms":  func(value float64) string { return strconv.FormatFloat(value, 'f', 0, 64) },
	"num": func(value float64) string { return strconv.FormatFloat(value, 'f', 1, 64) },
}).Parse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CPA Smart Router Dashboard</title>
<style>
body{margin:0;background:#0f172a;color:#e2e8f0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1120px;margin:0 auto;padding:28px}h1{font-size:24px;margin:0 0 4px}.muted{color:#94a3b8}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.card,section{background:#111c33;border:1px solid #23314f;border-radius:14px;padding:16px}.metric{font-size:28px;font-weight:700}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #23314f}th{color:#93c5fd;font-weight:600}section{margin-top:16px}.ok{color:#86efac}.bad{color:#fca5a5}@media(max-width:760px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:18px}table{font-size:12px}}
</style>
</head>
<body><main>
<h1>CPA Smart Router</h1>
<div class="muted">最近 {{.Hours}} 小时 · 生成于 {{.GeneratedAt}} · since {{.Since}}</div>
<div class="cards">
<div class="card"><div class="muted">请求数</div><div class="metric">{{.Total.Requests}}</div></div>
<div class="card"><div class="muted">成功率</div><div class="metric {{if lt .Total.SuccessRate 0.95}}bad{{else}}ok{{end}}">{{pct .Total.SuccessRate}}</div></div>
<div class="card"><div class="muted">平均延迟</div><div class="metric">{{ms .Total.AvgLatencyMS}}ms</div></div>
<div class="card"><div class="muted">总 Token</div><div class="metric">{{.Total.TotalTokens}}</div></div>
</div>
<section><h2>Responses State Probe</h2><div class="cards"><div class="card"><div class="muted">responses</div><div class="metric">{{.ResponseProbe.Requests}}</div></div><div class="card"><div class="muted">previous_response_id</div><div class="metric">{{pct .ResponseProbe.PreviousRate}}</div></div><div class="card"><div class="muted">stream</div><div class="metric">{{pct .ResponseProbe.StreamRate}}</div></div><div class="card"><div class="muted">id capture</div><div class="metric">{{pct .ResponseProbe.CaptureRate}}</div></div></div><table><thead><tr><th>metric</th><th>value</th></tr></thead><tbody><tr><td>with previous_response_id</td><td>{{.ResponseProbe.WithPrevious}}</td></tr><tr><td>parent seen</td><td>{{.ResponseProbe.ParentSeen}} ({{pct .ResponseProbe.ParentSeenRate}})</td></tr><tr><td>provider mismatches</td><td>{{.ResponseProbe.ProviderMismatches}}</td></tr><tr><td>mismatch errors</td><td>{{.ResponseProbe.MismatchErrors}}</td></tr></tbody></table><div class="muted">M1 gate: previous_response_id &gt; 1% or >=20, and response id capture >=95%; otherwise keep observe only.</div></section>
<section><h2>Responses 分布</h2><table><thead><tr><th>store</th><th>count</th></tr></thead><tbody>{{range .ResponseProbe.StoreDistribution}}<tr><td>{{.Name}}</td><td>{{.Count}}</td></tr>{{else}}<tr><td colspan="2" class="muted">暂无 store 数据</td></tr>{{end}}</tbody></table><table><thead><tr><th>capture</th><th>count</th></tr></thead><tbody>{{range .ResponseProbe.CaptureDistribution}}<tr><td>{{.Name}}</td><td>{{.Count}}</td></tr>{{else}}<tr><td colspan="2" class="muted">暂无 capture 数据</td></tr>{{end}}</tbody></table><table><thead><tr><th>provider captured bindings</th><th>count</th></tr></thead><tbody>{{range .ResponseProbe.ProviderBindingCounts}}<tr><td>{{.Name}}</td><td>{{.Count}}</td></tr>{{else}}<tr><td colspan="2" class="muted">暂无 binding 数据</td></tr>{{end}}</tbody></table></section>
<section><h2>调度解释</h2><table><thead><tr><th>provider</th><th>route</th><th>score</th><th>health</th><th>latency ewma</th><th>quota</th><th>tokens today</th><th>reason</th></tr></thead><tbody>{{range .Providers}}<tr><td>{{.ID}}</td><td>{{.RouteModel}} → {{.UpstreamModel}}</td><td>{{num .Score}}</td><td>{{pct .Health}}</td><td>{{ms .LatencyEWMA}}ms</td><td>{{pct .QuotaScore}}</td><td>{{.TokensToday}} / {{.DailyTokenLimit}}</td><td>{{.Reason}}{{if .CooldownUntil}} until {{.CooldownUntil}}{{end}}</td></tr>{{else}}<tr><td colspan="8" class="muted">暂无 provider 配置</td></tr>{{end}}</tbody></table><div class="muted">score = 35% health + 25% latency + 20% quota + 20% priority；cooldown 时 score 极低。</div></section>
<section><h2>Provider 统计</h2><table><thead><tr><th>provider</th><th>requests</th><th>success</th><th>errors</th><th>avg latency</th><th>tokens</th><th>last</th></tr></thead><tbody>{{range .ByProvider}}<tr><td>{{.Name}}</td><td>{{.Requests}}</td><td>{{pct .SuccessRate}}</td><td>{{.Errors}}</td><td>{{ms .AvgLatencyMS}}ms</td><td>{{.TotalTokens}}</td><td>{{.LastRequestAt}}</td></tr>{{else}}<tr><td colspan="7" class="muted">暂无数据</td></tr>{{end}}</tbody></table></section>
<section><h2>Model</h2><table><thead><tr><th>model</th><th>requests</th><th>success</th><th>errors</th><th>avg latency</th><th>tokens</th><th>last</th></tr></thead><tbody>{{range .ByModel}}<tr><td>{{.Name}}</td><td>{{.Requests}}</td><td>{{pct .SuccessRate}}</td><td>{{.Errors}}</td><td>{{ms .AvgLatencyMS}}ms</td><td>{{.TotalTokens}}</td><td>{{.LastRequestAt}}</td></tr>{{else}}<tr><td colspan="7" class="muted">暂无数据</td></tr>{{end}}</tbody></table></section>
<section><h2>最近错误</h2><table><thead><tr><th>time</th><th>provider</th><th>model</th><th>status</th><th>error</th></tr></thead><tbody>{{range .RecentErrors}}<tr><td>{{.TS}}</td><td>{{.ProviderID}}</td><td>{{.RouteModel}}</td><td>{{.Status}}</td><td>{{.Error}}</td></tr>{{else}}<tr><td colspan="5" class="muted">暂无错误</td></tr>{{end}}</tbody></table></section>
</main></body></html>`))
