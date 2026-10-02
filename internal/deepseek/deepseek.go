// Package deepseek is a minimal streaming client for DeepSeek's
// OpenAI-style chat completions API.
package deepseek

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

	"flashsnap/internal/llm"
)

// DefaultBaseURL is the public DeepSeek API endpoint.
const DefaultBaseURL = "https://api.deepseek.com"

// Client calls the DeepSeek API.
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
	return &Client{key: key, model: model, baseURL: strings.TrimRight(baseURL, "/"), http: &http.Client{}}
}

// Model is the configured model name.
func (c *Client) Model() string { return c.model }

// Stream generates a reply to the conversation, calling onText with each new
// piece of text as it arrives, and returns the whole text.
func (c *Client) Stream(ctx context.Context, system string, turns []llm.Turn, maxTokens int, onText func(string)) (string, llm.Usage, error) {
	req := request{
		Model:         c.model,
		Stream:        true,
		StreamOptions: streamOptions{IncludeUsage: true},
		MaxTokens:     maxTokens,
		// Thinking costs time and tokens without making the cards better.
		Thinking: thinking{Type: "disabled"},
		Messages: []message{{Role: "system", Content: system}},
	}
	for _, t := range turns {
		req.Messages = append(req.Messages, message{Role: t.Role, Content: t.Text})
	}
	body, err := json.Marshal(req)
	if err != nil {
		return "", llm.Usage{}, fmt.Errorf("deepseek: marshal request: %w", err)
	}

	u := llm.Usage{Model: c.model}
	var resp *http.Response
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
		if !ok || data == "[DONE]" {
			continue
		}
		var chunk chunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return out.String(), u, fmt.Errorf("deepseek: decode chunk: %w", err)
		}
		if chunk.Error != nil {
			return out.String(), u, fmt.Errorf("deepseek: %s", chunk.Error.Message)
		}
		if chunk.Model != "" {
			u.Model = chunk.Model
		}
		if m := chunk.Usage; m != nil {
			reasoning := m.CompletionTokensDetails.ReasoningTokens
			u.InputTokens, u.CachedTokens = m.PromptTokens, m.PromptCacheHitTokens
			u.OutputTokens, u.ThoughtTokens = m.CompletionTokens-reasoning, reasoning
		}
		for _, choice := range chunk.Choices {
			if text := choice.Delta.Content; text != "" {
				out.WriteString(text)
				if onText != nil {
					onText(text)
				}
			}
			if choice.FinishReason != nil && *choice.FinishReason != "" {
				finish = *choice.FinishReason
			}
		}
	}
	if err := sc.Err(); err != nil {
		return out.String(), u, fmt.Errorf("deepseek: read stream: %w", err)
	}
	switch finish {
	case "stop":
		return out.String(), u, nil
	case "length":
		return out.String(), u, errors.New("deepseek: the reply hit the output limit")
	case "":
		return out.String(), u, errors.New("deepseek: the stream ended without finishing")
	default:
		return out.String(), u, fmt.Errorf("deepseek: generation stopped: %s", finish)
	}
}

type statusError struct {
	code int
	msg  string
}

func (e *statusError) Error() string { return fmt.Sprintf("deepseek: HTTP %d: %s", e.code, e.msg) }

func retryable(err error) bool {
	var se *statusError
	return errors.As(err, &se) && se.code >= 500
}

func (c *Client) post(ctx context.Context, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("deepseek: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.key)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("deepseek: request failed: %w", err)
	}
	if resp.StatusCode == http.StatusOK {
		return resp, nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("%w: %.200s", llm.ErrRateLimited, raw)
	}
	msg := string(raw)
	var e chunk
	if json.Unmarshal(raw, &e) == nil && e.Error != nil {
		msg = e.Error.Message
	}
	// 402 means the balance ran out; 400/401 are ours to fix. Only 5xx is retried.
	return nil, &statusError{code: resp.StatusCode, msg: fmt.Sprintf("%.300s", msg)}
}

// ── Wire types ────────────────────────────────────────────────────────────────

type request struct {
	Model         string        `json:"model"`
	Messages      []message     `json:"messages"`
	Stream        bool          `json:"stream"`
	StreamOptions streamOptions `json:"stream_options"`
	MaxTokens     int           `json:"max_tokens,omitempty"`
	Thinking      thinking      `json:"thinking"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type thinking struct {
	Type string `json:"type"`
}

type chunk struct {
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens            int `json:"prompt_tokens"`
		CompletionTokens        int `json:"completion_tokens"`
		PromptCacheHitTokens    int `json:"prompt_cache_hit_tokens"`
		CompletionTokensDetails struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}
