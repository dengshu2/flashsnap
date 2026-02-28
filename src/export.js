/**
 * FlashSnap — 导出模块
 * 处理 HTML → 图片转换、剪贴板写入、下载
 */

import { toPng } from 'html-to-image';

/**
 * 获取 iframe 中的卡片根元素
 * 优先查找 .card 类元素，否则取 body 的第一个子元素
 */
function getCardElement(iframe) {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    if (!iframeDoc?.body) {
        throw new Error('无法获取卡片内容');
    }
    // Target the actual card element for accurate capture
    return iframeDoc.body.querySelector('.card')
        || iframeDoc.body.firstElementChild
        || iframeDoc.body;
}

/**
 * 将 iframe 中的卡片内容转换为 data URL
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<string>} PNG data URL
 */
async function captureToDataUrl(iframe) {
    const cardEl = getCardElement(iframe);

    // Wait for fonts to load in iframe
    try {
        await iframe.contentWindow.document.fonts.ready;
    } catch (e) {
        // fonts API might not be available, continue
    }

    // Wait a bit more for fonts to render
    await new Promise(resolve => setTimeout(resolve, 500));

    const dataUrl = await toPng(cardEl, {
        quality: 1.0,
        pixelRatio: 2, // 2x for retina quality
        backgroundColor: '#ffffff',
        width: cardEl.scrollWidth,
        height: cardEl.scrollHeight,
        style: {
            margin: '0',
            transform: 'none',
        },
        // Filter out unwanted elements
        filter: (node) => {
            return node.tagName !== 'SCRIPT';
        },
    });

    return dataUrl;
}

/**
 * 将 iframe 中的内容转换为 PNG Blob
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<Blob>}
 */
export async function captureToBlob(iframe) {
    const dataUrl = await captureToDataUrl(iframe);
    const response = await fetch(dataUrl);
    return response.blob();
}

/**
 * 复制图片到剪贴板
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(iframe) {
    try {
        const blob = await captureToBlob(iframe);

        await navigator.clipboard.write([
            new ClipboardItem({
                'image/png': blob,
            }),
        ]);

        return true;
    } catch (error) {
        console.error('Copy to clipboard failed:', error);

        // Fallback: try to copy as data URL
        if (error.name === 'NotAllowedError') {
            throw new Error('剪贴板权限被拒绝。请确保在 HTTPS 或 localhost 环境下使用。');
        }

        throw error;
    }
}

/**
 * 生成可读的文件名
 * 格式: FlashSnap_20260228_173352.png
 */
function generateFilename() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `FlashSnap_${date}_${time}.png`;
}

/**
 * 下载为 PNG 图片
 * 使用 data URL 直接下载，避免 blob URL 文件名丢失问题
 * @param {HTMLIFrameElement} iframe
 * @param {string} [filename]
 * @returns {Promise<void>}
 */
export async function downloadAsPNG(iframe, filename) {
    const dataUrl = await captureToDataUrl(iframe);

    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename || generateFilename();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

