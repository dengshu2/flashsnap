// Package web embeds and serves the frontend.
package web

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"html"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

//go:embed *.html *.ico *.png assets
var files embed.FS

type file struct {
	body  []byte
	ctype string
	etag  string
}

var (
	// src="/assets/…" and href="/assets/…" in the pages.
	htmlAssetRef = regexp.MustCompile(`((?:src|href)="/assets/[^"?]+)"`)
	// Static relative imports between modules: from './x.js'.
	jsImportRef = regexp.MustCompile(`(from\s+'\./[^'?]+\.js)'`)
)

// Handler serves the embedded frontend. "/" and "/login" map to the two
// pages and frame.html is the live preview's document; when umamiID is set,
// the analytics script is injected into the pages.
//
// Every asset URL carries ?v=<hash of the whole frontend>, rewritten into
// the pages and module imports at startup. Cloudflare overrides our
// Cache-Control on .js/.css with a 4-hour browser TTL, which once left a new
// page running old scripts; with versioned URLs a deploy always changes the
// URL, so no cache layer can serve stale code. Versioned requests are then
// cached for a year; everything else must revalidate.
func Handler(umamiID string) http.Handler {
	analytics := ""
	if umamiID != "" {
		analytics = `<script defer src="https://umami.dengshu.ovh/script.js" data-website-id="` + html.EscapeString(umamiID) + `"></script>`
	}

	raw := map[string][]byte{}
	fs.WalkDir(files, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := files.ReadFile(p)
		if err == nil {
			raw[p] = body
		}
		return err
	})
	version := buildVersion(raw)
	suffix := []byte(`?v=` + version)

	routes := map[string]*file{}
	for p, body := range raw {
		ext := path.Ext(p)
		switch ext {
		case ".html":
			body = bytes.Replace(body, []byte("<!-- analytics -->"), []byte(analytics), 1)
			body = htmlAssetRef.ReplaceAll(body, append([]byte(`$1`), append(suffix, '"')...))
		case ".js":
			body = jsImportRef.ReplaceAll(body, append([]byte(`$1`), append(suffix, '\'')...))
		}
		ctype := mime.TypeByExtension(ext)
		if ext == ".js" {
			ctype = "text/javascript; charset=utf-8"
		}
		sum := sha256.Sum256(body)
		f := &file{body: body, ctype: ctype, etag: `"` + hex.EncodeToString(sum[:8]) + `"`}

		switch p {
		case "index.html":
			routes["/"] = f
		case "login.html":
			routes["/login"] = f
		default:
			routes["/"+p] = f
		}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimSuffix(r.URL.Path, "/")
		if r.URL.Path == "/" {
			key = "/"
		}
		f, ok := routes[key]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", f.ctype)
		switch {
		case key == "/frame.html":
			// no-transform keeps Cloudflare from injecting its analytics script
			// into the preview frame, where the sandbox would block it anyway.
			w.Header().Set("Cache-Control", "no-cache, no-transform")
		case r.URL.Query().Get("v") == version:
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		default:
			w.Header().Set("Cache-Control", "no-cache")
		}
		w.Header().Set("ETag", f.etag)
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(f.body))
	})
}

// buildVersion hashes every embedded file, so any frontend change yields a
// new version.
func buildVersion(files map[string][]byte) string {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		h.Write([]byte(n))
		h.Write(files[n])
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}
