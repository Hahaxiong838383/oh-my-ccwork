package bridge

import (
	"encoding/json"
	"time"
)

type Account struct {
	ID                string           `json:"id"`
	Provider          string           `json:"provider"`
	EmailMasked       string           `json:"email_masked"`
	Plan              string           `json:"plan,omitempty"`
	Disabled          bool             `json:"disabled"`
	ExpiredAt         string           `json:"expired_at,omitempty"`
	LastRefreshAt     string           `json:"last_refresh_at,omitempty"`
	HasRefreshToken   bool             `json:"has_refresh_token"`
	IsK12             bool             `json:"is_k12"`
	Usage             json.RawMessage  `json:"usage,omitempty"`
	UsageStatus       string           `json:"usage_status"`
	UsageError        string           `json:"usage_error,omitempty"`
	RuntimeUsage      *RuntimeUsage    `json:"runtime_usage,omitempty"`
	XAIQuota          *XAIAccountQuota `json:"xai_quota,omitempty"`
	SubscriptionUntil string           `json:"subscription_until,omitempty"`
	RemovalEligible   bool             `json:"removal_eligible"`
	RemovalReason     string           `json:"removal_reason,omitempty"`
}

type Summary struct {
	GeneratedAt        time.Time       `json:"generated_at"`
	AccountsTotal      int             `json:"accounts_total"`
	CodexAccounts      int             `json:"codex_accounts"`
	XAIAccounts        int             `json:"xai_accounts"`
	K12Accounts        int             `json:"k12_accounts"`
	Refreshable        int             `json:"refreshable_accounts"`
	Expired            int             `json:"expired_accounts"`
	Services           map[string]bool `json:"services"`
	CodexUsage         *RuntimeUsage   `json:"codex_usage,omitempty"`
	CodexUsageStatus   string          `json:"codex_usage_status"`
	CodexUsageError    string          `json:"codex_usage_error,omitempty"`
	APIKeyBudgets      []APIKeyBudget  `json:"api_key_budgets,omitempty"`
	APIKeyBudgetStatus string          `json:"api_key_budget_status"`
	APIKeyBudgetError  string          `json:"api_key_budget_error,omitempty"`
	XAIUsage           *XAIUsage       `json:"xai_usage,omitempty"`
	XAIUsageStatus     string          `json:"xai_usage_status"`
	XAIUsageError      string          `json:"xai_usage_error,omitempty"`
}

type APIKeyBudget struct {
	ID                        string   `json:"id"`
	Name                      string   `json:"name"`
	Enabled                   bool     `json:"enabled"`
	RPM                       int      `json:"rpm"`
	ModelCount                int      `json:"model_count"`
	DailyLimitUSD             float64  `json:"daily_limit_usd"`
	WeeklyLimitUSD            float64  `json:"weekly_limit_usd"`
	DailySpendUSD             *float64 `json:"daily_spend_usd,omitempty"`
	WeeklySpendUSD            *float64 `json:"weekly_spend_usd,omitempty"`
	DailyRemainingUSD         *float64 `json:"daily_remaining_usd,omitempty"`
	WeeklyRemainingUSD        *float64 `json:"weekly_remaining_usd,omitempty"`
	EffectiveRemainingUSD     *float64 `json:"effective_remaining_usd,omitempty"`
	EffectiveRemainingPercent *float64 `json:"effective_remaining_percent,omitempty"`
	UsageStatus               string   `json:"usage_status"`
	UsageError                string   `json:"usage_error,omitempty"`
}

type RuntimeUsage struct {
	Window              string  `json:"window"`
	Requests            int64   `json:"requests"`
	Successes           int64   `json:"successes"`
	Errors              int64   `json:"errors"`
	InputTokens         int64   `json:"input_tokens"`
	OutputTokens        int64   `json:"output_tokens"`
	ReasoningTokens     int64   `json:"reasoning_tokens"`
	CacheReadTokens     int64   `json:"cache_read_tokens"`
	CacheCreationTokens int64   `json:"cache_creation_tokens"`
	TotalTokens         int64   `json:"total_tokens"`
	AverageLatencyMS    float64 `json:"average_latency_ms"`
	AverageTTFTMS       float64 `json:"average_ttft_ms"`
	FastRequested       int64   `json:"fast_requested"`
	FastActual          int64   `json:"fast_actual"`
	UsageSamples        int64   `json:"usage_samples"`
	TopModel            string  `json:"top_model,omitempty"`
	LastRequestAt       string  `json:"last_request_at,omitempty"`
	LastErrorAt         string  `json:"last_error_at,omitempty"`
	LastErrorStatus     int     `json:"last_error_status,omitempty"`
}

