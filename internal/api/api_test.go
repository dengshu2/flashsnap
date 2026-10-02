package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"flashsnap/internal/auth"
	"flashsnap/internal/llm"
	"flashsnap/internal/prompt"
	"flashsnap/internal/render"
	"flashsnap/internal/store"
)

const goodCard = `<!doctype html><html><head><style>.card{width:600px}</style></head><body><article class="card"><h1>番茄工作法</h1><p>25 分钟</p></article></body></html>`
const wideCard = `<!doctype html><html><body><article class="card"><h1>TOO-WIDE</h1></article></body></html>`

// fakeModel writes the wide card first when the text asks for it, and the
// good card otherwise (including when asked to fix the wide one).
type fakeModel struct {
	mu    sync.Mutex
	calls [][]llm.Turn
	fail  error
}

func (m *fakeModel) Model() string { return "deepseek-flash" }

func (m *fakeModel) Stream(_ context.Context, system string, turns []llm.Turn, _ int, onText func(string)) (string, llm.Usage, error) {
	m.mu.Lock()
	m.calls = append(m.calls, turns)
	m.mu.Unlock()
	u := llm.Usage{Model: "deepseek-flash", InputTokens: 800, OutputTokens: 2000, ThoughtTokens: 500}
	if m.fail != nil {
		return "", u, m.fail
	}
	reply := "```html\n" + goodCard + "\n```"
	if len(turns) == 1 && strings.Contains(turns[0].Text, "宽") {
		reply = wideCard
	}
	if onText != nil {
		r := []rune(reply) // the API streams whole characters
		for i := 0; i < len(r); i += 40 {
			onText(string(r[i:min(i+40, len(r))]))
		}
	}
	return reply, u, nil
}

type fakeRenderer struct{}

func (fakeRenderer) Render(_ context.Context, doc string) (render.Result, error) {
	return render.Result{PNG: []byte("PNG:" + doc[:20]), Thumb: []byte("JPG"), Width: 600, Height: 812,
		MinFont: 16, Overflow: strings.Contains(doc, "TOO-WIDE")}, nil
}

type harness struct {
	t     *testing.T
	srv   *httptest.Server
	model *fakeModel
	dir   string
	token string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	hash, _ := auth.HashPassword("password1")
	st.CreateUser("me@example.com", hash)
	lib, err := prompt.Load()
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, model: &fakeModel{}, dir: filepath.Join(dir, "cards")}
	h.srv = httptest.NewServer(Handler(Deps{
		Store: st, Auth: auth.NewService(st, "secret"), Model: h.model, Renderer: fakeRenderer{},
		Prompts: lib, ImageDir: h.dir,
		Static: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("static")) }),
	}))
	t.Cleanup(h.srv.Close)
	resp, body := h.do("POST", "/api/auth/login", "", map[string]string{"email": "Me@Example.com ", "password": "password1"})
	if resp.StatusCode != 200 {
		t.Fatalf("login: %d %s", resp.StatusCode, body)
	}
	var s struct{ Token string }
	json.Unmarshal(body, &s)
	h.token = s.Token
	return h
}

func (h *harness) do(method, path, token string, body any) (*http.Response, []byte) {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp, out
}

type sseEvent struct {
	name string
	data map[string]any
}

func parseSSE(t *testing.T, body []byte) []sseEvent {
	t.Helper()
	var out []sseEvent
	for _, block := range strings.Split(strings.TrimSpace(string(body)), "\n\n") {
		var ev sseEvent
		for _, line := range strings.Split(block, "\n") {
			if v, ok := strings.CutPrefix(line, "event: "); ok {
				ev.name = v
			} else if v, ok := strings.CutPrefix(line, "data: "); ok {
				if err := json.Unmarshal([]byte(v), &ev.data); err != nil {
					t.Fatalf("bad event data %q", v)
				}
			}
		}
		out = append(out, ev)
	}
	return out
}

