// Package cardhtml turns a model's reply into a safe card document: it cuts
// the HTML out of whatever the model wrapped it in and removes anything that
// could run code or load something from elsewhere.
package cardhtml

import (
	"bytes"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// ErrNoCard means the reply has no card element with content in it.
var ErrNoCard = errors.New("the reply contains no card")

var (
	fence    = regexp.MustCompile("(?s)```(?:html)?\\s*\\n?(.*?)```")
	docStart = regexp.MustCompile(`(?i)<!doctype|<html\b`)
	docEnd   = regexp.MustCompile(`(?i)</html\s*>`)
	// CSS that loads from elsewhere: @import rules and url(...) other than data: URIs.
	cssImport = regexp.MustCompile(`(?i)@import[^;]*;?`)
	cssURL    = regexp.MustCompile(`(?i)url\(\s*(['"]?)\s*([^)'"]*)['"]?\s*\)`)
)

// Extract returns the HTML document in a reply, which may be wrapped in a
// markdown fence or come with stray prose around it. It also works on a
// partial reply, for the live preview.
func Extract(reply string) string {
	if m := fence.FindAllStringSubmatch(reply, -1); len(m) > 0 {
		best := ""
		for _, g := range m {
			if len(g[1]) > len(best) {
				best = g[1]
			}
		}
		reply = best
	} else if i := strings.Index(reply, "```"); i >= 0 && docStart.MatchString(reply[i:]) {
		reply = reply[i+3:] // an opening fence whose end has not streamed in yet
	}
	if loc := docStart.FindStringIndex(reply); loc != nil {
		reply = reply[loc[0]:]
	}
	if loc := docEnd.FindStringIndex(reply); loc != nil {
		reply = reply[:loc[1]]
	}
	return strings.TrimSpace(reply)
}

// Clean returns a safe version of a card document and its title (the first
// heading in the card).
func Clean(doc string) (clean, title string, err error) {
	root, err := html.Parse(strings.NewReader(doc))
	if err != nil {
		return "", "", err
	}
	var card *html.Node
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			if c.Type == html.ElementNode && dropped[c.DataAtom] {
				n.RemoveChild(c)
				c = next
				continue
			}
			if c.Type == html.ElementNode {
				cleanAttrs(c)
				if c.DataAtom == atom.Style {
					for t := c.FirstChild; t != nil; t = t.NextSibling {
						t.Data = cleanCSS(t.Data)
					}
				}
				if card == nil && hasClass(c, "card") {
					card = c
				}
			}
			walk(c)
			c = next
		}
	}
	walk(root)
	if card == nil || strings.TrimSpace(textOf(card)) == "" {
		return "", "", ErrNoCard
	}
	var buf bytes.Buffer
	if err := html.Render(&buf, root); err != nil {
		return "", "", err
	}
	return "<!doctype html>\n" + buf.String(), headline(card), nil
}

// Elements removed with everything inside them.
var dropped = map[atom.Atom]bool{
	atom.Script: true, atom.Noscript: true, atom.Iframe: true, atom.Frame: true, atom.Frameset: true,
	atom.Object: true, atom.Embed: true, atom.Applet: true, atom.Link: true, atom.Base: true,
	atom.Form: true, atom.Input: true, atom.Button: true, atom.Textarea: true,
	atom.Select: true, atom.Img: true, atom.Picture: true, atom.Video: true, atom.Audio: true, atom.Source: true,
	atom.Track: true, atom.Template: true,
}

// Attributes whose value is a URL; only in-page fragments and data: images survive.
var urlAttrs = map[string]bool{"href": true, "src": true, "srcset": true, "action": true, "formaction": true,
	"poster": true, "background": true, "xlink:href": true, "ping": true}

func cleanAttrs(n *html.Node) {
	kept := n.Attr[:0]
	for _, a := range n.Attr {
		key := strings.ToLower(a.Key)
		if a.Namespace != "" {
			key = strings.ToLower(a.Namespace) + ":" + key
		}
		switch {
		case strings.HasPrefix(key, "on"):
			continue
		case key == "http-equiv":
			continue
		case urlAttrs[key] || strings.HasSuffix(key, ":href"):
			v := strings.TrimSpace(a.Val)
			if !strings.HasPrefix(v, "#") && !strings.HasPrefix(strings.ToLower(v), "data:image/") {
				continue
			}
		case key == "style":
			a.Val = cleanCSS(a.Val)
		}
		kept = append(kept, a)
	}
	n.Attr = kept
}

func cleanCSS(css string) string {
	css = cssImport.ReplaceAllString(css, "")
	return cssURL.ReplaceAllStringFunc(css, func(m string) string {
		g := cssURL.FindStringSubmatch(m)
		if v := strings.ToLower(strings.TrimSpace(g[2])); strings.HasPrefix(v, "data:") || strings.HasPrefix(v, "#") {
			return m
		}
		return "none"
	})
}

func hasClass(n *html.Node, class string) bool {
	for _, a := range n.Attr {
		if a.Key == "class" {
			for _, c := range strings.Fields(a.Val) {
				if c == class {
					return true
				}
			}
		}
	}
	return false
}

func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		if n.Type == html.ElementNode && (n.DataAtom == atom.Style || n.DataAtom == atom.Script) {
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

// headline is the card's first heading, else its first line of text.
func headline(card *html.Node) string {
	var found *html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if found != nil {
			return
		}
		if n.Type == html.ElementNode && (n.DataAtom == atom.H1 || n.DataAtom == atom.H2 || n.DataAtom == atom.H3) {
			found = n
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(card)
	text := ""
	if found != nil {
		text = textOf(found)
	} else {
		text = textOf(card)
	}
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) > 60 {
		text = string([]rune(text)[:60])
	}
	return text
}
