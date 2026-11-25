/**
 * FlashSnap — 导出模块
 * 处理 HTML → PNG 转换、剪贴板写入、下载
 *
 * 性能优化：
 * 1. 解析 Google Fonts CSS 中的 unicode-range，仅拉取卡片文字实际命中的字体切片
 *    （将原本 200+ 个串行 woff2 请求压缩为 ~10 个并发请求，速度提升 10x+）
 * 2. 样式表文本与单个字体文件分别缓存，跨卡片复用
 * 3. 卡片渲染完成后后台静默预热 PNG Blob，点击复制/下载时近乎瞬时完成
 */

import { DEFAULT_FONT_HREF } from './cardhtml.js';

const FONT_FETCH_TIMEOUT = 5000;
const CAPTURE_TIMEOUT = 15000;
const CARD_DESIGN_WIDTH = 900;

/* ------------------------------------------------
 * 字体缓存（样式表原文 + 单文件 data URL）
 * ------------------------------------------------ */
const stylesheetCache = new Map(); // href -> Promise<string>
const fontFileCache = new Map();   // fontUrl -> Promise<string | null>
const captureCache = new WeakMap();

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function fetchWithTimeout(url, timeoutMs = FONT_FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    } finally {
        clearTimeout(timer);
    }
}

function fetchStylesheetText(href) {
    if (stylesheetCache.has(href)) {
        return stylesheetCache.get(href);
    }
    const promise = fetchWithTimeout(href)
        .then((res) => res.text())
        .catch((e) => {
            stylesheetCache.delete(href);
            console.warn('[FlashSnap] 获取字体 CSS 失败:', href, e);
            return '';
        });
    stylesheetCache.set(href, promise);
    return promise;
}

function fetchFontDataUrl(url) {
    if (fontFileCache.has(url)) {
        return fontFileCache.get(url);
    }
    const promise = fetchWithTimeout(url)
        .then((res) => res.blob())
        .then((blob) => blobToBase64(blob))
        .catch((e) => {
            fontFileCache.delete(url);
            console.warn('[FlashSnap] 字体文件嵌入失败:', url, e);
            return null;
        });
    fontFileCache.set(url, promise);
    return promise;
}

/**
 * 解析 CSS unicode-range 字符串为 [start, end] 区间数组
 * 支持：U+4E00、U+4E00-9FFF、U+4E??
 */
export function parseUnicodeRanges(rangeStr) {
    if (!rangeStr) return [];
    const ranges = [];
    for (const part of rangeStr.split(',')) {
        const token = part.trim().replace(/^U\+/i, '');
        if (!token) continue;
        if (token.includes('?')) {
            const start = parseInt(token.replace(/\?/g, '0'), 16);
            const end = parseInt(token.replace(/\?/g, 'F'), 16);
            if (!Number.isNaN(start) && !Number.isNaN(end)) ranges.push([start, end]);
        } else if (token.includes('-')) {
            const [a, b] = token.split('-');
            const start = parseInt(a, 16);
            const end = parseInt(b, 16);
            if (!Number.isNaN(start) && !Number.isNaN(end)) ranges.push([start, end]);
        } else {
            const cp = parseInt(token, 16);
            if (!Number.isNaN(cp)) ranges.push([cp, cp]);
        }
    }
    return ranges;
}

/**
 * 判断一组字符码点是否命中某个 unicode-range 区间列表
 */
export function codePointsMatchRanges(codePoints, ranges) {
    if (!ranges || ranges.length === 0) return true;
    for (const cp of codePoints) {
        for (let i = 0; i < ranges.length; i++) {
            if (cp >= ranges[i][0] && cp <= ranges[i][1]) {
                return true;
            }
        }
    }
    return false;
}

function collectUsedCodePoints(root) {
    const set = new Set();
    const text = root?.textContent || '';
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined && cp > 0x1f) {
            set.add(cp);
        }
    }
    return set;
}

/**
 * 过滤并内联 Google Fonts CSS：只保留当前卡片文字实际命中的 @font-face 切片，
 * 并并发拉取对应的 woff2 文件转为 base64。
 */
