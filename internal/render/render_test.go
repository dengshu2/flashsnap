package render

import (
	"bytes"
	"context"
	"image/jpeg"
	"image/png"
	"os"
	"testing"
	"time"
)

// These tests need Chrome: they run in the container image
// (go test -c, then run the binary there with CHROME_PATH set).
func newTestRenderer(t *testing.T) *Renderer {
	path := os.Getenv("CHROME_PATH")
	if path == "" {
		t.Skip("CHROME_PATH not set")
	}
	r := New(path, 2)
	t.Cleanup(r.Close)
	return r
}

func TestRender(t *testing.T) {
	r := newTestRenderer(t)
	doc := `<!doctype html><html><head><style>
	  html, body { margin: 0; background: #f5f3ed; }
	  .card { width: 600px; height: 760px; padding: 40px; box-sizing: border-box; font-family: "Noto Serif SC"; }
	  h1 { font-size: 56px; margin: 0; } p { font-size: 20px; } small { font-size: 12px; }
	</style></head><body><article class="card"><h1>番茄工作法</h1><p>定时 25 分钟，只做一件事。</p><small>注</small></article></body></html>`
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	res, err := r.Render(ctx, doc)
	if err != nil {
		t.Fatal(err)
	}
	if res.Width != 600 || res.Height != 760 || res.Overflow || res.MinFont != 12 {
		t.Fatalf("measured %dx%d overflow=%v minFont=%v", res.Width, res.Height, res.Overflow, res.MinFont)
	}
	img, err := png.Decode(bytes.NewReader(res.PNG))
	if err != nil || img.Bounds().Dx() != 1200 || img.Bounds().Dy() != 1520 {
		t.Fatalf("png %v, %v", img.Bounds(), err)
	}
	thumb, err := jpeg.Decode(bytes.NewReader(res.Thumb))
	if err != nil || thumb.Bounds().Dx() != ThumbWidth || thumb.Bounds().Dy() != 456 {
		t.Fatalf("thumb %v, %v", thumb.Bounds(), err)
	}
	if out := os.Getenv("RENDER_OUT"); out != "" {
		os.WriteFile(out, res.PNG, 0o644)
	}

	// A second card in the same browser, wider than the card and taller than the first viewport.
	wide := `<!doctype html><html><body style="margin:0"><article class="card" style="width:600px;height:1300px">
	  <div style="width:900px;font-size:16px">一行很长很长的内容</div></article></body></html>`
	res, err = r.Render(ctx, wide)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Overflow || res.Height != 1300 {
		t.Fatalf("wide card: overflow=%v height=%d", res.Overflow, res.Height)
	}
	if img, _ := png.Decode(bytes.NewReader(res.PNG)); img.Bounds().Dy() != 2600 {
		t.Fatalf("tall card png %v", img.Bounds())
	}

	if _, err := r.Render(ctx, `<p>no card</p>`); err == nil {
		// body.firstElementChild is the fallback, so a bare paragraph still renders
		t.Log("a document without .card renders its first element")
	}
}
