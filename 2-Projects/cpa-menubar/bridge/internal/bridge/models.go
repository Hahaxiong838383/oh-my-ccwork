package bridge

import (
	"encoding/json"
	"time"
)

type Account struct {
	ID                string          `json:"id"`
	Provider          string          `json:"provider"`
	EmailMasked       string          `json:"email_masked"`
	Plan              string          `json:"plan,omitempty"`
	Disabled          bool            `json:"disabled"`
	ExpiredAt         string          `json:"expired_at,omitempty"`
	LastRefreshAt     string          `json:"last_refresh_at,omitempty"`
	HasRefreshToken   bool            `json:"has_refresh_token"`
	IsK12             bool            `json:"is_k12"`
	Usage             json.RawMessage `json:"usage,omitempty"`
	UsageStatus       string          `json:"usage_status"`
	UsageError        string          `json:"usage_error,omitempty"`
	SubscriptionUntil string          `json:"subscription_until,omitempty"`
}

type Summary struct {
	GeneratedAt   time.Time       `json:"generated_at"`
	AccountsTotal int             `json:"accounts_total"`
	CodexAccounts int             `json:"codex_accounts"`
	XAIAccounts   int             `json:"xai_accounts"`
	K12Accounts   int             `json:"k12_accounts"`
	Refreshable   int             `json:"refreshable_accounts"`
	Expired       int             `json:"expired_accounts"`
	Services      map[string]bool `json:"services"`
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

type ResetCreditRequest struct {
	Confirm string `json:"confirm"`
}

type ResetCreditResponse struct {
	AccountID string `json:"account_id"`
	Status    string `json:"status"`
}
