// Package store persists users, their cards and model usage in SQLite.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

// ErrEmailTaken is returned by CreateUser when the email already exists.
var ErrEmailTaken = errors.New("email already registered")

// ErrNotFound means the record does not exist or belongs to someone else.
var ErrNotFound = errors.New("not found")

// Store wraps the SQLite handle.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id            TEXT PRIMARY KEY,
	email         TEXT UNIQUE NOT NULL,
	password_hash TEXT NOT NULL,
	created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
	id         TEXT PRIMARY KEY,
	user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	text       TEXT NOT NULL,
	style      TEXT NOT NULL,
	title      TEXT NOT NULL,
	html       TEXT NOT NULL,
	width      INTEGER NOT NULL,
	height     INTEGER NOT NULL,
	model      TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_user_created ON cards(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	op             TEXT NOT NULL,
	model          TEXT NOT NULL,
	input_tokens   INTEGER NOT NULL DEFAULT 0,
	output_tokens  INTEGER NOT NULL DEFAULT 0,
	thought_tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd       REAL NOT NULL DEFAULT 0,
	created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_events(user_id, created_at);
`

// Open opens (or creates) the database at path and ensures the schema exists.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	// Pragmas go in the DSN so every pooled connection gets them.
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Ping checks the database connection.
func (s *Store) Ping() error { return s.db.Ping() }

// NewID returns a random, URL-safe identifier. Card images are served by ID
// without a login, so it must not be guessable (128 bits).
func NewID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

// ── Users ─────────────────────────────────────────────────────────────────────

// User is an account.
type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// CreateUser inserts a user, relying on the UNIQUE constraint to detect duplicates.
func (s *Store) CreateUser(email, passwordHash string) (User, error) {
	u := User{ID: uuid.NewString(), Email: email}
	_, err := s.db.Exec(`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		u.ID, u.Email, passwordHash, time.Now().Unix())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return User{}, ErrEmailTaken
		}
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

// UserByEmail returns the user and password hash, or ok=false if not found.
func (s *Store) UserByEmail(email string) (u User, hash string, ok bool, err error) {
	err = s.db.QueryRow(`SELECT id, email, password_hash FROM users WHERE email = ?`, email).Scan(&u.ID, &u.Email, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, "", false, nil
	}
	if err != nil {
		return User{}, "", false, fmt.Errorf("get user by email: %w", err)
	}
	return u, hash, true, nil
}

