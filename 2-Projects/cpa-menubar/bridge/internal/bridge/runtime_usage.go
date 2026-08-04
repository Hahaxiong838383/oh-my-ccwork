package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	usageQueueBatchSize = 500
	usageStateVersion   = 1
	usageRetentionDays  = 8
)

type nativeUsageRecord struct {
	Timestamp           time.Time         `json:"timestamp"`
	LatencyMS           int64             `json:"latency_ms"`
	TTFTMS              int64             `json:"ttft_ms"`
	AuthIndex           string            `json:"auth_index"`
	Provider            string            `json:"provider"`
	Model               string            `json:"model"`
	ServiceTier         string            `json:"service_tier"`
	ResponseServiceTier string            `json:"response_service_tier"`
	Failed              bool              `json:"failed"`
	Tokens              nativeUsageTokens `json:"tokens"`
	Fail                struct {
		StatusCode int `json:"status_code"`
	} `json:"fail"`
}

type nativeUsageTokens struct {
	InputTokens         int64 `json:"input_tokens"`
	OutputTokens        int64 `json:"output_tokens"`
	ReasoningTokens     int64 `json:"reasoning_tokens"`
	CachedTokens        int64 `json:"cached_tokens"`
	CacheReadTokens     int64 `json:"cache_read_tokens"`
	CacheCreationTokens int64 `json:"cache_creation_tokens"`
	TotalTokens         int64 `json:"total_tokens"`
}

type persistedUsageState struct {
	Version int                     `json:"version"`
	Buckets map[string]*usageBucket `json:"buckets"`
}

type usageBucket struct {
	Total    usageCounter             `json:"total"`
	Accounts map[string]*usageCounter `json:"accounts"`
}

type usageCounter struct {
	Requests            int64            `json:"requests"`
	Successes           int64            `json:"successes"`
	Errors              int64            `json:"errors"`
	InputTokens         int64            `json:"input_tokens"`
	OutputTokens        int64            `json:"output_tokens"`
	ReasoningTokens     int64            `json:"reasoning_tokens"`
	CacheReadTokens     int64            `json:"cache_read_tokens"`
	CacheCreationTokens int64            `json:"cache_creation_tokens"`
	TotalTokens         int64            `json:"total_tokens"`
	UsageSamples        int64            `json:"usage_samples"`
	LatencyTotalMS      int64            `json:"latency_total_ms"`
	LatencySamples      int64            `json:"latency_samples"`
	TTFTTotalMS         int64            `json:"ttft_total_ms"`
	TTFTSamples         int64            `json:"ttft_samples"`
	FastRequested       int64            `json:"fast_requested"`
	FastActual          int64            `json:"fast_actual"`
	Models              map[string]int64 `json:"models,omitempty"`
	LastRequestAt       string           `json:"last_request_at,omitempty"`
	LastErrorAt         string           `json:"last_error_at,omitempty"`
	LastErrorStatus     int              `json:"last_error_status,omitempty"`
}

type usageStore struct {
	path  string
	zone  *time.Location
	mu    sync.Mutex
	state persistedUsageState
}

func newUsageStore(path string) (*usageStore, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, nil
	}
	zone, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		zone = time.FixedZone("CST", 8*60*60)
	}
	store := &usageStore{
		path: path,
		zone: zone,
		state: persistedUsageState{
			Version: usageStateVersion,
			Buckets: make(map[string]*usageBucket),
		},
	}
	if err = store.load(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *usageStore) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var state persistedUsageState
	if err = json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("decode usage state: %w", err)
	}
	if state.Version != usageStateVersion {
		return fmt.Errorf("unsupported usage state version %d", state.Version)
	}
	if state.Buckets == nil {
		state.Buckets = make(map[string]*usageBucket)
	}
	s.state = state
	return nil
}

func (s *usageStore) add(records []nativeUsageRecord, now time.Time) error {
	if s == nil || len(records) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, record := range records {
		if !strings.EqualFold(strings.TrimSpace(record.Provider), "codex") {
			continue
		}
		timestamp := record.Timestamp
		if timestamp.IsZero() {
			timestamp = now
		}
		hourKey := timestamp.UTC().Truncate(time.Hour).Format(time.RFC3339)
		bucket := s.state.Buckets[hourKey]
		if bucket == nil {
			bucket = &usageBucket{Accounts: make(map[string]*usageCounter)}
			s.state.Buckets[hourKey] = bucket
		}
		if bucket.Accounts == nil {
			bucket.Accounts = make(map[string]*usageCounter)
		}
		bucket.Total.add(record, timestamp)
		authIndex := strings.TrimSpace(record.AuthIndex)
		if authIndex != "" {
			counter := bucket.Accounts[authIndex]
			if counter == nil {
				counter = &usageCounter{}
				bucket.Accounts[authIndex] = counter
			}
			counter.add(record, timestamp)
		}
	}

	s.pruneLocked(now)
	return s.persistLocked()
}

