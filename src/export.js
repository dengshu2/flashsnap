/**
 * FlashSnap — 导出模块
 * 处理 HTML → 图片转换、剪贴板写入、下载
 *
 * 核心思路：导出前将 Google Fonts 转成 base64 内联，
 * 避免 html-to-image 克隆 DOM 时丢失外部字体。
 */

import { toPng } from 'html-to-image';

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
 * 收集 iframe 中 <style> 标签内的所有 CSS 规则，
 * 确保 html-to-image 克隆节点时不丢失样式。
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {string}
 */
function collectInlineStyles(iframe) {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return '';

    let css = '';
    const styleTags = doc.querySelectorAll('style');
    for (const tag of styleTags) {
        css += tag.textContent + '\n';
    }
    return css;
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

/**
 * 将 iframe 中的卡片内容转换为 data URL
 *
 * 关键修复：导出前重置 iframe 的 scale() 变换，并使用固定 900px 宽度，
 * 确保导出图片的布局与预览完全一致。
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<string>} PNG data URL
 */
async function captureToDataUrl(iframe) {
    // 超时保障：避免 toPng 内部 hang 导致页面永久卡住
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('截图超时，请重试')), CAPTURE_TIMEOUT)
    );
    return Promise.race([doCapture(iframe), timeoutPromise]);
}

/**
 * 实际截图逻辑（被 captureToDataUrl 包裹超时保障）
 */
async function doCapture(iframe) {
    const cardEl = getCardElement(iframe);

    // 1. 等待 iframe 中字体加载完成
    try {
        await iframe.contentWindow.document.fonts.ready;
    } catch (e) {
        // fonts API 不可用，继续
    }

    // 等待字体渲染（fonts.ready 后只需短暂等待即可）
    await new Promise(resolve => setTimeout(resolve, 200));

    // 2. 预先嵌入字体（核心修复）
    const fontCSS = await getEmbeddedFontCSS(iframe);

    // 3. 收集 iframe 中的内联样式（包含卡片布局 CSS）
    const inlineCSS = collectInlineStyles(iframe);

    // 合并：内联样式 + 嵌入字体
    const combinedCSS = inlineCSS + '\n' + fontCSS;

    // 4. 读取原始卡片的实际渲染宽度（可能 > 900px）
    const originalCardEl = getCardElement(iframe);
    const actualCardWidth = Math.max(
        originalCardEl.scrollWidth,
        originalCardEl.offsetWidth,
        CARD_DESIGN_WIDTH,
    );

    // 5. Create an off-screen clone iframe for capture.
    //    使用卡片的实际宽度而非固定 900px，避免布局挤压。
    const srcDoc = iframe.contentDocument || iframe.contentWindow.document;
    const fullHTML = '<!DOCTYPE html>\n' + srcDoc.documentElement.outerHTML;

    const clone = document.createElement('iframe');
    clone.setAttribute('sandbox', 'allow-same-origin');
    clone.style.cssText =
        'position:fixed;left:-10000px;top:0;' +
        'width:' + actualCardWidth + 'px;height:auto;' +
        'border:none;visibility:hidden;pointer-events:none;';
    document.body.appendChild(clone);

    try {
        const cloneDoc = clone.contentDocument || clone.contentWindow.document;
        cloneDoc.open();
        cloneDoc.write(fullHTML);
        cloneDoc.close();

        // Wait for clone content + fonts to load
        await new Promise(resolve => {
            clone.onload = resolve;
            setTimeout(resolve, 600); // fallback
        });

        try {
            await clone.contentWindow.document.fonts.ready;
        } catch (e) { /* fonts API not available */ }

        // 600ms onload fallback 已足够等待渲染稳定，不再额外等待

        // 6. 从 clone 中读取实际渲染尺寸，而非硬编码
        //    这样 html-to-image 克隆 DOM 后的 SVG foreignObject
        //    会使用与浏览器预览一致的宽度，避免 flex 子元素被挤压换行。
        const cloneCardEl = getCardElement(clone);
        const cardWidth = Math.max(
            cloneCardEl.scrollWidth,
            cloneCardEl.offsetWidth,
            CARD_DESIGN_WIDTH,
        );
        const cardHeight = cloneCardEl.scrollHeight;

        const dataUrl = await toPng(cloneCardEl, {
            quality: 1.0,
            pixelRatio: 2,
            backgroundColor: null,
            width: cardWidth,
            height: cardHeight,
            fontEmbedCSS: combinedCSS,
            style: {
                margin: '0',
                transform: 'none',
                // 不再强制覆盖 width — 保持卡片 CSS 自身定义的宽度和 box-sizing
                // 之前 width: 900px 的强制覆盖会干扰 box-sizing: border-box，
                // 导致内容区变窄，flex 子元素被挤压换行
            },
            filter: (node) => {
                return node.tagName !== 'SCRIPT';
            },
        });

        return dataUrl;
    } finally {
        // Always clean up the clone
        clone.remove();
    }
}

/**
 * 将 iframe 中的内容转换为 PNG Blob
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<Blob>}
 */
async function captureToBlob(iframe) {
    const dataUrl = await captureToDataUrl(iframe);
    const response = await fetch(dataUrl);
    return response.blob();
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
    try {
        // 首选：将 Promise 直接传入 ClipboardItem，保持用户手势上下文
        // Chrome 76+、Edge 79+、Firefox 127+ 均支持
        await navigator.clipboard.write([
            new ClipboardItem({
                'image/png': captureToBlob(iframe),
            }),
        ]);

        return true;
    } catch (error) {
        // Safari 旧版本不支持 ClipboardItem(Promise)，会抛出 TypeError
        // 降级方案：先 await blob，再同步写入（手势可能已过期，但值得一试）
        if (error instanceof TypeError) {
            try {
                const blob = await captureToBlob(iframe);
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
