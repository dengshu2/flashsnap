// Package config loads runtime settings from the environment.
package config

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

// Config holds every tunable the server reads at startup.
type Config struct {
	Port    string
	DataDir string // the SQLite database and rendered images

	JWTSecret      string
	UmamiWebsiteID string

	DeepSeekAPIKey  string
	DeepSeekModel   string
	DeepSeekBaseURL string // empty: DeepSeek's public endpoint

	ChromePath        string // empty: look the browser up on PATH
	RenderConcurrency int
}

// Load reads the environment and validates required values.
func Load() (Config, error) {
	c := Config{
		Port:    env("PORT", "8080"),
		DataDir: env("DATA_DIR", "./data"),

		JWTSecret:      os.Getenv("JWT_SECRET"),
		UmamiWebsiteID: os.Getenv("UMAMI_WEBSITE_ID"),

		DeepSeekAPIKey:  os.Getenv("DEEPSEEK_API_KEY"),
		DeepSeekModel:   env("DEEPSEEK_MODEL", "deepseek-flash"),
		DeepSeekBaseURL: os.Getenv("DEEPSEEK_BASE_URL"),

		ChromePath:        os.Getenv("CHROME_PATH"),
		RenderConcurrency: envInt("RENDER_CONCURRENCY", 2),
	}
	var missing []string
	if c.JWTSecret == "" {
		missing = append(missing, "JWT_SECRET")
	}
	if c.DeepSeekAPIKey == "" {
		missing = append(missing, "DEEPSEEK_API_KEY")
	}
	if len(missing) > 0 {
		return Config{}, errors.New("missing required environment variables: " + strings.Join(missing, ", "))
	}
	return c, nil
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}
