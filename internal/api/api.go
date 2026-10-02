// Package api wires the HTTP routes.
package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"

	"flashsnap/internal/auth"
	"flashsnap/internal/llm"
	"flashsnap/internal/prompt"
	"flashsnap/internal/render"
	"flashsnap/internal/store"
)

// maxBody caps JSON request bodies well above any valid input.
const maxBody = 64 << 10

// Model writes card HTML.
type Model = llm.Model

// Renderer turns card HTML into images.
type Renderer interface {
	Render(ctx context.Context, doc string) (render.Result, error)
}

// Deps are the server's collaborators.
type Deps struct {
	Store    *store.Store
	Auth     *auth.Service
	Model    Model
	Renderer Renderer
	Prompts  *prompt.Library
	ImageDir string // rendered cards: <id>.png and <id>.jpg
	Static   http.Handler
}

type server struct {
	Deps
}

// Handler returns the application's root handler.
func Handler(d Deps) http.Handler {
	s := &server{Deps: d}

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(securityHeaders)

	r.Get("/health", s.health)
	r.Get("/img/{file}", s.image)

	r.Route("/api", func(r chi.Router) {
		r.With(httprate.LimitByIP(10, time.Minute)).Post("/auth/login", s.login)

		r.Group(func(r chi.Router) {
			r.Use(d.Auth.Middleware(func(w http.ResponseWriter) {
				respondError(w, http.StatusUnauthorized, "登录已过期，请重新登录")
			}))
			r.Get("/styles", s.styles)
			// Generating calls the model and a browser: cap it per user.
			r.With(httprate.Limit(10, time.Minute, httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
				return auth.UserID(r), nil
			}))).Post("/cards", s.createCard)
			r.Get("/cards", s.listCards)
			r.Get("/cards/{id}", s.getCard)
			r.Delete("/cards/{id}", s.deleteCard)
			r.Get("/usage", s.usageReport)
		})

		r.NotFound(func(w http.ResponseWriter, r *http.Request) {
			respondError(w, http.StatusNotFound, "接口不存在")
		})
	})

	r.Handle("/*", d.Static)
	return r
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.Ping(); err != nil {
		http.Error(w, "db: unhealthy", http.StatusServiceUnavailable)
		return
	}
	w.Write([]byte("ok"))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func respondJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func respondError(w http.ResponseWriter, status int, msg string) {
	respondJSON(w, status, map[string]string{"error": msg})
}

// decode reads a size-capped JSON body into v.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		respondError(w, http.StatusBadRequest, "无效的请求格式")
		return false
	}
	return true
}

// frameCSP governs the live preview frame: the card's own inline styles and
// Google Fonts, nothing else (the iframe is also sandboxed without scripts).
const frameCSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
	"font-src https://fonts.gstatic.com; img-src data:; frame-ancestors 'self'"

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		if r.URL.Path == "/frame.html" {
			h.Set("Content-Security-Policy", frameCSP)
		} else {
			h.Set("Content-Security-Policy", "default-src 'self'; "+
				// Cloudflare injects its Web Analytics beacon at the edge.
				"script-src 'self' https://umami.dengshu.ovh https://static.cloudflareinsights.com; "+
				"connect-src 'self' https://umami.dengshu.ovh https://cloudflareinsights.com; "+
				"style-src 'self' https://fonts.googleapis.com; "+
				"font-src https://fonts.gstatic.com; "+
				"img-src 'self' data: blob:; frame-src 'self'; "+
				"frame-ancestors 'self'; base-uri 'self'; form-action 'self'")
		}
		next.ServeHTTP(w, r)
	})
}
