package bridge

import (
	"errors"
	"os"
	"strings"
	"time"
)

type Config struct {
	Listen           string
	AuthDir          string
	DesktopToken     string
	DesktopTokenFile string
	CLIProxyURL      string
	RouterURL        string
	UsageTimeout     time.Duration
	OAuthTimeout     time.Duration
}

func LoadConfig() (Config, error) {
	cfg := Config{
		Listen:           envOr("CPA_DESKTOP_LISTEN", "127.0.0.1:8330"),
		AuthDir:          envOr("CPA_AUTH_DIR", "/root/.cli-proxy-api"),
		DesktopToken:     strings.TrimSpace(os.Getenv("CPA_DESKTOP_TOKEN")),
		DesktopTokenFile: envOr("CPA_DESKTOP_TOKEN_FILE", "/etc/cpa-desktop-bridge.token"),
		CLIProxyURL:      envOr("CPA_CLIPROXY_URL", "http://127.0.0.1:8317"),
		RouterURL:        envOr("CPA_ROUTER_URL", "http://127.0.0.1:8327"),
		UsageTimeout:     15 * time.Second,
		OAuthTimeout:     5 * time.Minute,
	}

	if cfg.DesktopToken == "" && cfg.DesktopTokenFile != "" {
		data, err := os.ReadFile(cfg.DesktopTokenFile)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return Config{}, err
		}
		cfg.DesktopToken = strings.TrimSpace(string(data))
	}
	if len(cfg.DesktopToken) < 32 {
		return Config{}, errors.New("CPA desktop token must contain at least 32 characters")
	}
	return cfg, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
