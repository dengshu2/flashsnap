/**
 * FlashSnap — 导出模块
 * 处理 HTML → 图片转换、剪贴板写入、下载
 */

import { toPng } from 'html-to-image';

/**
 * 将 iframe 中的内容转换为 PNG Blob
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<Blob>}
 */
export async function captureToBlob(iframe) {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const cardRoot = iframeDoc.body;

    if (!cardRoot) {
        throw new Error('无法获取卡片内容');
    }

    // Wait for fonts to load in iframe
    try {
        await iframe.contentWindow.document.fonts.ready;
    } catch (e) {
        // fonts API might not be available, continue
    }

    // Wait a bit more for fonts to render
    await new Promise(resolve => setTimeout(resolve, 500));

    const dataUrl = await toPng(cardRoot, {
        quality: 1.0,
        pixelRatio: 2, // 2x for retina quality
        backgroundColor: '#ffffff',
        style: {
            margin: '0',
            padding: '0',
        },
        // Filter out unwanted elements
        filter: (node) => {
            return node.tagName !== 'SCRIPT';
        },
    });

    // Convert data URL to Blob
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
 * 下载为 PNG 图片
 * @param {HTMLIFrameElement} iframe
 * @param {string} [filename]
 * @returns {Promise<void>}
 */
export async function downloadAsPNG(iframe, filename) {
    const blob = await captureToBlob(iframe);

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || `flashsnap-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Clean up
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
