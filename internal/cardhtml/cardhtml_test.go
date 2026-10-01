package cardhtml

import (
	"errors"
	"strings"
	"testing"
)

func TestExtract(t *testing.T) {
	doc := "<!doctype html><html><body><article class=\"card\">Hi</article></body></html>"
	cases := map[string]string{
		doc:                         doc,
		"```html\n" + doc + "\n```": doc,
		"Here is your card:\n\n" + doc + "\nDone!": doc,
		"```html\n<!doctype html><html><body>part": "<!doctype html><html><body>part", // still streaming
	}
	for in, want := range cases {
		if got := Extract(in); got != want {
			t.Errorf("Extract(%.30q) = %.60q", in, got)
		}
	}
}

func TestClean(t *testing.T) {
	in := `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<style>@import url("https://evil.example/x.css"); .card{background:url(https://evil.example/bg.png)} .dot{background:url("data:image/png;base64,AAAA")}</style>
<script>alert(1)</script>
</head><body onload="alert(2)">
<article class="card wide" style="background-image:url(http://evil.example/a.png)">
<h1 onclick="steal()">番茄工作法</h1>
<p><a href="https://example.com">link</a> <a href="#top">top</a></p>
<img src="https://evil.example/pixel.png">
<svg width="10" height="10"><use xlink:href="https://evil.example/s.svg#a"></use><circle r="4"></circle></svg>
</article></body></html>`
	out, title, err := Clean(in)
	if err != nil {
		t.Fatal(err)
	}
	if title != "番茄工作法" {
		t.Errorf("title = %q", title)
	}
	for _, bad := range []string{"<script", "alert", "onload", "onclick", "<link", "@import", "evil.example", "<img", "https://example.com"} {
		if strings.Contains(out, bad) {
			t.Errorf("cleaned card still contains %q", bad)
		}
	}
	for _, good := range []string{`class="card wide"`, "data:image/png;base64,AAAA", `href="#top"`, "<circle", "<h1>番茄工作法</h1>"} {
		if !strings.Contains(out, good) {
			t.Errorf("cleaned card lost %q", good)
		}
	}
}

func TestCleanRejectsEmptyOrMissingCard(t *testing.T) {
	for _, in := range []string{
		`<html><body><div>no card here</div></body></html>`,
		`<html><body><article class="card">   </article></body></html>`,
	} {
		if _, _, err := Clean(in); !errors.Is(err, ErrNoCard) {
			t.Errorf("Clean(%.40q) err = %v, want ErrNoCard", in, err)
		}
	}
}

func TestTitleFallsBackToText(t *testing.T) {
	_, title, err := Clean(`<article class="card"><p>` + strings.Repeat("长", 70) + `</p></article>`)
	if err != nil || len([]rune(title)) != 60 {
		t.Fatalf("title = %q (%d runes), %v", title, len([]rune(title)), err)
	}
}
