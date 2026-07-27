package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const xaiUsageWindowHours = 24

type routerSummary struct {
	Providers  []routerProviderDebug `json:"providers"`
	ByProvider []routerUsageBucket   `json:"by_provider"`
	ByModel    []routerUsageBucket   `json:"by_model"`
}

type routerProviderDebug struct {
	ID              string `json:"id"`
	RouteModel      string `json:"route_model"`
	UpstreamModel   string `json:"upstream_model"`
	TokensToday     int64  `json:"tokens_today"`
	DailyTokenLimit int64  `json:"daily_token_limit"`
}

type routerUsageBucket struct {
	Name          string  `json:"name"`
	Requests      int64   `json:"requests"`
	Successes     int64   `json:"successes"`
	Errors        int64   `json:"errors"`
	InputTokens   int64   `json:"input_tokens"`
	OutputTokens  int64   `json:"output_tokens"`
	TotalTokens   int64   `json:"total_tokens"`
	LastRequestAt string  `json:"last_request_at"`
	SuccessRate   float64 `json:"success_rate"`
}

func (s *Server) fetchXAIUsage(ctx context.Context) (*XAIUsage, string, error) {
	if strings.TrimSpace(s.cfg.RouterAPIKey) == "" {
		return nil, "unavailable", errors.New("router API key unavailable")
	}
	url := strings.TrimRight(s.cfg.RouterURL, "/") + "/debug/summary?hours=24"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "error", err
	}
	request.Header.Set("Authorization", "Bearer "+s.cfg.RouterAPIKey)
	request.Header.Set("Accept", "application/json")

	response, err := s.client.Do(request)
	if err != nil {
		return nil, "error", err
	}
	defer response.Body.Close()
	data, err := readLimited(response.Body, 512*1024)
	if err != nil {
		return nil, "error", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Sprintf("http_%d", response.StatusCode), fmt.Errorf("router usage request returned %d", response.StatusCode)
	}

	var summary routerSummary
	if err = json.Unmarshal(data, &summary); err != nil {
		return nil, "error", err
	}
	usage, ok := aggregateXAIUsage(summary)
	if !ok {
		return nil, "unavailable", errors.New("xAI provider usage unavailable")
	}
	return &usage, "ok", nil
}

func aggregateXAIUsage(summary routerSummary) (XAIUsage, bool) {
	usage := XAIUsage{WindowHours: xaiUsageWindowHours}
	providerIDs := make(map[string]struct{})
	for _, provider := range summary.Providers {
		if !isXAIName(provider.ID) && !isXAIName(provider.RouteModel) && !isXAIName(provider.UpstreamModel) {
			continue
		}
		if _, exists := providerIDs[provider.ID]; exists {
			continue
		}
		providerIDs[provider.ID] = struct{}{}
		usage.TodayTokens += provider.TokensToday
		usage.DailyTokenLimit += provider.DailyTokenLimit
	}

	found := false
	for _, bucket := range summary.ByProvider {
		if _, ok := providerIDs[bucket.Name]; !ok {
			continue
		}
		addRouterUsage(&usage, bucket)
		found = true
	}
	if found || len(providerIDs) > 0 {
		return usage, true
	}

	for _, bucket := range summary.ByModel {
		if !isXAIName(bucket.Name) {
			continue
		}
		addRouterUsage(&usage, bucket)
		found = true
	}
	return usage, found
}

func addRouterUsage(usage *XAIUsage, bucket routerUsageBucket) {
	usage.Requests += bucket.Requests
	usage.Successes += bucket.Successes
	usage.Errors += bucket.Errors
	usage.InputTokens += bucket.InputTokens
	usage.OutputTokens += bucket.OutputTokens
	usage.TotalTokens += bucket.TotalTokens
	if laterTimestamp(bucket.LastRequestAt, usage.LastRequestAt) {
		usage.LastRequestAt = bucket.LastRequestAt
	}
}

func isXAIName(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	return strings.Contains(lower, "grok") || strings.Contains(lower, "xai")
}

func laterTimestamp(candidate, current string) bool {
	if candidate == "" {
		return false
	}
	if current == "" {
		return true
	}
	candidateTime, candidateErr := time.Parse(time.RFC3339, candidate)
	currentTime, currentErr := time.Parse(time.RFC3339, current)
	if candidateErr == nil && currentErr == nil {
		return candidateTime.After(currentTime)
	}
	return candidate > current
}

func publicRouterUsageError(err error) string {
	message := err.Error()
	if strings.Contains(message, "401") || strings.Contains(message, "403") || strings.Contains(message, "API key") {
		return "CPA 用量授权不可用"
	}
	return "CPA 暂时无法读取 xAI 用量"
}
