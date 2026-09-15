package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	xaiAccountBillingURL   = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
	xaiGrokClientVersion   = "0.2.91"
	xaiGrokUserAgent       = "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)"
	xaiAccountResponseSize = 512 * 1024
)

func (s *Server) fetchXAIAccountQuota(ctx context.Context, file authFile) *XAIAccountQuota {
	return s.fetchXAIAccountQuotaURL(ctx, file, xaiAccountBillingURL)
}

func (s *Server) fetchXAIAccountQuotaURL(ctx context.Context, file authFile, endpoint string) *XAIAccountQuota {
	quota := &XAIAccountQuota{
		Status:    "unavailable",
		Source:    "xai_cli_billing",
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		quota.Error = "request_error"
		return quota
	}
	request.Header.Set("Authorization", "Bearer "+file.AccessToken)
	request.Header.Set("x-xai-token-auth", "xai-grok-cli")
	request.Header.Set("x-grok-client-version", xaiGrokClientVersion)
	request.Header.Set("Accept", "*/*")
	request.Header.Set("User-Agent", xaiGrokUserAgent)
	if file.Subject != "" {
		request.Header.Set("x-userid", file.Subject)
	}

	response, err := s.client.Do(request)
	if err != nil {
		quota.Error = "network_error"
		return quota
	}
	defer response.Body.Close()
	data, err := readLimited(response.Body, xaiAccountResponseSize)
	if err != nil {
		quota.Error = "response_error"
		return quota
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		quota.Status = fmt.Sprintf("http_%d", response.StatusCode)
		quota.Error = publicXAIAccountQuotaError(response.StatusCode)
		return quota
	}

	parsed, err := parseXAIAccountQuota(data)
	if err != nil {
		quota.Error = "invalid_response"
		return quota
	}
	parsed.Status = "ok"
	parsed.Source = quota.Source
	parsed.UpdatedAt = quota.UpdatedAt
	return parsed
}

func parseXAIAccountQuota(data []byte) (*XAIAccountQuota, error) {
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	config, ok := payload["config"].(map[string]any)
	if !ok {
		return nil, errors.New("missing xAI billing config")
	}
	period := xaiMapValue(config["currentPeriod"])
	if len(period) == 0 {
		period = xaiMapValue(config["current_period"])
	}
	periodType := strings.ToLower(stringValue(period["type"]))
	if !strings.Contains(periodType, "weekly") {
		return nil, errors.New("xAI billing response did not contain a weekly period")
	}

	products := make([]XAIProductQuota, 0)
	productValues, _ := config["productUsage"].([]any)
	if productValues == nil {
		productValues, _ = config["product_usage"].([]any)
	}
	for _, value := range productValues {
		product := xaiMapValue(value)
		name := xaiSafeLabel(stringValue(product["product"]))
		if name == "" {
			continue
		}
		used := xaiNumberValue(product["usagePercent"])
		if used == nil {
			used = xaiNumberValue(product["usage_percent"])
		}
		products = append(products, XAIProductQuota{Product: name, UsedPercent: clampPercent(used)})
	}

	used := xaiNumberValue(config["creditUsagePercent"])
	if used == nil {
		used = xaiNumberValue(config["credit_usage_percent"])
	}
	used = clampPercent(used)
	inferred := false
	if used == nil && len(products) == 0 {
		zero := 0.0
		used = &zero
		inferred = true
	}
	var remaining *float64
	if used != nil {
		value := 100 - *used
		remaining = clampPercent(&value)
	}

	return &XAIAccountQuota{
		PeriodType:       "weekly",
		UsedPercent:      used,
		RemainingPercent: remaining,
		UsageInferred:    inferred,
		PeriodStart:      stringValue(period["start"]),
		PeriodEnd:        stringValue(period["end"]),
		ProductUsage:     products,
		OnDemandCapUSD:   xaiCentsUSD(config["onDemandCap"], config["on_demand_cap"]),
		OnDemandUsedUSD:  xaiCentsUSD(config["onDemandUsed"], config["on_demand_used"]),
		PrepaidBalanceUSD: xaiCentsUSD(
			config["prepaidBalance"],
			config["prepaid_balance"],
		),
		UnifiedBilling: xaiBoolPointer(config["isUnifiedBillingUser"], config["is_unified_billing_user"]),
	}, nil
}

func publicXAIAccountQuotaError(status int) string {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "authorization_required"
	case http.StatusTooManyRequests:
		return "rate_limited"
	default:
		return "upstream_unavailable"
	}
}

func xaiMapValue(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func xaiNumberValue(value any) *float64 {
	if nested := xaiMapValue(value); len(nested) > 0 {
		return xaiNumberValue(nested["val"])
	}
	var parsed float64
	switch typed := value.(type) {
	case float64:
		parsed = typed
	case json.Number:
		value, err := typed.Float64()
		if err != nil {
			return nil
		}
		parsed = value
	case string:
		value, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return nil
		}
		parsed = value
	default:
		return nil
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return nil
	}
	return &parsed
}

func clampPercent(value *float64) *float64 {
	if value == nil {
		return nil
	}
	clamped := math.Max(0, math.Min(100, *value))
	return &clamped
}

func xaiCentsUSD(values ...any) *float64 {
	for _, value := range values {
		if cents := xaiNumberValue(value); cents != nil {
			usd := *cents / 100
			return &usd
		}
	}
	return nil
}

func xaiBoolPointer(values ...any) *bool {
	for _, value := range values {
		if typed, ok := value.(bool); ok {
			return &typed
		}
	}
	return nil
}

func xaiSafeLabel(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\n", " "), "\r", " "))
	runes := []rune(value)
	if len(runes) > 64 {
		value = string(runes[:64])
	}
	return value
}
