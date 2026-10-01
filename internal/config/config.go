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

	GeminiAPIKey string
	GeminiModel  string

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

		GeminiAPIKey: os.Getenv("GEMINI_API_KEY"),
		GeminiModel:  env("GEMINI_MODEL", "gemini-3.8-flash"),

		ChromePath:        os.Getenv("CHROME_PATH"),
		RenderConcurrency: envInt("RENDER_CONCURRENCY", 2),
	}
	var missing []string
	if c.JWTSecret == "" {
		missing = append(missing, "JWT_SECRET")
	}
	if c.GeminiAPIKey == "" {
		missing = append(missing, "GEMINI_API_KEY")
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