export async function buildSubsetFontCSS(cssList, usedCodePoints) {
    const matchedBlocks = [];
    const fontUrls = new Set();
    const faceRegex = /@font-face\s*\{[^}]*\}/gi;

    for (const css of cssList) {
        if (!css) continue;
        const blocks = css.match(faceRegex);
        if (!blocks) continue;

        for (const block of blocks) {
            const rangeMatch = block.match(/unicode-range\s*:\s*([^;]+)/i);
            if (rangeMatch && usedCodePoints.size > 0) {
                const ranges = parseUnicodeRanges(rangeMatch[1]);
                if (!codePointsMatchRanges(usedCodePoints, ranges)) {
                    continue;
                }
            }

            const urls = [...block.matchAll(/url\(([^)]+)\)/g)];
            for (const m of urls) {
                const rawUrl = m[1].replace(/['"]/g, '').trim();
                if (rawUrl && !rawUrl.startsWith('data:')) {
                    fontUrls.add(rawUrl);
                }
            }
            matchedBlocks.push(block);
        }
    }

    if (matchedBlocks.length === 0) return '';

    const urlList = [...fontUrls];
    const resolved = await Promise.all(urlList.map((u) => fetchFontDataUrl(u)));
    const urlMap = new Map();
    urlList.forEach((u, idx) => {
        if (resolved[idx]) urlMap.set(u, resolved[idx]);
    });

    return matchedBlocks
        .map((block) =>
            block.replace(/url\(([^)]+)\)/g, (full, inner) => {
                const rawUrl = inner.replace(/['"]/g, '').trim();
                const dataUrl = urlMap.get(rawUrl);
                return dataUrl ? `url('${dataUrl}')` : full;
            })
        )
        .join('\n');
}

/**
 * 空闲时预热默认 Google Fonts 样式表（不下载 woff2，只缓存轻量 CSS 文本）
 */
export function prewarmDefaultFonts() {
    fetchStylesheetText(DEFAULT_FONT_HREF).catch(() => { });
}

async function getEmbeddedFontCSS(iframe, cardEl) {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return '';

    const links = doc.querySelectorAll(
        'link[rel="stylesheet"][href*="fonts.googleapis.com"], link[rel="stylesheet"][href*="fonts.gstatic.com"]'
    );
    const hrefs = [...new Set(
        [...links].map((l) => l.getAttribute('href')).filter(Boolean)
    )];
    if (hrefs.length === 0) return '';

    const usedCodePoints = collectUsedCodePoints(cardEl);
    const cssList = await Promise.all(hrefs.map((href) => fetchStylesheetText(href)));
    return buildSubsetFontCSS(cssList, usedCodePoints);
}

function getCardElement(iframe) {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    if (!iframeDoc?.body) {
        throw new Error('无法获取卡片内容');
    }
    return iframeDoc.body.querySelector('.card')
        || iframeDoc.body.firstElementChild
        || iframeDoc.body;
}

function nextAnimationFrame(win) {
    return new Promise((resolve) => {
        const raf = win?.requestAnimationFrame?.bind(win) || requestAnimationFrame;
        raf(() => resolve());
    });
}

async function waitForImageReady(img) {
    if (!img || img.tagName !== 'IMG') return;

    if (!img.complete) {
        await new Promise((resolve) => {
            const done = () => {
                img.removeEventListener('load', done);
                img.removeEventListener('error', done);
                resolve();
            };
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            setTimeout(done, 3000);
        });
    }

    if (typeof img.decode === 'function') {
        try {
            await img.decode();
        } catch {
            // ignore broken images
        }
    }
}

async function waitForRenderableState(iframe) {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument || win?.document;
    if (!doc || !win) {
        throw new Error('无法获取预览文档');
    }

    if (doc.readyState !== 'complete') {
        await new Promise((resolve) => {
            const done = () => resolve();
            win.addEventListener('load', done, { once: true });
            setTimeout(done, 1000);
        });
    }

    try {
        await Promise.race([
            doc.fonts.ready,
            new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
    } catch {
        // fonts API 不可用，继续
    }

    const cardEl = getCardElement(iframe);
    const images = Array.from(cardEl.querySelectorAll('img'));
    if (images.length > 0) {
        await Promise.all(images.map(waitForImageReady));
    }

    await nextAnimationFrame(win);
    await nextAnimationFrame(win);
}

async function captureToBlob(iframe) {
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('截图超时，请重试')), CAPTURE_TIMEOUT);
    });

    try {
        return await Promise.race([doCaptureToBlob(iframe), timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function doCaptureToBlob(iframe) {
    await waitForRenderableState(iframe);

    const cardEl = getCardElement(iframe);
    const cardWidth = Math.max(
        cardEl.scrollWidth,
        cardEl.offsetWidth,
        CARD_DESIGN_WIDTH,
    );
    const cardHeight = Math.max(
        cardEl.scrollHeight,
        cardEl.offsetHeight,
        1,
    );

    const [{ toBlob }, fontCSS] = await Promise.all([
        import('html-to-image'),
        getEmbeddedFontCSS(iframe, cardEl),
    ]);

    const blob = await toBlob(cardEl, {
        quality: 1.0,
        pixelRatio: 2,
        backgroundColor: null,
        width: cardWidth,
        height: cardHeight,
        fontEmbedCSS: fontCSS || undefined,
        style: {
            margin: '0',
            transform: 'none',
        },
        filter: (node) => node.tagName !== 'SCRIPT',
    });

    if (!blob) {
        throw new Error('截图失败，请重试');
    }

    return blob;
}

function getOrCreateCapturePromise(iframe) {
    const cached = captureCache.get(iframe);
    if (cached) {
        return cached;
    }

    const promise = captureToBlob(iframe).catch((error) => {
        if (captureCache.get(iframe) === promise) {
            captureCache.delete(iframe);
        }
        throw error;
    });

    captureCache.set(iframe, promise);
    return promise;
}

export function invalidateCaptureCache(iframe) {
    captureCache.delete(iframe);
}

export function warmCaptureCache(iframe) {
    getOrCreateCapturePromise(iframe).catch(() => {
        // 预热失败不打断主流程；用户点击复制时会拿到真实错误。
    });
}

function sanitizeFilename(title) {
    const cleaned = (title || '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '-')
        .replace(/\.+$/g, '')
        .slice(0, 32);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    return cleaned ? `flashsnap-${cleaned}-${stamp}.png` : `flashsnap-${stamp}.png`;
}

/**
 * 下载卡片 PNG 到本地
 *
 * @param {HTMLIFrameElement} iframe
 * @param {string} [title]
 */
export async function downloadImage(iframe, title = '') {
    const blob = await getOrCreateCapturePromise(iframe);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeFilename(title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/**
 * 复制图片到剪贴板
 * 将 captureToBlob() 的 Promise 直接传入 ClipboardItem，保持用户点击手势上下文；
 * 预热命中时 blobPromise 已 resolved，点击瞬间完成复制。
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(iframe) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('当前浏览器不支持直接复制图片，请点击下载');
    }

    const blobPromise = getOrCreateCapturePromise(iframe);

    try {
        await navigator.clipboard.write([
            new ClipboardItem({
                'image/png': blobPromise,
            }),
        ]);
        return true;
    } catch (error) {
        // Safari 旧版本不支持 ClipboardItem(Promise)，降级先 await 再写入
        if (error instanceof TypeError) {
            try {
                const blob = await blobPromise;
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob }),
                ]);
                return true;
            } catch (fallbackError) {
                console.error('Fallback copy failed:', fallbackError);
                if (fallbackError.name === 'NotAllowedError') {
                    throw new Error('剪贴板权限被拒绝，请点击下载');
                }
                throw fallbackError;
            }
        }

        console.error('Copy to clipboard failed:', error);
        if (error.name === 'NotAllowedError') {
            throw new Error('剪贴板权限被拒绝，请点击下载');
        }
        throw error;
    }
}