type XAIUsage struct {
	OfficialStatus       string   `json:"official_status"`
	OfficialError        string   `json:"official_error,omitempty"`
	OfficialPeriodStart  string   `json:"official_period_start,omitempty"`
	OfficialPeriodEnd    string   `json:"official_period_end,omitempty"`
	OfficialSpendUSD     *float64 `json:"official_spend_usd,omitempty"`
	PrepaidBalanceUSD    *float64 `json:"prepaid_balance_usd,omitempty"`
	HasPrepaidCredit     *bool    `json:"has_prepaid_credit,omitempty"`
	OfficialLimitReached bool     `json:"official_limit_reached"`
	CPAStatus            string   `json:"cpa_status"`
	CPAError             string   `json:"cpa_error,omitempty"`
	WindowHours          int      `json:"window_hours"`
	Requests             int64    `json:"requests"`
	Successes            int64    `json:"successes"`
	Errors               int64    `json:"errors"`
	InputTokens          int64    `json:"input_tokens"`
	OutputTokens         int64    `json:"output_tokens"`
	TotalTokens          int64    `json:"total_tokens"`
	TodayTokens          int64    `json:"today_tokens"`
	DailyTokenLimit      int64    `json:"daily_token_limit"`
	LastRequestAt        string   `json:"last_request_at,omitempty"`
}

type XAIAccountQuota struct {
	Status            string            `json:"status"`
	Error             string            `json:"error,omitempty"`
	Source            string            `json:"source,omitempty"`
	PeriodType        string            `json:"period_type,omitempty"`
	UsedPercent       *float64          `json:"used_percent,omitempty"`
	RemainingPercent  *float64          `json:"remaining_percent,omitempty"`
	UsageInferred     bool              `json:"usage_inferred"`
	PeriodStart       string            `json:"period_start,omitempty"`
	PeriodEnd         string            `json:"period_end,omitempty"`
	ProductUsage      []XAIProductQuota `json:"product_usage,omitempty"`
	OnDemandCapUSD    *float64          `json:"on_demand_cap_usd,omitempty"`
	OnDemandUsedUSD   *float64          `json:"on_demand_used_usd,omitempty"`
	PrepaidBalanceUSD *float64          `json:"prepaid_balance_usd,omitempty"`
	UnifiedBilling    *bool             `json:"unified_billing,omitempty"`
	UpdatedAt         string            `json:"updated_at,omitempty"`
}

type XAIProductQuota struct {
	Product     string   `json:"product"`
	UsedPercent *float64 `json:"used_percent,omitempty"`
}

type AccountsResponse struct {
	GeneratedAt time.Time `json:"generated_at"`
	Accounts    []Account `json:"accounts"`
}

type OAuthStartResponse struct {
	State       string    `json:"state"`
	URL         string    `json:"url"`
	CallbackURL string    `json:"callback_url"`
	ExpiresAt   time.Time `json:"expires_at"`
}

type OAuthCallbackRequest struct {
	State       string `json:"state"`
	Code        string `json:"code"`
	RedirectURL string `json:"redirect_url"`
}

type OAuthStatusResponse struct {
	State         string `json:"state"`
	Status        string `json:"status"`
	Message       string `json:"message,omitempty"`
	AccountMasked string `json:"account_masked,omitempty"`
}

type XAIOAuthStartResponse struct {
	State           string `json:"state"`
	VerificationURL string `json:"verification_url"`
	UserCode        string `json:"user_code"`
	ExpiresIn       int    `json:"expires_in"`
	Status          string `json:"status"`
}

type XAIOAuthStatusResponse struct {
	State         string `json:"state"`
	Status        string `json:"status"`
	Message       string `json:"message,omitempty"`
	AccountMasked string `json:"account_masked,omitempty"`
}

type ResetCreditRequest struct {
	Confirm string `json:"confirm"`
}

type ResetCreditResponse struct {
	AccountID    string `json:"account_id"`
	Status       string `json:"status"`
	WindowsReset int    `json:"windows_reset,omitempty"`
}

type RemoveAccountRequest struct {
	Confirm string `json:"confirm"`
}

type RemoveAccountResponse struct {
	AccountID string `json:"account_id"`
	Status    string `json:"status"`
}
