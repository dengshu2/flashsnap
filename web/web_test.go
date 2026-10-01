package web

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func get(t *testing.T, h http.Handler, url string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
	return rec
}

func TestAssetsAreVersioned(t *testing.T) {
	h := Handler("site-123")

	page := get(t, h, "/")
	body := page.Body.String()
	if page.Code != 200 || page.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("index: %d %q", page.Code, page.Header().Get("Cache-Control"))
	}
	if !strings.Contains(body, `data-website-id="site-123"`) {
		t.Error("analytics not injected")
	}

	m := regexp.MustCompile(`src="/assets/js/main\.js\?v=([0-9a-f]{12})"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("main.js reference not versioned:\n%s", body)
	}
	v := m[1]
	if strings.Contains(body, `.css"`) || strings.Contains(body, `theme-init.js"`) {
		t.Error("an asset reference was left unversioned")
	}

	js := get(t, h, "/assets/js/main.js?v="+v)
	if js.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Errorf("versioned asset cache = %q", js.Header().Get("Cache-Control"))
	}
	if !strings.Contains(js.Body.String(), "from './home.js?v="+v+"'") {
		t.Error("module imports not versioned")
	}

	// A stale or missing version must revalidate, never be cached long.
	if cc := get(t, h, "/assets/js/main.js?v=old").Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("stale version cache = %q", cc)
	}
	if get(t, h, "/login").Code != 200 || get(t, h, "/frame.html").Code != 200 || get(t, h, "/nope").Code != 404 {
		t.Error("routing broken")
	}
}
