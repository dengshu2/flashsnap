/**
 * FlashSnap — 导出模块
 * 处理 HTML → 图片转换、剪贴板写入、下载
 *
 * 核心思路：导出前将 Google Fonts 转成 base64 内联，
 * 避免 html-to-image 克隆 DOM 时丢失外部字体。
 */

import { toBlob } from 'html-to-image';

/* ------------------------------------------------
 * 字体内联缓存 — 同一组字体只需抓取一次
 * ------------------------------------------------ */
const fontCache = new Map(); // href → embeddedCSS

/**
 * 将 Blob 转为 base64 data URL
 */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * 获取 iframe 中所有 Google Fonts <link> 的 CSS，
 * 并将其中引用的字体文件转为 base64 内联。
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<string>} 包含 @font-face 的内联 CSS
 */
async function getEmbeddedFontCSS(iframe) {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return '';

    const links = doc.querySelectorAll(
        'link[rel="stylesheet"][href*="fonts.googleapis.com"], link[rel="stylesheet"][href*="fonts.gstatic.com"]'
    );
    if (links.length === 0) return '';

    let fontCSS = '';

    for (const link of links) {
        const href = link.getAttribute('href');
        if (!href) continue;

        // 命中缓存
        if (fontCache.has(href)) {
            fontCSS += fontCache.get(href) + '\n';
            continue;
        }

        try {
            const response = await fetch(href);
            let css = await response.text();

            // 找到所有 url(...) 引用并替换为 base64
            const urlPattern = /url\(([^)]+)\)/g;
            const matches = [...css.matchAll(urlPattern)];

            for (const match of matches) {
                const rawUrl = match[1].replace(/['"]/g, '').trim();
                if (rawUrl.startsWith('data:')) continue;

                try {
                    const fontRes = await fetch(rawUrl);
                    const blob = await fontRes.blob();
                    const dataUrl = await blobToBase64(blob);
                    // 全局替换相同 URL
                    css = css.split(match[1]).join(`'${dataUrl}'`);
                } catch (e) {
                    console.warn('[FlashSnap] 字体文件嵌入失败:', rawUrl, e);
                }
            }

            fontCache.set(href, css);
            fontCSS += css + '\n';
        } catch (e) {
            console.warn('[FlashSnap] 获取字体 CSS 失败:', href, e);
        }
    }

    return fontCSS;
}

/**
 * 卡片设计固定宽度（与 prompts.js 中的规范一致）
 */
const CARD_DESIGN_WIDTH = 900;

/**
 * 截图操作超时时间（毫秒）
 * 防止 html-to-image 在某些 CSS 场景下 hang 住导致页面卡死
 */
const CAPTURE_TIMEOUT = 15000;
const captureCache = new WeakMap();

/**
 * 获取 iframe 中的卡片根元素
 * 优先查找 .card 类元素，否则取 body 的第一个子元素
 */
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
        });
    }

    if (typeof img.decode === 'function') {
        try {
            await img.decode();
        } catch (e) {
            // decode() 在图片已损坏或浏览器实现不完整时会 reject，忽略即可
        }
    }
}

/**
 * 等待卡片中影响渲染结果的异步资源稳定：
 * 1. iframe 文档 ready
 * 2. Web Fonts
 * 3. <img> 加载与 decode
 * 4. 两帧渲染，确保 layout 已刷新
 */
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
        await doc.fonts.ready;
    } catch (e) {
        // fonts API 不可用，继续
    }

    const cardEl = getCardElement(iframe);
    const images = Array.from(cardEl.querySelectorAll('img'));
    await Promise.all(images.map(waitForImageReady));

    await nextAnimationFrame(win);
    await nextAnimationFrame(win);
}

/**
 * 将 iframe 中的卡片内容转换为 data URL
 *
 * 关键修复：直接截图预览中已渲染完成的卡片 DOM，
 * 避免重建离屏文档后和用户实际看到的内容发生偏差。
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<string>} PNG data URL
 */
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

/**
 * 实际截图逻辑（被 captureToBlob 包裹超时保障）
 */
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

    // 仅注入字体嵌入 CSS。普通样式由 html-to-image 从当前 DOM 的计算样式复制。
    const fontCSS = await getEmbeddedFontCSS(iframe);

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
        filter: (node) => {
            return node.tagName !== 'SCRIPT';
        },
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

/**
 * 复制图片到剪贴板
 *
 * 关键设计：将 captureToBlob() 返回的 Promise 直接传给 ClipboardItem，
 * 而不是先 await 再传入已完成的 Blob。
 *
 * 原因：浏览器 Clipboard API 要求 clipboard.write() 在用户手势（点击）的
 * 同步上下文中调用。如果先 await 截图（可能耗时数秒），等完成后再调用
 * clipboard.write()，浏览器会认为用户手势已过期，抛出 NotAllowedError。
 *
 * 将 Promise 直接传入 ClipboardItem 后，clipboard.write() 在点击瞬间
 * 同步调用，浏览器立即注册写入意图，异步截图完成后自动填充数据。
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(iframe) {
    const blobPromise = getOrCreateCapturePromise(iframe);

    try {
        // 首选：将 Promise 直接传入 ClipboardItem，保持用户手势上下文
        // Chrome 76+、Edge 79+、Firefox 127+ 均支持
        await navigator.clipboard.write([
            new ClipboardItem({
                'image/png': blobPromise,
            }),
        ]);

        return true;
    } catch (error) {
        // Safari 旧版本不支持 ClipboardItem(Promise)，会抛出 TypeError
        // 降级方案：先 await blob，再同步写入（手势可能已过期，但值得一试）
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
                    throw new Error('剪贴板权限被拒绝。请确保在 HTTPS 或 localhost 环境下使用。');
                }
                throw fallbackError;
            }
        }

        console.error('Copy to clipboard failed:', error);

        if (error.name === 'NotAllowedError') {
            throw new Error('剪贴板权限被拒绝。请确保在 HTTPS 或 localhost 环境下使用。');
        }

        throw error;
    }
}
