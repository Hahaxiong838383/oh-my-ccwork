package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	xaiAuthorizationHost = "accounts.x.ai"
	xaiOAuthMaxExpiresIn = 3600
	xaiOAuthMaxStateSize = 512
	xaiOAuthMaxCodeSize  = 128
	xaiOAuthMaxURLSize   = 4096
)

type xaiOAuthSession struct {
	State     string
	ExpiresAt time.Time
}

type xaiOAuthStartUpstream struct {
	State     string `json:"state"`
	URL       string `json:"url"`
	UserCode  string `json:"user_code"`
	ExpiresIn int    `json:"expires_in"`
	Flow      string `json:"flow"`
	Status    string `json:"status"`
}

type xaiOAuthStatusUpstream struct {
	Status string `json:"status"`
	Error  string `json:"error"`
}

func (s *Server) handleXAIOAuthStart(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(s.cfg.CLIProxyManagementKey) == "" {
		writeError(w, http.StatusServiceUnavailable, "xAI authorization is unavailable")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.UsageTimeout)
	defer cancel()
	upstream, err := s.fetchXAIOAuthStart(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, "xAI authorization is unavailable")
		return
	}

	expiresAt := time.Now().Add(time.Duration(upstream.ExpiresIn) * time.Second)
	s.mu.Lock()
	s.xaiSession = &xaiOAuthSession{State: upstream.State, ExpiresAt: expiresAt}
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, XAIOAuthStartResponse{
		State:           upstream.State,
		VerificationURL: upstream.URL,
		UserCode:        upstream.UserCode,
		ExpiresIn:       upstream.ExpiresIn,
		Status:          "pending",
	})
}

func (s *Server) handleXAIOAuthStatus(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" || len(state) > xaiOAuthMaxStateSize {
		writeError(w, http.StatusBadRequest, "state is required")
		return
	}

	now := time.Now()
	s.mu.Lock()
	session := s.xaiSession
	if session != nil && now.After(session.ExpiresAt) {
		s.xaiSession = nil
	}
	s.mu.Unlock()
	if session == nil || session.State != state {
		writeError(w, http.StatusNotFound, "xAI authorization session not found")
		return
	}
	if now.After(session.ExpiresAt) {
		writeJSON(w, http.StatusOK, XAIOAuthStatusResponse{State: state, Status: "expired", Message: "xAI authorization expired"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.UsageTimeout)
	defer cancel()
	upstream, err := s.fetchXAIOAuthStatus(ctx, state)
	if err != nil {
		writeError(w, http.StatusBadGateway, "xAI authorization status is unavailable")
		return
	}

	response := XAIOAuthStatusResponse{State: state}
	switch upstream.Status {
	case "wait":
		response.Status = "pending"
	case "ok":
		response.Status = "complete"
		s.clearXAIOAuthSession(state)
	case "error":
		response.Status = "error"
		response.Message = "xAI authorization failed"
		s.clearXAIOAuthSession(state)
	default:
		writeError(w, http.StatusBadGateway, "xAI authorization status is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) fetchXAIOAuthStart(ctx context.Context) (xaiOAuthStartUpstream, error) {
	endpoint := strings.TrimRight(s.cfg.CLIProxyURL, "/") + "/v0/management/xai-auth-url?is_webui=true"
	var response xaiOAuthStartUpstream
	if err := s.fetchXAIOAuthJSON(ctx, endpoint, &response); err != nil {
		return xaiOAuthStartUpstream{}, err
	}
	verificationURL, err := url.Parse(strings.TrimSpace(response.URL))
	if err != nil || verificationURL.Scheme != "https" || !strings.EqualFold(verificationURL.Hostname(), xaiAuthorizationHost) || verificationURL.Port() != "" || verificationURL.User != nil {
		return xaiOAuthStartUpstream{}, errors.New("invalid xAI verification URL")
	}
	response.State = strings.TrimSpace(response.State)
	response.UserCode = strings.TrimSpace(response.UserCode)
	if response.Flow != "device" || response.State == "" || len(response.State) > xaiOAuthMaxStateSize || response.UserCode == "" || len(response.UserCode) > xaiOAuthMaxCodeSize || len(response.URL) > xaiOAuthMaxURLSize || response.ExpiresIn < 1 || response.ExpiresIn > xaiOAuthMaxExpiresIn {
		return xaiOAuthStartUpstream{}, errors.New("invalid xAI authorization response")
	}
	response.URL = verificationURL.String()
	return response, nil
}

func (s *Server) fetchXAIOAuthStatus(ctx context.Context, state string) (xaiOAuthStatusUpstream, error) {
	endpoint := strings.TrimRight(s.cfg.CLIProxyURL, "/") + "/v0/management/get-auth-status?" + url.Values{"state": {state}}.Encode()
	var response xaiOAuthStatusUpstream
	if err := s.fetchXAIOAuthJSON(ctx, endpoint, &response); err != nil {
		return xaiOAuthStatusUpstream{}, err
	}
	return response, nil
}

func (s *Server) fetchXAIOAuthJSON(ctx context.Context, endpoint string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
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
	data, err := readLimited(response.Body, 64*1024)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("xAI OAuth upstream returned %d", response.StatusCode)
	}
	if err = json.Unmarshal(data, target); err != nil {
		return errors.New("invalid xAI OAuth upstream response")
	}
	return nil
}

func (s *Server) clearXAIOAuthSession(state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.xaiSession != nil && s.xaiSession.State == state {
		s.xaiSession = nil
	}
}
