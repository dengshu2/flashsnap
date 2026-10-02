// Package usage prices DeepSeek calls.
package usage

import (
	"time"

	"flashsnap/internal/llm"
)

// price is USD per 1M tokens.
type price struct {
	input, cached, output float64
}

// DeepSeek list prices from https://api-docs.deepseek.com/quick_start/pricing
// (checked 2026-09-30); peak hours cost double.
var deepseekFlash = price{input: 0.15, cached: 0.003, output: 0.60}

// Cost returns the USD cost of a call made at `at`. Thinking tokens are
// billed as output. known is false for models without a price (cost 0).
func Cost(u llm.Usage, at time.Time) (usd float64, known bool) {
	p, known := priceAt(u.Model, at)
	if !known {
		return 0, false
	}
	cached := min(u.CachedTokens, u.InputTokens)
	return (float64(u.InputTokens-cached)*p.input +
		float64(cached)*p.cached +
		float64(u.OutputTokens+u.ThoughtTokens)*p.output) / 1e6, true
}

func priceAt(model string, at time.Time) (price, bool) {
	switch model {
	case "deepseek-flash", "deepseek-v4-flash":
		if deepseekPeak(at) {
			return price{deepseekFlash.input * 2, deepseekFlash.cached * 2, deepseekFlash.output * 2}, true
		}
		return deepseekFlash, true
	}
	return price{}, false
}

// deepseekPeak reports DeepSeek's peak hours: 01:00–04:00 and 06:00–10:00 UTC,
// Monday to Friday. Chinese public holidays are off-peak too but are not
// modelled, so calls on those days are estimated high.
func deepseekPeak(at time.Time) bool {
	t := at.UTC()
	if t.Weekday() == time.Saturday || t.Weekday() == time.Sunday {
		return false
	}
	h := t.Hour()
	return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}
