package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

type keyPolicyListResponse struct {
	Keys []keyPolicyKey `json:"keys"`
}

type keyPolicyKey struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Enabled        bool    `json:"enabled"`
	RPM            int     `json:"rpm"`
	DailyLimitUSD  float64 `json:"daily_limit_usd"`
	WeeklyLimitUSD float64 `json:"weekly_limit_usd"`
	Models         []struct {
		Alias string `json:"alias"`
	} `json:"models"`
}

type keyPolicyUsageResponse struct {
	Aliases []struct {
		Daily struct {
			TotalUSD float64 `json:"total_usd"`
		} `json:"daily"`
		Weekly struct {
			TotalUSD float64 `json:"total_usd"`
		} `json:"weekly"`
	} `json:"aliases"`
}

func (s *Server) fetchAPIKeyBudgets(ctx context.Context) ([]APIKeyBudget, string, error) {
	if strings.TrimSpace(s.cfg.CLIProxyManagementKey) == "" {
		return nil, "not_configured", nil
	}
	var list keyPolicyListResponse
	if err := s.fetchKeyPolicyJSON(ctx, "/v0/management/plugins/cpa-key-policy/keys", &list); err != nil {
		return nil, "error", err
	}

	budgets := make([]APIKeyBudget, 0, len(list.Keys))
	status := "ok"
	for _, key := range list.Keys {
		if !key.Enabled {
			continue
		}
		budget := APIKeyBudget{
			ID:             key.ID,
			Name:           key.Name,
			Enabled:        key.Enabled,
			RPM:            key.RPM,
			ModelCount:     len(key.Models),
			DailyLimitUSD:  key.DailyLimitUSD,
			WeeklyLimitUSD: key.WeeklyLimitUSD,
			UsageStatus:    "ok",
		}
		var usage keyPolicyUsageResponse
		usagePath := "/v0/management/plugins/cpa-key-policy/keys/usage?id=" + url.QueryEscape(key.ID)
		if err := s.fetchKeyPolicyJSON(ctx, usagePath, &usage); err != nil {
			budget.UsageStatus = "error"
			budget.UsageError = "usage unavailable"
			status = "partial"
			budgets = append(budgets, budget)
			continue
		}

		dailySpend, weeklySpend := sumKeyPolicyUsage(usage)
		budget.DailySpendUSD = floatPointer(dailySpend)
		budget.WeeklySpendUSD = floatPointer(weeklySpend)
		budget.DailyRemainingUSD = remainingUSD(key.DailyLimitUSD, dailySpend)
		budget.WeeklyRemainingUSD = remainingUSD(key.WeeklyLimitUSD, weeklySpend)
		budget.EffectiveRemainingUSD, budget.EffectiveRemainingPercent = effectiveRemaining(
			key.DailyLimitUSD,
			budget.DailyRemainingUSD,
			key.WeeklyLimitUSD,
			budget.WeeklyRemainingUSD,
		)
		budgets = append(budgets, budget)
	}

	sort.SliceStable(budgets, func(i, j int) bool {
		left := budgets[i].EffectiveRemainingPercent
		right := budgets[j].EffectiveRemainingPercent
		if left == nil {
			return false
		}
		if right == nil {
			return true
		}
		if *left != *right {
			return *left < *right
		}
		return budgets[i].Name < budgets[j].Name
	})
	return budgets, status, nil
}

func (s *Server) fetchKeyPolicyJSON(ctx context.Context, path string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.cfg.CLIProxyURL, "/")+path, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+s.cfg.CLIProxyManagementKey)
	request.Header.Set("Accept", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8*1024))
		return fmt.Errorf("key policy returned %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024))
	if err = decoder.Decode(target); err != nil {
		return err
	}
	return nil
}

func sumKeyPolicyUsage(usage keyPolicyUsageResponse) (float64, float64) {
	var daily float64
	var weekly float64
	for _, alias := range usage.Aliases {
		daily += alias.Daily.TotalUSD
		weekly += alias.Weekly.TotalUSD
	}
	return daily, weekly
}

func remainingUSD(limit, spent float64) *float64 {
	if limit <= 0 {
		return nil
	}
	remaining := math.Max(0, limit-spent)
	return &remaining
}

func effectiveRemaining(dailyLimit float64, dailyRemaining *float64, weeklyLimit float64, weeklyRemaining *float64) (*float64, *float64) {
	switch {
	case dailyRemaining == nil && weeklyRemaining == nil:
		return nil, nil
	case dailyRemaining == nil:
		return weeklyRemaining, percentagePointer(*weeklyRemaining, weeklyLimit)
	case weeklyRemaining == nil:
		return dailyRemaining, percentagePointer(*dailyRemaining, dailyLimit)
	case *dailyRemaining <= *weeklyRemaining:
		return dailyRemaining, percentagePointer(*dailyRemaining, dailyLimit)
	default:
		return weeklyRemaining, percentagePointer(*weeklyRemaining, weeklyLimit)
	}
}

func percentagePointer(remaining, limit float64) *float64 {
	if limit <= 0 {
		return nil
	}
	percentage := math.Max(0, math.Min(100, remaining/limit*100))
	return &percentage
}

func floatPointer(value float64) *float64 {
	return &value
}

func publicAPIKeyBudgetError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "API Key 额度读取超时"
	}
	return "API Key 额度暂时不可用"
}
