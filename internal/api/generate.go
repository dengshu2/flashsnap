package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"flashsnap/internal/auth"
	"flashsnap/internal/cardhtml"
	"flashsnap/internal/gemini"
	"flashsnap/internal/prompt"
	"flashsnap/internal/render"
	"flashsnap/internal/store"
	"flashsnap/internal/usage"
)

const (
	maxTextRunes    = 4000
	maxOutputTokens = 16384
	jobTimeout      = 4 * time.Minute

	opGenerate = "generate"
	opRepair   = "repair"
)

// Limits the rendered card is held to (a little looser than the prompt asks,
// so a near miss is not sent back).
const (
	maxHeight  = 1100
	minFontPx  = 13
	tallTarget = 1000
)

// createCard handles POST /api/cards {text, style} and answers with a stream
// of server-sent events while the card is made:
//
//	stage {stage: writing|rendering|fixing}
//	delta {text}        the next piece of the model's HTML
//	done  {card}        the saved card (its image is at /img/<id>.png)
//	error {message}
//
// The work is detached from the request: a reader who leaves still gets the
// card in their history.
func (s *server) createCard(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text  string `json:"text"`
		Style string `json:"style"`
	}
	if !decode(w, r, &req) {
		return
	}
	text := strings.TrimSpace(req.Text)
	switch {
	case text == "":
		respondError(w, http.StatusBadRequest, "请输入要做成卡片的文字")
		return
	case utf8.RuneCountInString(text) > maxTextRunes:
		respondError(w, http.StatusBadRequest, fmt.Sprintf("文字不能超过 %d 个字", maxTextRunes))
		return
	}
	if req.Style == "" {
		req.Style = prompt.Auto
	}
	if !s.Prompts.Valid(req.Style) {
		respondError(w, http.StatusBadRequest, "没有这种风格")
		return
	}

	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(time.Now().Add(jobTimeout + time.Minute))
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc.Flush()

	events := make(chan event, 64)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), jobTimeout)
	go func() {
		defer cancel()
		defer close(events)
		s.makeCard(ctx, auth.UserID(r), text, req.Style, func(name string, data any) { events <- event{name, data} })
	}()

	gone := false
	for ev := range events {
		if gone {
			continue // keep draining so the work can finish
		}
		payload, _ := json.Marshal(ev.data)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.name, payload); err != nil {
			gone = true
			continue
		}
		if rc.Flush() != nil {
			gone = true
		}
	}
}

type event struct {
	name string
	data any
}

// makeCard writes, renders, checks (fixing once if needed) and saves a card.
func (s *server) makeCard(ctx context.Context, userID, text, style string, emit func(string, any)) {
	fail := func(msg string, err error) {
		if err != nil {
			log.Printf("card: %s: %v", msg, err)
		}
		emit("error", map[string]string{"message": msg})
	}

	system, err := s.Prompts.System(style)
	if err != nil {
		fail("没有这种风格", err)
		return
	}
	turns := []gemini.Turn{{Role: "user", Text: text}}
	emit("stage", map[string]string{"stage": "writing"})
	reply, u, err := s.Model.Stream(ctx, system, turns, maxOutputTokens, func(t string) {
		emit("delta", map[string]string{"text": t})
	})
	s.record(userID, opGenerate, u)
	if err != nil {
		fail(modelError(err), err)
		return
	}
	doc, title, err := cardhtml.Clean(cardhtml.Extract(reply))
	if err != nil {
		fail("这次没有生成出卡片，请再试一次", err)
		return
	}

	emit("stage", map[string]string{"stage": "rendering"})
	res, err := s.Renderer.Render(ctx, doc)
	if err != nil {
		fail("卡片渲染失败，请再试一次", err)
		return
	}

	if problems := check(res); len(problems) > 0 {
		emit("stage", map[string]any{"stage": "fixing", "problems": problems})
		turns = append(turns, gemini.Turn{Role: "model", Text: reply}, gemini.Turn{Role: "user", Text: prompt.Repair(problems)})
		reply2, u2, err := s.Model.Stream(ctx, system, turns, maxOutputTokens, nil)
		s.record(userID, opRepair, u2)
		if err == nil {
			doc2, title2, err := cardhtml.Clean(cardhtml.Extract(reply2))
			if err == nil {
				emit("stage", map[string]string{"stage": "rendering"})
				if res2, err := s.Renderer.Render(ctx, doc2); err == nil && len(check(res2)) <= len(problems) {
					doc, title, res = doc2, title2, res2
				}
			}
		}
		if err != nil {
			log.Printf("card: repair failed, keeping the first version: %v", err)
		}
	}

	if title == "" {
		title = string([]rune(text)[:min(24, utf8.RuneCountInString(text))])
	}
	card := store.Card{
		ID: store.NewID(), Text: text, Style: style, Title: title, HTML: doc,
		Width: res.Width, Height: res.Height, Model: s.Model.Model(), CreatedAt: time.Now(),
	}
	if err := s.saveImages(card.ID, res); err != nil {
		fail("保存卡片失败", err)
		return
	}
	if err := s.Store.InsertCard(userID, card); err != nil {
		s.removeImages(card.ID)
		fail("保存卡片失败", err)
		return
	}
	card.HTML = ""
	emit("done", map[string]any{"card": card})
}

// check lists what is wrong with a rendered card, in words the model can act on.
func check(res render.Result) []string {
	var p []string
	if res.Overflow {
		p = append(p, fmt.Sprintf("有内容横向超出了 %dpx 的卡片宽度，请让所有元素都在卡片内换行或缩短", render.Width))
	}
	if res.Height > maxHeight {
		p = append(p, fmt.Sprintf("卡片高 %dpx，超过了 %dpx 的上限：请精简内容，不要缩小字号", res.Height, tallTarget))
	}
	if res.MinFont < minFontPx {
		p = append(p, fmt.Sprintf("最小的字只有 %.0fpx，要读的字不能小于 15px", res.MinFont))
	}
	return p
}

func modelError(err error) string {
	switch {
	case errors.Is(err, gemini.ErrRateLimited):
		return "模型请求太频繁，请过一分钟再试"
	case errors.Is(err, context.DeadlineExceeded):
		return "生成超时，请再试一次"
	default:
		return "生成失败，请稍后重试"
	}
}

func (s *server) saveImages(id string, res render.Result) error {
	if err := os.MkdirAll(s.ImageDir, 0o755); err != nil {
		return err
	}
	for ext, data := range map[string][]byte{".png": res.PNG, ".jpg": res.Thumb} {
		final := filepath.Join(s.ImageDir, id+ext)
		tmp := final + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, final); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	return nil
}

func (s *server) removeImages(id string) {
	for _, ext := range []string{".png", ".jpg"} {
		os.Remove(filepath.Join(s.ImageDir, id+ext))
	}
}

// record stores one billed call; failures are only logged.
func (s *server) record(userID, op string, u gemini.Usage) {
	if userID == "" || (u.InputTokens == 0 && u.OutputTokens == 0) {
		return
	}
	now := time.Now()
	cost, known := usage.Cost(u.Model, now, u.InputTokens, u.OutputTokens+u.ThoughtTokens)
	if !known {
		log.Printf("usage: no price for model %q; recording tokens only", u.Model)
	}
	err := s.Store.InsertUsage(userID, store.UsageEvent{
		Op: op, Model: u.Model, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens,
		ThoughtTokens: u.ThoughtTokens, CostUSD: cost, CreatedAt: now,
	})
	if err != nil {
		log.Printf("usage: %v", err)
	}
}
