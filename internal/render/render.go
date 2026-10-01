// Package render turns a card document into a PNG with headless Chrome. The
// browser stays running between cards; each card gets its own tab. Fonts are
// installed in the container, so rendering never waits on the network.
package render

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"sync"
	"time"

	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
	"golang.org/x/image/draw"
)

const (
	// Width is the card's CSS width; Scale is the device pixel ratio of the PNG.
	Width = 600
	Scale = 2
	// ThumbWidth is the pixel width of list thumbnails.
	ThumbWidth = 360
)

// Result is a rendered card and what was measured on it.
type Result struct {
	PNG      []byte
	Thumb    []byte  // JPEG, ThumbWidth wide
	Width    int     // CSS pixels
	Height   int     // CSS pixels
	MinFont  float64 // smallest font size of visible text, CSS pixels
	Overflow bool    // content wider than the card
}

// Renderer renders cards, a few at a time.
type Renderer struct {
	execPath string
	slots    chan struct{}

	mu      sync.Mutex
	browser context.Context
	stop    context.CancelFunc
}

// New returns a renderer; execPath may be empty to find Chrome on PATH.
func New(execPath string, concurrency int) *Renderer {
	return &Renderer{execPath: execPath, slots: make(chan struct{}, max(1, concurrency))}
}

// Close shuts the browser down.
func (r *Renderer) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stop != nil {
		r.stop()
		r.browser, r.stop = nil, nil
	}
}

// browserCtx starts Chrome on first use and again if it has died.
func (r *Renderer) browserCtx() (context.Context, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.browser != nil && r.browser.Err() == nil {
		return r.browser, nil
	}
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.NoSandbox, // the container is the sandbox
		chromedp.DisableGPU,
		chromedp.Flag("hide-scrollbars", true),
		chromedp.Flag("disable-dev-shm-usage", true), // /dev/shm is small in containers
		chromedp.Flag("font-render-hinting", "none"),
	)
	if r.execPath != "" {
		opts = append(opts, chromedp.ExecPath(r.execPath))
	}
	alloc, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	browser, cancelBrowser := chromedp.NewContext(alloc)
	if err := chromedp.Run(browser); err != nil {
		cancelBrowser()
		cancelAlloc()
		return nil, fmt.Errorf("start chrome: %w", err)
	}
	r.browser = browser
	r.stop = func() { cancelBrowser(); cancelAlloc() }
	return browser, nil
}

// measure finds the card and the smallest visible text in it.
const measure = `(async () => {
  await document.fonts.ready;
  const card = document.querySelector('.card') || document.body.firstElementChild;
  if (!card) return null;
  const r = card.getBoundingClientRect();
  let min = 1000;
  for (const el of card.querySelectorAll('*')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
    min = Math.min(min, parseFloat(s.fontSize));
  }
  const wide = Math.max(document.documentElement.scrollWidth, card.scrollWidth + r.left);
  return { x: r.left, y: r.top, w: r.width, h: r.height, minFont: min, overflow: wide > ` + "%d" + ` + 1 };
})()`

type box struct {
	X, Y, W, H float64
	MinFont    float64 `json:"minFont"`
	Overflow   bool    `json:"overflow"`
}

// Render renders one card document.
func (r *Renderer) Render(ctx context.Context, doc string) (Result, error) {
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
	browser, err := r.browserCtx()
	if err != nil {
		return Result{}, err
	}
	tab, closeTab := chromedp.NewContext(browser)
	defer closeTab()
	tab, cancel := context.WithTimeout(tab, 30*time.Second)
	defer cancel()
	go func() { // a caller giving up closes the tab too
		select {
		case <-ctx.Done():
			cancel()
		case <-tab.Done():
		}
	}()

	var b *box
	var shot []byte
	err = chromedp.Run(tab,
		emulation.SetDeviceMetricsOverride(Width, 1000, Scale, false),
		chromedp.Navigate("about:blank"),
		chromedp.ActionFunc(func(ctx context.Context) error {
			tree, err := page.GetFrameTree().Do(ctx)
			if err != nil {
				return err
			}
			return page.SetDocumentContent(tree.Frame.ID, doc).Do(ctx)
		}),
		chromedp.Evaluate(fmt.Sprintf(measure, Width), &b, func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
			return p.WithAwaitPromise(true)
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			if b == nil || b.W < 1 || b.H < 1 {
				return errors.New("the document has no card to render")
			}
			// Make the viewport tall enough for the whole card, then crop to it.
			bottom := int64(math.Ceil(b.Y + b.H))
			if err := emulation.SetDeviceMetricsOverride(Width, max(bottom, 1000), Scale, false).Do(ctx); err != nil {
				return err
			}
			var err error
			shot, err = page.CaptureScreenshot().
				WithFormat(page.CaptureScreenshotFormatPng).
				WithCaptureBeyondViewport(true).
				WithClip(&page.Viewport{X: b.X, Y: b.Y, Width: b.W, Height: b.H, Scale: 1}).
				Do(ctx)
			return err
		}),
	)
	if err != nil {
		return Result{}, fmt.Errorf("render: %w", err)
	}
	thumb, err := thumbnail(shot)
	if err != nil {
		return Result{}, err
	}
	return Result{
		PNG: shot, Thumb: thumb,
		Width: int(math.Round(b.W)), Height: int(math.Round(b.H)),
		MinFont: b.MinFont, Overflow: b.Overflow,
	}, nil
}

func thumbnail(pngData []byte) ([]byte, error) {
	src, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		return nil, fmt.Errorf("decode render: %w", err)
	}
	sb := src.Bounds()
	h := max(1, sb.Dy()*ThumbWidth/max(1, sb.Dx()))
	dst := image.NewRGBA(image.Rect(0, 0, ThumbWidth, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, sb, draw.Src, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 84}); err != nil {
		return nil, fmt.Errorf("encode thumbnail: %w", err)
	}
	return buf.Bytes(), nil
}