// SetPassword replaces a user's password hash.
func (s *Store) SetPassword(email, passwordHash string) error {
	res, err := s.db.Exec(`UPDATE users SET password_hash = ? WHERE email = ?`, passwordHash, email)
	if err != nil {
		return fmt.Errorf("set password: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ── Cards ─────────────────────────────────────────────────────────────────────

// Card is one generated information card. HTML is left out of lists.
type Card struct {
	ID        string    `json:"id"`
	Text      string    `json:"text"`
	Style     string    `json:"style"`
	Title     string    `json:"title"`
	HTML      string    `json:"html,omitempty"`
	Width     int       `json:"width"`
	Height    int       `json:"height"`
	Model     string    `json:"model"`
	CreatedAt time.Time `json:"created_at"`
}

// InsertCard stores a card for userID; ID and CreatedAt must be set.
func (s *Store) InsertCard(userID string, c Card) error {
	_, err := s.db.Exec(`INSERT INTO cards (id, user_id, text, style, title, html, width, height, model, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, userID, c.Text, c.Style, c.Title, c.HTML, c.Width, c.Height, c.Model, c.CreatedAt.UnixMilli())
	if err != nil {
		return fmt.Errorf("insert card: %w", err)
	}
	return nil
}

// Card returns one of userID's cards, with its HTML.
func (s *Store) Card(userID, id string) (Card, error) {
	var (
		c  Card
		ms int64
	)
	err := s.db.QueryRow(`SELECT id, text, style, title, html, width, height, model, created_at
		FROM cards WHERE id = ? AND user_id = ?`, id, userID).
		Scan(&c.ID, &c.Text, &c.Style, &c.Title, &c.HTML, &c.Width, &c.Height, &c.Model, &ms)
	if errors.Is(err, sql.ErrNoRows) {
		return Card{}, ErrNotFound
	}
	if err != nil {
		return Card{}, fmt.Errorf("get card: %w", err)
	}
	c.CreatedAt = time.UnixMilli(ms)
	return c, nil
}

// Page is one page of a card list.
type Page struct {
	Items   []Card `json:"items"`
	Total   int    `json:"total"`
	HasMore bool   `json:"has_more"`
}

// Cards lists userID's cards, newest first, optionally filtered by a search
// over the title and the source text.
func (s *Store) Cards(userID, query string, limit, offset int) (Page, error) {
	where, args := `user_id = ?`, []any{userID}
	if q := strings.TrimSpace(query); q != "" {
		pattern := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
		where += ` AND (title LIKE ? ESCAPE '\' OR text LIKE ? ESCAPE '\')`
		args = append(args, pattern, pattern)
	}
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM cards WHERE `+where, args...).Scan(&total); err != nil {
		return Page{}, fmt.Errorf("count cards: %w", err)
	}
	rows, err := s.db.Query(`SELECT id, text, style, title, width, height, model, created_at FROM cards WHERE `+where+
		` ORDER BY created_at DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return Page{}, fmt.Errorf("list cards: %w", err)
	}
	defer rows.Close()
	p := Page{Items: []Card{}, Total: total}
	for rows.Next() {
		var (
			c  Card
			ms int64
		)
		if err := rows.Scan(&c.ID, &c.Text, &c.Style, &c.Title, &c.Width, &c.Height, &c.Model, &ms); err != nil {
			return Page{}, fmt.Errorf("scan card: %w", err)
		}
		c.CreatedAt = time.UnixMilli(ms)
		p.Items = append(p.Items, c)
	}
	p.HasMore = offset+len(p.Items) < total
	return p, rows.Err()
}

// DeleteCard removes one of userID's cards.
func (s *Store) DeleteCard(userID, id string) error {
	res, err := s.db.Exec(`DELETE FROM cards WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return fmt.Errorf("delete card: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ── Usage ─────────────────────────────────────────────────────────────────────

// UsageEvent is one billed model call; CostUSD is priced when it happens.
type UsageEvent struct {
	Op            string
	Model         string
	InputTokens   int
	OutputTokens  int
	ThoughtTokens int
	CostUSD       float64
	CreatedAt     time.Time
}

// InsertUsage records an event for userID.
func (s *Store) InsertUsage(userID string, e UsageEvent) error {
	_, err := s.db.Exec(`INSERT INTO usage_events (user_id, op, model, input_tokens, output_tokens, thought_tokens, cost_usd, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		userID, e.Op, e.Model, e.InputTokens, e.OutputTokens, e.ThoughtTokens, e.CostUSD, e.CreatedAt.Unix())
	if err != nil {
		return fmt.Errorf("insert usage: %w", err)
	}
	return nil
}

// UsageSince returns userID's events at or after since, oldest first.
func (s *Store) UsageSince(userID string, since time.Time) ([]UsageEvent, error) {
	rows, err := s.db.Query(`SELECT op, model, input_tokens, output_tokens, thought_tokens, cost_usd, created_at
		FROM usage_events WHERE user_id = ? AND created_at >= ? ORDER BY created_at`, userID, since.Unix())
	if err != nil {
		return nil, fmt.Errorf("query usage: %w", err)
	}
	defer rows.Close()
	var out []UsageEvent
	for rows.Next() {
		var (
			e  UsageEvent
			ts int64
		)
		if err := rows.Scan(&e.Op, &e.Model, &e.InputTokens, &e.OutputTokens, &e.ThoughtTokens, &e.CostUSD, &ts); err != nil {
			return nil, fmt.Errorf("scan usage: %w", err)
		}
		e.CreatedAt = time.Unix(ts, 0)
		out = append(out, e)
	}
	return out, rows.Err()
}
