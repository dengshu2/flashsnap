package store

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "sub", "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestUsers(t *testing.T) {
	s := openTest(t)
	u, err := s.CreateUser("a@b.co", "h1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser("a@b.co", "h2"); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("duplicate: %v", err)
	}
	if err := s.SetPassword("a@b.co", "h3"); err != nil {
		t.Fatal(err)
	}
	got, hash, ok, err := s.UserByEmail("a@b.co")
	if !ok || err != nil || got.ID != u.ID || hash != "h3" {
		t.Fatalf("UserByEmail = %+v %q %v %v", got, hash, ok, err)
	}
	if err := s.SetPassword("x@y.co", "h"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetPassword unknown: %v", err)
	}
}

func TestCards(t *testing.T) {
	s := openTest(t)
	a, _ := s.CreateUser("a@b.co", "h")
	b, _ := s.CreateUser("c@d.co", "h")
	base := time.Now().Add(-time.Hour)
	var ids []string
	for i := 0; i < 5; i++ {
		c := Card{ID: NewID(), Text: fmt.Sprintf("原文 %d", i), Style: "minimal", Title: fmt.Sprintf("标题 %d", i),
			HTML: "<p>x</p>", Width: 600, Height: 800, Model: "m", CreatedAt: base.Add(time.Duration(i) * time.Minute)}
		if i == 3 {
			c.Title = "番茄工作法"
		}
		if err := s.InsertCard(a.ID, c); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, c.ID)
	}
	if len(ids[0]) != 26 || ids[0] == ids[1] {
		t.Fatalf("ids %v", ids[:2])
	}

	p, err := s.Cards(a.ID, "", 2, 0)
	if err != nil || p.Total != 5 || len(p.Items) != 2 || !p.HasMore || p.Items[0].ID != ids[4] || p.Items[0].HTML != "" {
		t.Fatalf("page 1 = %+v, %v", p, err)
	}
	p, _ = s.Cards(a.ID, "", 2, 4)
	if len(p.Items) != 1 || p.HasMore {
		t.Fatalf("last page = %+v", p)
	}
	if p, _ := s.Cards(a.ID, "番茄", 10, 0); p.Total != 1 || p.Items[0].ID != ids[3] {
		t.Fatalf("search by title = %+v", p)
	}
	if p, _ := s.Cards(a.ID, "原文 1", 10, 0); p.Total != 1 {
		t.Fatalf("search by text = %+v", p)
	}
	if p, _ := s.Cards(a.ID, "%", 10, 0); p.Total != 0 {
		t.Fatalf("a literal %% must not match everything: %+v", p)
	}
	if p, _ := s.Cards(b.ID, "", 10, 0); p.Total != 0 {
		t.Fatal("cards leaked to another user")
	}

	c, err := s.Card(a.ID, ids[2])
	if err != nil || c.HTML != "<p>x</p>" || c.Text != "原文 2" {
		t.Fatalf("Card = %+v, %v", c, err)
	}
	if _, err := s.Card(b.ID, ids[2]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another user's card: %v", err)
	}
	if err := s.DeleteCard(b.ID, ids[2]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete another user's card: %v", err)
	}
	if err := s.DeleteCard(a.ID, ids[2]); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Cards(a.ID, "", 10, 0); p.Total != 4 {
		t.Fatalf("after delete total = %d", p.Total)
	}
}

func TestUsage(t *testing.T) {
	s := openTest(t)
	u, _ := s.CreateUser("a@b.co", "h")
	now := time.Now()
	s.InsertUsage(u.ID, UsageEvent{Op: "generate", Model: "m", InputTokens: 10, OutputTokens: 20, CostUSD: 0.5, CreatedAt: now.Add(-48 * time.Hour)})
	s.InsertUsage(u.ID, UsageEvent{Op: "repair", Model: "m", InputTokens: 1, CreatedAt: now})
	ev, err := s.UsageSince(u.ID, now.Add(-time.Hour))
	if err != nil || len(ev) != 1 || ev[0].Op != "repair" {
		t.Fatalf("UsageSince = %+v, %v", ev, err)
	}
}