func (c *usageCounter) add(record nativeUsageRecord, timestamp time.Time) {
	c.Requests++
	if record.Failed || record.Fail.StatusCode >= http.StatusBadRequest {
		c.Errors++
		c.LastErrorAt = latestTimestamp(c.LastErrorAt, timestamp)
		if record.Fail.StatusCode > 0 {
			c.LastErrorStatus = record.Fail.StatusCode
		}
	} else {
		c.Successes++
	}
	c.InputTokens += maxInt64(record.Tokens.InputTokens, 0)
	c.OutputTokens += maxInt64(record.Tokens.OutputTokens, 0)
	c.ReasoningTokens += maxInt64(record.Tokens.ReasoningTokens, 0)
	cacheRead := record.Tokens.CacheReadTokens
	if cacheRead <= 0 {
		cacheRead = record.Tokens.CachedTokens
	}
	c.CacheReadTokens += maxInt64(cacheRead, 0)
	c.CacheCreationTokens += maxInt64(record.Tokens.CacheCreationTokens, 0)
	c.TotalTokens += maxInt64(record.Tokens.TotalTokens, 0)
	if record.Tokens.TotalTokens > 0 || record.Tokens.InputTokens > 0 || record.Tokens.OutputTokens > 0 {
		c.UsageSamples++
	}
	if record.LatencyMS >= 0 {
		c.LatencyTotalMS += record.LatencyMS
		c.LatencySamples++
	}
	if record.TTFTMS > 0 {
		c.TTFTTotalMS += record.TTFTMS
		c.TTFTSamples++
	}
	if isFastTier(record.ServiceTier) {
		c.FastRequested++
	}
	if isFastTier(record.ResponseServiceTier) {
		c.FastActual++
	}
	model := strings.TrimSpace(record.Model)
	if model != "" {
		if c.Models == nil {
			c.Models = make(map[string]int64)
		}
		c.Models[model]++
	}
	c.LastRequestAt = latestTimestamp(c.LastRequestAt, timestamp)
}

func (s *usageStore) snapshot(now time.Time) (RuntimeUsage, map[string]RuntimeUsage) {
	if s == nil {
		return RuntimeUsage{Window: "today"}, map[string]RuntimeUsage{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	localNow := now.In(s.zone)
	start := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, s.zone)
	var total usageCounter
	accounts := make(map[string]*usageCounter)
	for key, bucket := range s.state.Buckets {
		hour, err := time.Parse(time.RFC3339, key)
		if err != nil || hour.Before(start) || hour.After(now) {
			continue
		}
		total.merge(bucket.Total)
		for authIndex, counter := range bucket.Accounts {
			aggregate := accounts[authIndex]
			if aggregate == nil {
				aggregate = &usageCounter{}
				accounts[authIndex] = aggregate
			}
			aggregate.merge(*counter)
		}
	}
	accountUsage := make(map[string]RuntimeUsage, len(accounts))
	for authIndex, counter := range accounts {
		accountUsage[authIndex] = counter.runtimeUsage()
	}
	return total.runtimeUsage(), accountUsage
}

func (c *usageCounter) merge(other usageCounter) {
	c.Requests += other.Requests
	c.Successes += other.Successes
	c.Errors += other.Errors
	c.InputTokens += other.InputTokens
	c.OutputTokens += other.OutputTokens
	c.ReasoningTokens += other.ReasoningTokens
	c.CacheReadTokens += other.CacheReadTokens
	c.CacheCreationTokens += other.CacheCreationTokens
	c.TotalTokens += other.TotalTokens
	c.UsageSamples += other.UsageSamples
	c.LatencyTotalMS += other.LatencyTotalMS
	c.LatencySamples += other.LatencySamples
	c.TTFTTotalMS += other.TTFTTotalMS
	c.TTFTSamples += other.TTFTSamples
	c.FastRequested += other.FastRequested
	c.FastActual += other.FastActual
	if len(other.Models) > 0 {
		if c.Models == nil {
			c.Models = make(map[string]int64)
		}
		for model, count := range other.Models {
			c.Models[model] += count
		}
	}
	c.LastRequestAt = laterRFC3339(c.LastRequestAt, other.LastRequestAt)
	if laterRFC3339(c.LastErrorAt, other.LastErrorAt) == other.LastErrorAt && other.LastErrorAt != "" {
		c.LastErrorAt = other.LastErrorAt
		c.LastErrorStatus = other.LastErrorStatus
	}
}

func (c usageCounter) runtimeUsage() RuntimeUsage {
	usage := RuntimeUsage{
		Window:              "today",
		Requests:            c.Requests,
		Successes:           c.Successes,
		Errors:              c.Errors,
		InputTokens:         c.InputTokens,
		OutputTokens:        c.OutputTokens,
		ReasoningTokens:     c.ReasoningTokens,
		CacheReadTokens:     c.CacheReadTokens,
		CacheCreationTokens: c.CacheCreationTokens,
		TotalTokens:         c.TotalTokens,
		FastRequested:       c.FastRequested,
		FastActual:          c.FastActual,
		UsageSamples:        c.UsageSamples,
		TopModel:            topModel(c.Models),
		LastRequestAt:       c.LastRequestAt,
		LastErrorAt:         c.LastErrorAt,
		LastErrorStatus:     c.LastErrorStatus,
	}
	if c.LatencySamples > 0 {
		usage.AverageLatencyMS = float64(c.LatencyTotalMS) / float64(c.LatencySamples)
	}
	if c.TTFTSamples > 0 {
		usage.AverageTTFTMS = float64(c.TTFTTotalMS) / float64(c.TTFTSamples)
	}
	return usage
}

func (s *usageStore) pruneLocked(now time.Time) {
	cutoff := now.AddDate(0, 0, -usageRetentionDays).UTC().Truncate(time.Hour)
	for key := range s.state.Buckets {
		hour, err := time.Parse(time.RFC3339, key)
		if err != nil || hour.Before(cutoff) {
			delete(s.state.Buckets, key)
		}
	}
}

func (s *usageStore) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(s.state)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(s.path), ".usage-*.json")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err = temp.Chmod(0o600); err == nil {
		_, err = temp.Write(data)
	}
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tempPath, s.path)
}

