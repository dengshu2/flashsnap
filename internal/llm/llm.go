// Package llm holds what the card writer needs from the model.
package llm

import (
	"context"
	"errors"
)

// ErrRateLimited means the provider asked us to slow down.
var ErrRateLimited = errors.New("llm: rate limited")

// Turn is one message of a conversation: role "user" or "assistant".
type Turn struct {
	Role string
	Text string
}

// Usage is what one call consumed. Thinking tokens are billed as output;
// CachedTokens is the part of InputTokens served from the provider's cache.
type Usage struct {
	Model         string
	InputTokens   int
	CachedTokens  int
	OutputTokens  int
	ThoughtTokens int
}

// Model streams a reply: onText receives each new piece of visible text,
// and the whole text is returned. Usage comes back whenever the call was
// billed, also alongside an error.
type Model interface {
	Stream(ctx context.Context, system string, turns []Turn, maxTokens int, onText func(string)) (string, Usage, error)
	Model() string
}