func names(evs []sseEvent) string {
	var n []string
	for i, e := range evs {
		if e.name == "delta" && i > 0 && evs[i-1].name == "delta" {
			continue
		}
		n = append(n, e.name)
		if s, ok := e.data["stage"].(string); ok {
			n[len(n)-1] += ":" + s
		}
	}
	return strings.Join(n, " ")
}

func TestCreateCardStreamsAndSaves(t *testing.T) {
	h := newHarness(t)
	resp, body := h.do("POST", "/api/cards", h.token, map[string]string{"text": "番茄工作法：25 分钟专注", "style": "editorial"})
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("create: %d %s", resp.StatusCode, body)
	}
	evs := parseSSE(t, body)
	if got := names(evs); got != "stage:writing delta stage:rendering done" {
		t.Fatalf("events = %s", got)
	}
	var streamed strings.Builder
	for _, e := range evs {
		if e.name == "delta" {
			streamed.WriteString(e.data["text"].(string))
		}
	}
	if !strings.Contains(streamed.String(), "番茄工作法") {
		t.Errorf("deltas did not carry the HTML")
	}
	card := evs[len(evs)-1].data["card"].(map[string]any)
	id := card["id"].(string)
	if card["title"] != "番茄工作法" || card["style"] != "editorial" || card["height"].(float64) != 812 || card["html"] != nil {
		t.Errorf("card = %v", card)
	}
	if !strings.Contains(h.model.calls[0][0].Text, "番茄工作法") {
		t.Errorf("the model got %q", h.model.calls[0][0].Text)
	}

	// Saved: listed, readable with its cleaned HTML, images served without login.
	_, body = h.do("GET", "/api/cards?limit=10", h.token, nil)
	if !strings.Contains(string(body), id) || !strings.Contains(string(body), `"total":1`) {
		t.Errorf("list = %s", body)
	}
	_, body = h.do("GET", "/api/cards/"+id, h.token, nil)
	if !strings.Contains(string(body), `class=\"card\"`) || strings.Contains(string(body), "```") {
		t.Errorf("card html not stored clean: %s", body)
	}
	resp, body = h.do("GET", "/img/"+id+".png", "", nil)
	if resp.StatusCode != 200 || !strings.HasPrefix(string(body), "PNG:") || !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Errorf("image: %d %q", resp.StatusCode, body)
	}
	resp, _ = h.do("GET", "/img/"+id+".png?download=1", "", nil)
	if !strings.Contains(resp.Header.Get("Content-Disposition"), "attachment") {
		t.Errorf("download disposition = %q", resp.Header.Get("Content-Disposition"))
	}
	if resp, _ := h.do("GET", "/img/"+id+".jpg", "", nil); resp.StatusCode != 200 {
		t.Errorf("thumbnail: %d", resp.StatusCode)
	}

	// Usage was recorded and priced.
	_, body = h.do("GET", "/api/usage?days=7", h.token, nil)
	var rep struct {
		Total usageStats            `json:"total"`
		ByOp  map[string]usageStats `json:"by_op"`
	}
	json.Unmarshal(body, &rep)
	if rep.Total.Calls != 1 || rep.Total.CostUSD <= 0 || rep.ByOp["generate"].ThoughtTokens != 500 {
		t.Errorf("usage = %s", body)
	}

	// Delete removes the row and the files.
	if resp, _ := h.do("DELETE", "/api/cards/"+id, h.token, nil); resp.StatusCode != 204 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(h.dir, id+".png")); !os.IsNotExist(err) {
		t.Errorf("image file left behind: %v", err)
	}
	if resp, _ := h.do("GET", "/img/"+id+".png", "", nil); resp.StatusCode != 404 {
		t.Errorf("deleted image still served: %d", resp.StatusCode)
	}
}

