package prompt

import (
	"strings"
	"testing"
)

func TestLibrary(t *testing.T) {
	lib, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, s := range lib.Styles() {
		ids = append(ids, s.ID)
		if s.Name == "" {
			t.Errorf("style %s has no name", s.ID)
		}
	}
	if got := strings.Join(ids, ","); got != "auto,editorial,minimal,broadsheet,data,night" {
		t.Errorf("styles = %s", got)
	}

	sys, err := lib.System("data")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sys, "## 画布") || !strings.Contains(sys, "## 风格：数据") || strings.Contains(sys, "## 风格：杂志") {
		t.Errorf("data prompt should be the base plus only the data style")
	}

	auto, _ := lib.System(Auto)
	for _, name := range []string{"杂志", "极简", "报纸", "数据", "夜间"} {
		if !strings.Contains(auto, "## 风格："+name) {
			t.Errorf("auto prompt is missing %s", name)
		}
	}
	if _, err := lib.System("nope"); err == nil || lib.Valid("nope") || !lib.Valid(Auto) || !lib.Valid("night") {
		t.Error("unknown styles must be rejected")
	}
}

func TestParseStyle(t *testing.T) {
	s, err := parseStyle("x", "---\nname: 试试\nsummary: 一句话\norder: 7\n---\n## 风格：试试\n内容\n")
	if err != nil || s.Name != "试试" || s.Summary != "一句话" || s.order != 7 || !strings.HasPrefix(s.body, "## 风格") {
		t.Fatalf("parseStyle = %+v, %v", s, err)
	}
	for _, bad := range []string{"no front matter", "---\nname: a\n", "---\nsummary: b\n---\nbody"} {
		if _, err := parseStyle("x", bad); err == nil {
			t.Errorf("parseStyle(%q) should fail", bad)
		}
	}
}
