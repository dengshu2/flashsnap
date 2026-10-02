package deepseek

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"flashsnap/internal/llm"
)

func serve(t *testing.T, h http.HandlerFunc) *Client {
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return New("k", "deepseek-flash", srv.URL)
}

func sse(w http.ResponseWriter, lines ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, l := range lines {
		fmt.Fprintf(w, "data: %s\n\n", l)
	}
}

func TestStream(t *testing.T) {
	var got request
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer k" {
			t.Errorf("unexpected request %s %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		json.NewDecoder(r.Body).Decode(&got)
		sse(w,
			`{"model":"deepseek-flash","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}`,
			`{"choices":[{"delta":{"content":"<html>"},"finish_reason":null}],"usage":null}`,
			`{"choices":[{"delta":{"content":"</html>"},"finish_reason":"stop"}],"usage":{"prompt_tokens":900,"completion_tokens":2000,"prompt_cache_hit_tokens":640}}`,
			`[DONE]`)
	})
	var pieces []string
	out, u, err := c.Stream(context.Background(), "sys", []llm.Turn{{Role: "user", Text: "a"}, {Role: "assistant", Text: "b"}, {Role: "user", Text: "c"}}, 16384, func(s string) { pieces = append(pieces, s) })
	if err != nil {
		t.Fatal(err)
	}
	if out != "<html></html>" || strings.Join(pieces, "|") != "<html>|</html>" {
		t.Fatalf("out %q pieces %q", out, pieces)
	}
	if u != (llm.Usage{Model: "deepseek-flash", InputTokens: 900, CachedTokens: 640, OutputTokens: 2000}) {
		t.Fatalf("usage %+v", u)
	}
	roles := []string{}
	for _, m := range got.Messages {
		roles = append(roles, m.Role)
	}
	if strings.Join(roles, ",") != "system,user,assistant,user" || !got.Stream || !got.StreamOptions.IncludeUsage || got.Thinking.Type != "disabled" || got.MaxTokens != 16384 {
		t.Fatalf("request %+v", got)
	}
}

func TestStreamCutOff(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"<ht"},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":5}}`)
	})
	out, u, err := c.Stream(context.Background(), "s", []llm.Turn{{Role: "user", Text: "x"}}, 5, nil)
	if err == nil || out != "<ht" || u.OutputTokens != 5 {
		t.Fatalf("got %q %+v %v", out, u, err)
	}
}

func TestErrors(t *testing.T) {
	calls := 0
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"error":{"message":"busy"}}`))
			return
		}
		w.WriteHeader(http.StatusTooManyRequests)
	})
	if _, _, err := c.Stream(context.Background(), "s", nil, 1, nil); err == nil || !strings.Contains(err.Error(), "HTTP 503: busy") || calls != 2 {
		t.Fatalf("5xx: %v after %d calls", err, calls)
	}
	if _, _, err := c.Stream(context.Background(), "s", nil, 1, nil); !errors.Is(err, llm.ErrRateLimited) {
		t.Fatalf("429: %v", err)
	}
}
