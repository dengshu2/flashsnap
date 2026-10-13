package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestMiddlewareRenewsAgingTokens(t *testing.T) {
	s := NewService(nil, "secret")
	h := s.Middleware(func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) })(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	sign := func(exp time.Time) string {
		tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, &Claims{UserID: "u", Email: "a@b.co", RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
		}}).SignedString([]byte("secret"))
		return tok
	}
	serve := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	if rec := serve(sign(time.Now().Add(-time.Minute))); rec.Code != http.StatusUnauthorized || rec.Header().Get(RenewHeader) != "" {
		t.Error("an expired token was accepted or renewed")
	}
	if got := serve(sign(time.Now().Add(tokenLifetime - time.Hour))).Header().Get(RenewHeader); got != "" {
		t.Error("a fresh token was renewed")
	}
	fresh := serve(sign(time.Now().Add(renewWithin - time.Hour))).Header().Get(RenewHeader)
	claims, err := s.Validate(fresh)
	if err != nil {
		t.Fatalf("renewed token: %v", err)
	}
	if claims.UserID != "u" || claims.Email != "a@b.co" || time.Until(claims.ExpiresAt.Time) < tokenLifetime-time.Minute {
		t.Errorf("renewed claims = %+v", claims)
	}
}
