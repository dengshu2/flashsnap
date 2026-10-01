// Package auth handles password hashing, JWT issuance and request
// authentication.
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"flashsnap/internal/store"
)

const (
	bcryptCost    = 12
	tokenLifetime = 7 * 24 * time.Hour
)

// User-facing validation errors; their messages are shown verbatim.
var (
	ErrPasswordTooShort = errors.New("密码至少需要 8 个字符")
	ErrPasswordTooLong  = errors.New("密码不能超过 128 个字符")
	ErrInvalidCreds     = errors.New("邮箱或密码错误")
)

// dummyHash keeps login timing uniform when the email doesn't exist, so
// response time doesn't reveal which addresses are registered.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("flashsnap-timing-pad"), bcryptCost)

// Claims is the JWT payload.
type Claims struct {
	UserID string `json:"user_id"`
	Email  string `json:"email"`
	jwt.RegisteredClaims
}

// Users is the persistence the auth service needs.
type Users interface {
	UserByEmail(email string) (store.User, string, bool, error)
}

// Service issues and validates tokens.
type Service struct {
	users  Users
	secret []byte
}

// NewService returns a Service signing tokens with secret.
func NewService(users Users, secret string) *Service {
	return &Service{users: users, secret: []byte(secret)}
}

// HashPassword validates and hashes a new password (accounts are created and
// reset from the command line; there is no sign-up page).
func HashPassword(password string) (string, error) {
	if len(password) < 8 {
		return "", ErrPasswordTooShort
	}
	if len(password) > 128 {
		return "", ErrPasswordTooLong
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

// ValidEmail normalises an address and reports whether it is well formed.
func ValidEmail(email string) (string, bool) {
	email = normalizeEmail(email)
	addr, err := mail.ParseAddress(email)
	return email, err == nil && addr.Address == email
}

// Login checks credentials and returns a signed token.
func (s *Service) Login(email, password string) (store.User, string, error) {
	user, hash, ok, err := s.users.UserByEmail(normalizeEmail(email))
	if err != nil {
		return store.User{}, "", err
	}
	if !ok {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return store.User{}, "", ErrInvalidCreds
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return store.User{}, "", ErrInvalidCreds
	}
	token, err := s.sign(user)
	return user, token, err
}

// Validate parses a token and returns its claims.
func (s *Service) Validate(token string) (*Claims, error) {
	claims := &Claims{}
	t, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		return s.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil || !t.Valid || claims.UserID == "" {
		return nil, errors.New("invalid or expired token")
	}
	return claims, nil
}

func (s *Service) sign(u store.User) (string, error) {
	now := time.Now()
	claims := &Claims{
		UserID: u.ID,
		Email:  u.Email,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   u.ID,
			ID:        uuid.NewString(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(tokenLifetime)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
}

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

// ── Middleware ────────────────────────────────────────────────────────────────

type ctxKey struct{}

// Middleware rejects requests without a valid Bearer token and stores the
// claims in the request context. onFail writes the rejection response.
func (s *Service) Middleware(onFail func(http.ResponseWriter)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok {
				onFail(w)
				return
			}
			claims, err := s.Validate(token)
			if err != nil {
				onFail(w)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, claims)))
		})
	}
}

// UserID returns the authenticated user's ID ("" outside Middleware).
func UserID(r *http.Request) string {
	if c, ok := r.Context().Value(ctxKey{}).(*Claims); ok {
		return c.UserID
	}
	return ""
}
