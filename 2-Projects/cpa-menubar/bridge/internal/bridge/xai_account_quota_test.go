package bridge

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchXAIAccountQuota(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer access-token" {
			t.Fatal("missing xAI authorization header")
		}
		if request.Header.Get("x-userid") != "user-subject" {
			t.Fatal("missing xAI user ID header")
		}
		if request.Header.Get("x-xai-token-auth") != "xai-grok-cli" {
			t.Fatal("missing xAI CLI auth marker")
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
            "config": {
                "currentPeriod": {"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-12T09:00:22Z","end":"2026-09-19T09:00:22Z"},
                "creditUsagePercent": 43,
                "productUsage": [
                    {"product":"GrokBuild","usagePercent":40},
                    {"product":"GrokChat","usagePercent":2},
                    {"product":"GrokImagine","usagePercent":1}
                ],
                "onDemandCap":{"val":"5000"},
                "onDemandUsed":{"val":"125"},
                "prepaidBalance":{"val":"300"},
                "isUnifiedBillingUser":true
            }
        }`))
	}))
	defer upstream.Close()

	server := &Server{client: upstream.Client()}
	quota := server.fetchXAIAccountQuotaURL(context.Background(), authFile{
		AccessToken: "access-token",
		Subject:     "user-subject",
	}, upstream.URL)
	if quota.Status != "ok" || quota.UsedPercent == nil || *quota.UsedPercent != 43 {
		t.Fatalf("quota = %#v", quota)
	}
	if quota.RemainingPercent == nil || *quota.RemainingPercent != 57 {
		t.Fatalf("remaining = %#v", quota.RemainingPercent)
	}
	if len(quota.ProductUsage) != 3 || quota.ProductUsage[0].Product != "GrokBuild" {
		t.Fatalf("products = %#v", quota.ProductUsage)
	}
	if quota.OnDemandCapUSD == nil || *quota.OnDemandCapUSD != 50 {
		t.Fatalf("on-demand cap = %#v", quota.OnDemandCapUSD)
	}
	if quota.OnDemandUsedUSD == nil || *quota.OnDemandUsedUSD != 1.25 {
		t.Fatalf("on-demand used = %#v", quota.OnDemandUsedUSD)
	}
	if quota.PrepaidBalanceUSD == nil || *quota.PrepaidBalanceUSD != 3 {
		t.Fatalf("prepaid balance = %#v", quota.PrepaidBalanceUSD)
	}
	if quota.UnifiedBilling == nil || !*quota.UnifiedBilling {
		t.Fatalf("unified billing = %#v", quota.UnifiedBilling)
	}
}

func TestParseXAIAccountQuotaInfersUnusedWeeklyPeriod(t *testing.T) {
	quota, err := parseXAIAccountQuota([]byte(`{
        "config": {
            "currentPeriod": {"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-13T06:34:56Z","end":"2026-09-20T06:34:56Z"},
            "productUsage": [],
            "onDemandCap":{"val":"0"},
            "onDemandUsed":{"val":"0"}
        }
    }`))
	if err != nil {
		t.Fatal(err)
	}
	if !quota.UsageInferred || quota.UsedPercent == nil || *quota.UsedPercent != 0 {
		t.Fatalf("quota = %#v", quota)
	}
	if quota.RemainingPercent == nil || *quota.RemainingPercent != 100 {
		t.Fatalf("remaining = %#v", quota.RemainingPercent)
	}
}

func TestFetchXAIAccountQuotaDoesNotExposeErrorBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
		_, _ = response.Write([]byte(`{"error":"sensitive upstream detail"}`))
	}))
	defer upstream.Close()

	server := &Server{client: upstream.Client()}
	quota := server.fetchXAIAccountQuotaURL(context.Background(), authFile{AccessToken: "token"}, upstream.URL)
	if quota.Status != "http_401" || quota.Error != "authorization_required" {
		t.Fatalf("quota = %#v", quota)
	}
}
