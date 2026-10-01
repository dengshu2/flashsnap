// Package gemini is a minimal streaming client for the Google Gemini
// generateContent API.
package gemini

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL is the public Gemini API endpoint.
const DefaultBaseURL = "https://generativelanguage.googleapis.com/v1beta"

// ErrRateLimited means the API quota was exhausted.
var ErrRateLimited = errors.New("gemini: rate limited")

// Usage is what one call consumed. Thinking tokens are billed as output.
type Usage struct {
	Model         string
	InputTokens   int
	OutputTokens  int
	ThoughtTokens int
}

// Turn is one message of a conversation: role "user" or "model".
type Turn struct {
	Role string
	Text string
}

// Client calls the Gemini API.
type Client struct {
	key, model, baseURL string
	http                *http.Client
}

// New returns a client for model. baseURL may be empty for the public API.
func New(key, model, baseURL string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	// No overall timeout: a streamed card takes a while. Callers pass a context.
	return &Client{key: key, model: model, baseURL: baseURL, http: &http.Client{}}
}

// Model is the configured model name.
func (c *Client) Model() string { return c.model }

// Stream generates a reply to the conversation, calling onText with each new
// piece of visible text as it arrives, and returns the whole text. Usage is
// returned whenever the call was billed, also alongside an error.
func (c *Client) Stream(ctx context.Context, system string, turns []Turn, maxTokens int, onText func(string)) (string, Usage, error) {
	req := request{
		SystemInstruction: &content{Parts: []part{{Text: system}}},
		GenerationConfig:  generationConfig{MaxOutputTokens: maxTokens},
	}
	for _, t := range turns {
		req.Contents = append(req.Contents, content{Role: t.Role, Parts: []part{{Text: t.Text}}})
	}
	body, err := json.Marshal(req)
	if err != nil {
		return "", Usage{}, fmt.Errorf("gemini: marshal request: %w", err)
	}

	var (
		resp *http.Response
		u    = Usage{Model: c.model}
	)
	// One retry for transient upstream failures before anything was streamed.
	for attempt := 0; ; attempt++ {
		resp, err = c.post(ctx, body)
		if err == nil || attempt == 1 || !retryable(err) {
			break
		}
		select {
		case <-ctx.Done():
			return "", u, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	if err != nil {
		return "", u, err
	}
	defer resp.Body.Close()

	var (
		out    strings.Builder
		finish string
	)
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		var chunk response
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return out.String(), u, fmt.Errorf("gemini: decode chunk: %w", err)
		}
		if chunk.Error != nil {
			return out.String(), u, fmt.Errorf("gemini: %s: %s", chunk.Error.Status, chunk.Error.Message)
		}
		if m := chunk.UsageMetadata; m.PromptTokenCount > 0 || m.CandidatesTokenCount > 0 {
			u.InputTokens, u.OutputTokens, u.ThoughtTokens = m.PromptTokenCount, m.CandidatesTokenCount, m.ThoughtsTokenCount
		}
		if chunk.PromptFeedback != nil && chunk.PromptFeedback.BlockReason != "" {
			return out.String(), u, fmt.Errorf("gemini: prompt blocked: %s", chunk.PromptFeedback.BlockReason)
		}
		for _, cand := range chunk.Candidates {
			for _, p := range cand.Content.Parts {
				if p.Thought || p.Text == "" {
					continue
				}
				out.WriteString(p.Text)
				if onText != nil {
					onText(p.Text)
				}
			}
			if cand.FinishReason != "" {
				finish = cand.FinishReason
			}
		}
	}
	if err := sc.Err(); err != nil {
		return out.String(), u, fmt.Errorf("gemini: read stream: %w", err)
	}
	switch finish {
	case "STOP":
		return out.String(), u, nil
	case "MAX_TOKENS":
		return out.String(), u, errors.New("gemini: the reply hit the output limit")
	case "":
		return out.String(), u, errors.New("gemini: the stream ended without finishing")
	default:
		return out.String(), u, fmt.Errorf("gemini: generation stopped: %s", finish)
	}
}

type statusError struct {
	code int
	msg  string
}

func (e *statusError) Error() string { return fmt.Sprintf("gemini: HTTP %d: %s", e.code, e.msg) }

func retryable(err error) bool {
	var se *statusError
	return errors.As(err, &se) && se.code >= 500
}

func (c *Client) post(ctx context.Context, body []byte) (*http.Response, error) {
	url := fmt.Sprintf("%s/models/%s:streamGenerateContent?alt=sse", c.baseURL, c.model)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("gemini: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", c.key)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gemini: request failed: %w", err)
	}
	if resp.StatusCode == http.StatusOK {
		return resp, nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("%w: %.200s", ErrRateLimited, raw)
	}
	msg := string(raw)
	var e response
	if json.Unmarshal(raw, &e) == nil && e.Error != nil {
		msg = e.Error.Status + ": " + e.Error.Message
	}
	return nil, &statusError{code: resp.StatusCode, msg: fmt.Sprintf("%.300s", msg)}
}

// ── Wire types ────────────────────────────────────────────────────────────────

type request struct {
	SystemInstruction *content         `json:"systemInstruction,omitempty"`
	Contents          []content        `json:"contents"`
	GenerationConfig  generationConfig `json:"generationConfig"`
}

type content struct {
	Role  string `json:"role,omitempty"`
	Parts []part `json:"parts"`
}

type part struct {
	Text    string `json:"text,omitempty"`
	Thought bool   `json:"thought,omitempty"`
}

type generationConfig struct {
	MaxOutputTokens int `json:"maxOutputTokens,omitempty"`
}

type response struct {
	Candidates []struct {
		Content      content `json:"content"`
		FinishReason string  `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
		ThoughtsTokenCount   int `json:"thoughtsTokenCount"`
	} `json:"usageMetadata"`
	PromptFeedback *struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error"`
}
