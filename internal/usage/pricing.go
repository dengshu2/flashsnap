// Package usage prices Gemini calls.
package usage

import "time"

// price is USD per 1M tokens, effective from `from` until the next entry.
type price struct {
	from          time.Time
	input, output float64
}

var jan2027 = time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)

// Paid-tier list prices from https://ai.google.dev/gemini-api/docs/pricing
// (checked 2026-09-29); Google announced they double on 2027-01-01.
var prices = map[string][]price{
	"gemini-3.8-flash": {
		{time.Time{}, 0.75, 3.75},
		{jan2027, 1.50, 7.50},
	},
}

// Cost returns the USD cost of a call made at `at`; thinking tokens are billed
// as output, so callers include them in `output`. known is false for models
// without a price (the cost is then 0).
func Cost(model string, at time.Time, input, output int) (usd float64, known bool) {
	tiers, ok := prices[model]
	if !ok {
		return 0, false
	}
	p := tiers[0]
	for _, t := range tiers[1:] {
		if !at.Before(t.from) {
			p = t
		}
	}
	return (float64(input)*p.input + float64(output)*p.output) / 1e6, true
}
