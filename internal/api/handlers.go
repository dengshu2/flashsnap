package api

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"flashsnap/internal/auth"
	"flashsnap/internal/store"
)

// ── Sign in ───────────────────────────────────────────────────────────────────

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	var c struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decode(w, r, &c) {
		return
	}
	user, token, err := s.Auth.Login(c.Email, c.Password)
	switch {
	case errors.Is(err, auth.ErrInvalidCreds):
		respondError(w, http.StatusUnauthorized, err.Error())
	case err != nil:
		log.Printf("login: %v", err)
		respondError(w, http.StatusInternalServerError, "登录失败，请稍后重试")
	default:
		respondJSON(w, http.StatusOK, map[string]any{"token": token, "user": user})
	}
}

// ── Styles and cards ──────────────────────────────────────────────────────────

func (s *server) styles(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, s.Prompts.Styles())
}

var cardID = regexp.MustCompile(`^[a-z2-7]{26}$`)

func (s *server) listCards(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, err := s.Store.Cards(auth.UserID(r), q.Get("q"), intParam(q.Get("limit"), 24, 1, 100), intParam(q.Get("offset"), 0, 0, 1<<31-1))
	if err != nil {
		log.Printf("list cards: %v", err)
		respondError(w, http.StatusInternalServerError, "获取卡片失败")
		return
	}
	respondJSON(w, http.StatusOK, page)
}

func (s *server) getCard(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !cardID.MatchString(id) {
		respondError(w, http.StatusNotFound, "卡片不存在")
		return
	}
	c, err := s.Store.Card(auth.UserID(r), id)
	if errors.Is(err, store.ErrNotFound) {
		respondError(w, http.StatusNotFound, "卡片不存在")
		return
	}
	if err != nil {
		log.Printf("get card: %v", err)
		respondError(w, http.StatusInternalServerError, "获取卡片失败")
		return
	}
	respondJSON(w, http.StatusOK, c)
}

func (s *server) deleteCard(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !cardID.MatchString(id) {
		respondError(w, http.StatusNotFound, "卡片不存在")
		return
	}
	err := s.Store.DeleteCard(auth.UserID(r), id)
	if errors.Is(err, store.ErrNotFound) {
		respondError(w, http.StatusNotFound, "卡片不存在")
		return
	}
	if err != nil {
		log.Printf("delete card: %v", err)
		respondError(w, http.StatusInternalServerError, "删除失败")
		return
	}
	for _, ext := range []string{".png", ".jpg"} {
		os.Remove(filepath.Join(s.ImageDir, id+ext))
	}
	w.WriteHeader(http.StatusNoContent)
}

var imageFile = regexp.MustCompile(`^([a-z2-7]{26})\.(png|jpg)$`)

// image serves a rendered card. Images need no login: their IDs are random
// 128-bit values, so a URL can only be known by someone it was given to.
func (s *server) image(w http.ResponseWriter, r *http.Request) {
	m := imageFile.FindStringSubmatch(chi.URLParam(r, "file"))
	if m == nil {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(s.ImageDir, m[0])
	if _, err := os.Stat(path); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if r.URL.Query().Get("download") != "" {
		name := "flashsnap-" + m[1][:8] + "." + m[2]
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, name, url.PathEscape(name)))
	}
	http.ServeFile(w, r, path)
}

// ── Usage ─────────────────────────────────────────────────────────────────────

type usageStats struct {
	Calls         int     `json:"calls"`
	InputTokens   int     `json:"input_tokens"`
	OutputTokens  int     `json:"output_tokens"`
	ThoughtTokens int     `json:"thought_tokens"`
	CostUSD       float64 `json:"cost_usd"`
}

func (st *usageStats) add(e store.UsageEvent) {
	st.Calls++
	st.InputTokens += e.InputTokens
	st.OutputTokens += e.OutputTokens
	st.ThoughtTokens += e.ThoughtTokens
	st.CostUSD += e.CostUSD
}

// usageReport handles GET /api/usage?days=30: the caller's model calls over
// the last `days` local calendar days, with today, per-op and per-day totals.
func (s *server) usageReport(w http.ResponseWriter, r *http.Request) {
	days := intParam(r.URL.Query().Get("days"), 30, 1, 366)
	now := time.Now()
	since := time.Date(now.Year(), now.Month(), now.Day()-(days-1), 0, 0, 0, 0, now.Location())
	today := now.Format(time.DateOnly)

	events, err := s.Store.UsageSince(auth.UserID(r), since)
	if err != nil {
		log.Printf("usage: %v", err)
		respondError(w, http.StatusInternalServerError, "获取用量失败")
		return
	}
	type day struct {
		Date string `json:"date"`
		usageStats
	}
	var total, todayStats usageStats
	byOp := map[string]*usageStats{opGenerate: {}, opRepair: {}}
	byDay := map[string]*day{}
	for _, e := range events {
		date := e.CreatedAt.In(now.Location()).Format(time.DateOnly)
		total.add(e)
		if date == today {
			todayStats.add(e)
		}
		if byOp[e.Op] == nil {
			byOp[e.Op] = &usageStats{}
		}
		byOp[e.Op].add(e)
		if byDay[date] == nil {
			byDay[date] = &day{Date: date}
		}
		byDay[date].add(e)
	}
	daily := make([]*day, 0, len(byDay))
	for _, d := range byDay {
		daily = append(daily, d)
	}
	sort.Slice(daily, func(i, j int) bool { return daily[i].Date > daily[j].Date })
	respondJSON(w, http.StatusOK, map[string]any{
		"days": days, "since": since.Format(time.DateOnly),
		"total": total, "today": todayStats, "by_op": byOp, "daily": daily,
	})
}

func intParam(v string, def, lo, hi int) int {
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return min(max(n, lo), hi)
}