func TestBrokenCardIsFixedOnce(t *testing.T) {
	h := newHarness(t)
	_, body := h.do("POST", "/api/cards", h.token, map[string]string{"text": "一张很宽的卡", "style": "auto"})
	evs := parseSSE(t, body)
	if got := names(evs); got != "stage:writing delta stage:rendering stage:fixing stage:rendering done" {
		t.Fatalf("events = %s", got)
	}
	if n := len(h.model.calls); n != 2 {
		t.Fatalf("model calls = %d", n)
	}
	repair := h.model.calls[1]
	if len(repair) != 3 || repair[1].Role != "assistant" || !strings.Contains(repair[2].Text, "横向超出") {
		t.Errorf("repair turns = %+v", repair)
	}
	if card := evs[len(evs)-1].data["card"].(map[string]any); card["title"] != "番茄工作法" {
		t.Errorf("the fixed version should be saved: %v", card)
	}
	_, body = h.do("GET", "/api/usage", h.token, nil)
	if !strings.Contains(string(body), `"repair":{"calls":1`) {
		t.Errorf("repair not recorded: %s", body)
	}
}

func TestCreateCardErrors(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		body map[string]string
		code int
		msg  string
	}{
		{map[string]string{"text": "  "}, 400, "请输入"},
		{map[string]string{"text": strings.Repeat("字", maxTextRunes+1)}, 400, "不能超过"},
		{map[string]string{"text": "hi", "style": "nope"}, 400, "没有这种风格"},
	}
	for _, c := range cases {
		resp, body := h.do("POST", "/api/cards", h.token, c.body)
		if resp.StatusCode != c.code || !strings.Contains(string(body), c.msg) {
			t.Errorf("%v: %d %s", c.body, resp.StatusCode, body)
		}
	}
	if resp, _ := h.do("POST", "/api/cards", "", map[string]string{"text": "hi"}); resp.StatusCode != 401 {
		t.Errorf("without a token: %d", resp.StatusCode)
	}

	h.model.fail = llm.ErrRateLimited
	_, body := h.do("POST", "/api/cards", h.token, map[string]string{"text": "hi"})
	evs := parseSSE(t, body)
	last := evs[len(evs)-1]
	if last.name != "error" || !strings.Contains(last.data["message"].(string), "太频繁") {
		t.Errorf("rate limit event = %+v", last)
	}
	h.model.fail = errors.New("boom")
	_, body = h.do("GET", "/api/cards", h.token, nil)
	if !strings.Contains(string(body), `"total":0`) {
		t.Errorf("a failed card must not be saved: %s", body)
	}
}

func TestLoginAndRoutes(t *testing.T) {
	h := newHarness(t)
	if resp, body := h.do("POST", "/api/auth/login", "", map[string]string{"email": "me@example.com", "password": "wrong-pass"}); resp.StatusCode != 401 || !strings.Contains(string(body), "邮箱或密码错误") {
		t.Errorf("bad password: %d %s", resp.StatusCode, body)
	}
	if resp, _ := h.do("POST", "/api/auth/register", "", map[string]string{"email": "x@y.co", "password": "password1"}); resp.StatusCode != 404 {
		t.Errorf("there is no sign-up: %d", resp.StatusCode)
	}
	resp, body := h.do("GET", "/api/styles", h.token, nil)
	if resp.StatusCode != 200 || !strings.HasPrefix(string(body), `[{"id":"auto"`) {
		t.Errorf("styles: %s", body)
	}
	for _, p := range []string{"/api/cards/notanid", "/api/cards/" + strings.Repeat("a", 26)} {
		if resp, _ := h.do("GET", p, h.token, nil); resp.StatusCode != 404 {
			t.Errorf("GET %s: %d", p, resp.StatusCode)
		}
	}
	for _, p := range []string{"/img/t.db", "/img/abc.png", "/img/" + strings.Repeat("a", 26) + ".gif", "/img/" + strings.Repeat("a", 25) + "1.png"} {
		if resp, _ := h.do("GET", p, "", nil); resp.StatusCode != 404 {
			t.Errorf("GET %s: %d", p, resp.StatusCode)
		}
	}
	resp, _ = h.do("GET", "/frame.html", "", nil)
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") || strings.Contains(csp, "script-src") {
		t.Errorf("frame CSP = %q", csp)
	}
	resp, _ = h.do("GET", "/", "", nil)
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "frame-src 'self'") {
		t.Errorf("page CSP = %q", csp)
	}
}