type usageCollector struct {
	baseURL  string
	key      string
	interval time.Duration
	client   *http.Client
	store    *usageStore
	mu       sync.Mutex
	status   string
	lastErr  string
}

func newUsageCollector(cfg Config, client *http.Client, store *usageStore) *usageCollector {
	if store == nil || strings.TrimSpace(cfg.CLIProxyManagementKey) == "" {
		return nil
	}
	interval := cfg.UsagePollInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	return &usageCollector{
		baseURL:  strings.TrimRight(cfg.CLIProxyURL, "/"),
		key:      cfg.CLIProxyManagementKey,
		interval: interval,
		client:   client,
		store:    store,
		status:   "starting",
	}
}

func (c *usageCollector) run(ctx context.Context) {
	if c == nil {
		return
	}
	c.poll(ctx)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.poll(ctx)
		}
	}
}

func (c *usageCollector) poll(ctx context.Context) {
	for page := 0; page < 20; page++ {
		records, err := c.fetch(ctx)
		if err != nil {
			c.setStatus("error", "CPA 请求统计暂时不可用")
			return
		}
		if len(records) == 0 {
			c.setStatus("ok", "")
			return
		}
		if err = c.store.add(records, time.Now()); err != nil {
			c.setStatus("error", "CPA 请求统计暂时无法保存")
			return
		}
		c.setStatus("ok", "")
		if len(records) < usageQueueBatchSize {
			return
		}
	}
}

func (c *usageCollector) fetch(ctx context.Context) ([]nativeUsageRecord, error) {
	endpoint := fmt.Sprintf("%s/v0/management/usage-queue?count=%d", c.baseURL, usageQueueBatchSize)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.key)
	request.Header.Set("Accept", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("usage queue returned %d", response.StatusCode)
	}
	var records []nativeUsageRecord
	decoder := json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024))
	if err = decoder.Decode(&records); err != nil {
		return nil, err
	}
	return records, nil
}

func (c *usageCollector) publicStatus() (string, string) {
	if c == nil {
		return "not_configured", ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status, c.lastErr
}

func (c *usageCollector) setStatus(status, message string) {
	c.mu.Lock()
	c.status = status
	c.lastErr = message
	c.mu.Unlock()
}

func authRuntimeIndex(provider, authDir, fileName string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	path := filepath.Join(authDir, fileName)
	absPath, err := filepath.Abs(path)
	if err == nil {
		path = absPath
	}
	path = filepath.Clean(path)
	if provider == "" || path == "." {
		return ""
	}
	sum := sha256.Sum256([]byte(provider + ":" + path))
	return hex.EncodeToString(sum[:8])
}

func isFastTier(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return value == "priority" || value == "fast"
}

func topModel(models map[string]int64) string {
	if len(models) == 0 {
		return ""
	}
	keys := make([]string, 0, len(models))
	for model := range models {
		keys = append(keys, model)
	}
	sort.Strings(keys)
	best := ""
	var count int64
	for _, model := range keys {
		if models[model] > count {
			best = model
			count = models[model]
		}
	}
	return best
}

func latestTimestamp(current string, candidate time.Time) string {
	return laterRFC3339(current, candidate.UTC().Format(time.RFC3339))
}

func laterRFC3339(left, right string) string {
	if left == "" {
		return right
	}
	if right == "" {
		return left
	}
	leftTime, leftErr := time.Parse(time.RFC3339, left)
	rightTime, rightErr := time.Parse(time.RFC3339, right)
	if leftErr == nil && rightErr == nil && rightTime.After(leftTime) {
		return right
	}
	return left
}

func maxInt64(value, minimum int64) int64 {
	if value < minimum {
		return minimum
	}
	return value
}
