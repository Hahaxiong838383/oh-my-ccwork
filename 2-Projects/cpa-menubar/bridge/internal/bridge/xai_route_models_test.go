package bridge

import (
	"reflect"
	"testing"
)

func TestCurrentRouteModelsDoNotComeFromHistoricalUsage(t *testing.T) {
	summary := routerSummary{
		Providers: []routerProviderDebug{
			{ID: "xai-main", RouteModel: "grok-4.5", UpstreamModel: "grok-4.7", TokensToday: 9, DailyTokenLimit: 100},
			{ID: "xai-main", RouteModel: "grok-4.7", UpstreamModel: "grok-4.7", TokensToday: 9, DailyTokenLimit: 100},
		},
		ByProvider: []routerUsageBucket{{Name: "xai-main", Requests: 139}},
		ByModel:    []routerUsageBucket{{Name: "grok-4.5", Requests: 128}},
	}
	usage, ok := aggregateXAIUsage(summary)
	if !ok || !reflect.DeepEqual(usage.RouteUpstreamModels, []string{"grok-4.7"}) {
		t.Fatalf("unexpected route models: %v", usage.RouteUpstreamModels)
	}
	if usage.Requests != 139 || usage.TodayTokens != 9 || usage.DailyTokenLimit != 100 {
		t.Fatalf("historical counters changed or duplicated: %+v", usage)
	}
	var copied XAIUsage
	copyXAIRouterUsage(&copied, usage)
	usage.RouteUpstreamModels[0] = "changed"
	if !reflect.DeepEqual(copied.RouteUpstreamModels, []string{"grok-4.7"}) {
		t.Fatalf("route models were not independently copied: %v", copied.RouteUpstreamModels)
	}
}

func TestRouteModelsRetainMixedTargetsForSharedProvider(t *testing.T) {
	usage, _ := aggregateXAIUsage(routerSummary{Providers: []routerProviderDebug{
		{ID: "xai-main", RouteModel: "grok-4.7", UpstreamModel: "grok-4.7"},
		{ID: "xai-main", RouteModel: "grok-4.6", UpstreamModel: "grok-4.6"},
	}})
	if !reflect.DeepEqual(usage.RouteUpstreamModels, []string{"grok-4.6", "grok-4.7"}) {
		t.Fatalf("mixed routes hidden: %v", usage.RouteUpstreamModels)
	}
}

func TestMissingRouteTargetDoesNotFallBackToAliasOrHistory(t *testing.T) {
	usage, _ := aggregateXAIUsage(routerSummary{
		Providers: []routerProviderDebug{{ID: "xai-main", RouteModel: "grok-4.5"}},
		ByModel:   []routerUsageBucket{{Name: "grok-4.7", Requests: 1}},
	})
	if len(usage.RouteUpstreamModels) != 0 {
		t.Fatalf("invented route target: %v", usage.RouteUpstreamModels)
	}
}

func TestRouteModelProjectionRejectsSpecializedAndNonModelValues(t *testing.T) {
	for _, model := range []string{"grok-imagine-image", "grok-video", "grok-build-0.1", "grok-composer-2.5-fast", "https://example.com/grok-secret", "grok-4.7 secret", "grok-4.7\nsecret"} {
		usage, _ := aggregateXAIUsage(routerSummary{Providers: []routerProviderDebug{{ID: "xai-main", UpstreamModel: model}}})
		if len(usage.RouteUpstreamModels) != 0 {
			t.Fatalf("unexpected public model projection for %q", model)
		}
	}
}
