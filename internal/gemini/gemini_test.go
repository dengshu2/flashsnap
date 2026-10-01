package gemini

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func sse(w http.ResponseWriter, chunks ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, c := range chunks {
		fmt.Fprintf(w, "data: %s\r\n\r\n", c)
	}
}

func TestStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models/m:streamGenerateContent" || r.URL.Query().Get("alt") != "sse" || r.Header.Get("x-goog-api-key") != "k" {
			t.Errorf("request %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		var req map[string]any
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &req)
		if n := len(req["contents"].([]any)); n != 3 {
			t.Errorf("contents = %d turns", n)
		}
		sse(w,
			`{"candidates":[{"content":{"parts":[{"text":"thinking…","thought":true}]}}]}`,
			`{"candidates":[{"content":{"parts":[{"text":"<!doctype html>"}]}}]}`,
			`{"candidates":[{"content":{"parts":[{"text":"<p>hi</p>"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"thoughtsTokenCount":5}}`,
		)
	}))
	defer srv.Close()
	c := New("k", "m", srv.URL)
	var pieces []string
	text, u, err := c.Stream(context.Background(), "sys", []Turn{{"user", "a"}, {"model", "b"}, {"user", "c"}}, 100, func(s string) { pieces = append(pieces, s) })
	if err != nil || text != "<!doctype html><p>hi</p>" || len(pieces) != 2 {
		t.Fatalf("Stream = %q, %v, pieces %q", text, err, pieces)
	}
	if u != (Usage{Model: "m", InputTokens: 10, OutputTokens: 20, ThoughtTokens: 5}) {
		t.Errorf("usage = %+v", u)
	}
}

func TestStreamCutOff(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sse(w, `{"candidates":[{"content":{"parts":[{"text":"<html>"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}`)
	}))
	defer srv.Close()
	_, u, err := New("k", "m", srv.URL).Stream(context.Background(), "s", []Turn{{"user", "x"}}, 10, nil)
	if err == nil || !strings.Contains(err.Error(), "output limit") || u.OutputTokens != 2 {
		t.Fatalf("err = %v, usage %+v", err, u)
	}
}

func TestStreamErrors(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		switch {
		case strings.Contains(r.URL.Path, "busy"):
			w.WriteHeader(http.StatusTooManyRequests)
		case n == 1:
			w.WriteHeader(http.StatusServiceUnavailable) // retried once
			w.Write([]byte(`{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}`))
		default:
			sse(w, `{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}`)
		}
	}))
	defer srv.Close()
	if text, _, err := New("k", "m", srv.URL).Stream(context.Background(), "s", []Turn{{"user", "x"}}, 10, nil); err != nil || text != "ok" {
		t.Fatalf("after a 503: %q, %v", text, err)
	}
	if _, _, err := New("k", "busy", srv.URL).Stream(context.Background(), "s", []Turn{{"user", "x"}}, 10, nil); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
}
