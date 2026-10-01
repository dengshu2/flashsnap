// Package prompt assembles the system prompt for a card: the shared contract
// (prompts/base.md) followed by one style (prompts/styles/<id>.md). Adding a
// style is adding a file; its front matter names and orders it.
package prompt

import (
	"embed"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
)

//go:embed prompts/base.md prompts/styles/*.md
var files embed.FS

// Auto lets the model pick the style that fits the text.
const Auto = "auto"

// Style is one look a card can take.
type Style struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
	order   int
	body    string
}

// Library holds the base contract and the styles.
type Library struct {
	base   string
	styles []Style
	byID   map[string]Style
}

// Load reads the embedded prompts.
func Load() (*Library, error) {
	base, err := files.ReadFile("prompts/base.md")
	if err != nil {
		return nil, err
	}
	lib := &Library{base: strings.TrimSpace(string(base)), byID: map[string]Style{}}
	entries, err := files.ReadDir("prompts/styles")
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		raw, err := files.ReadFile("prompts/styles/" + e.Name())
		if err != nil {
			return nil, err
		}
		s, err := parseStyle(strings.TrimSuffix(e.Name(), path.Ext(e.Name())), string(raw))
		if err != nil {
			return nil, fmt.Errorf("style %s: %w", e.Name(), err)
		}
		lib.styles = append(lib.styles, s)
		lib.byID[s.ID] = s
	}
	sort.SliceStable(lib.styles, func(i, j int) bool { return lib.styles[i].order < lib.styles[j].order })
	return lib, nil
}

// parseStyle reads "---\nkey: value\n---\nbody".
func parseStyle(id, raw string) (Style, error) {
	rest, ok := strings.CutPrefix(raw, "---\n")
	if !ok {
		return Style{}, fmt.Errorf("missing front matter")
	}
	head, body, ok := strings.Cut(rest, "\n---\n")
	if !ok {
		return Style{}, fmt.Errorf("unterminated front matter")
	}
	s := Style{ID: id, body: strings.TrimSpace(body)}
	for _, line := range strings.Split(head, "\n") {
		k, v, _ := strings.Cut(line, ":")
		v = strings.TrimSpace(v)
		switch strings.TrimSpace(k) {
		case "name":
			s.Name = v
		case "summary":
			s.Summary = v
		case "order":
			s.order, _ = strconv.Atoi(v)
		}
	}
	if s.Name == "" || s.body == "" {
		return Style{}, fmt.Errorf("name and body are required")
	}
	return s, nil
}

// Styles lists the choices, "auto" first.
func (l *Library) Styles() []Style {
	out := []Style{{ID: Auto, Name: "自动", Summary: "按内容挑一种风格"}}
	return append(out, l.styles...)
}

// Valid reports whether id names a style or "auto".
func (l *Library) Valid(id string) bool {
	_, ok := l.byID[id]
	return ok || id == Auto
}

// System returns the system prompt for a style.
func (l *Library) System(id string) (string, error) {
	if id == Auto {
		var b strings.Builder
		b.WriteString(l.base)
		b.WriteString("\n\n## 风格\n从下面几种风格里选一种最适合这段内容的，完全按它的要求设计，不要混用。\n")
		for _, s := range l.styles {
			b.WriteString("\n")
			b.WriteString(s.body)
			b.WriteString("\n")
		}
		return b.String(), nil
	}
	s, ok := l.byID[id]
	if !ok {
		return "", fmt.Errorf("unknown style %q", id)
	}
	return l.base + "\n\n" + s.body, nil
}

// Repair is the follow-up message when the rendered card broke a rule.
func Repair(problems []string) string {
	return "这一版渲染出来有问题：\n- " + strings.Join(problems, "\n- ") +
		"\n请在同样的风格和内容下修正，输出修正后的完整 HTML 文档，只输出 HTML。"
}
