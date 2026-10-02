package usage

import (
	"math"
	"testing"
	"time"

	"flashsnap/internal/llm"
)

func TestCost(t *testing.T) {
	offPeak := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC) // Friday 12:00 UTC
	peak := time.Date(2026, 10, 2, 2, 0, 0, 0, time.UTC)     // Friday 02:00 UTC
	saturday := time.Date(2026, 10, 3, 2, 0, 0, 0, time.UTC)
	u := llm.Usage{Model: "deepseek-flash", InputTokens: 1_000_000, CachedTokens: 400_000, OutputTokens: 1_000_000}

	// 0.6M × 0.15 + 0.4M × 0.003 + 1M × 0.60
	want := 0.09 + 0.0012 + 0.60
	for _, c := range []struct {
		at   time.Time
		want float64
	}{{offPeak, want}, {peak, want * 2}, {saturday, want}} {
		got, known := Cost(u, c.at)
		if !known || math.Abs(got-c.want) > 1e-9 {
			t.Errorf("%s: got %v (known %v), want %v", c.at, got, known, c.want)
		}
	}

	if _, known := Cost(llm.Usage{Model: "other"}, offPeak); known {
		t.Error("an unknown model has a price")
	}
}
