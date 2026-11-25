/**
 * FlashSnap — 卡片 HTML 安全清洗与标题提取
 * 轻量移植自服务端 cardhtml 清洗逻辑：
 * - 剥离脚本、表单、嵌套框架与危险事件属性
 * - 清理 CSS 中的 @import 与外部 url(...)
 * - 提取卡片主标题供历史记录与下载文件名使用
 */

export const DEFAULT_FONT_HREF =
    'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@700;900&family=Noto+Sans+SC:wght@400;500;700&family=Oswald:wght@500;700&family=Inter:wght@400;600;700&display=swap';

const DROPPED_TAGS = new Set([
    'SCRIPT', 'NOSCRIPT', 'IFRAME', 'FRAME', 'FRAMESET',
    'OBJECT', 'EMBED', 'APPLET', 'BASE', 'META', 'TITLE',
    'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT',
    'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'TEMPLATE',
]);

const URL_ATTRS = new Set([
    'href', 'src', 'srcset', 'action', 'formaction',
    'poster', 'background', 'xlink:href', 'ping',
]);

const ALLOWED_FONT_HOSTS = new Set([
    'fonts.googleapis.com',
    'fonts.gstatic.com',
]);

function isAllowedFontUrl(href) {
    try {
        const u = new URL(href);
        return u.protocol === 'https:' && ALLOWED_FONT_HOSTS.has(u.hostname);
    } catch {
        return false;
    }
}

export function cleanCSS(css) {
    if (!css) return '';
    return css
        .replace(/@import\b[^;]*;?/gi, '')
        .replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, _quote, rawVal) => {
            const v = rawVal.trim().toLowerCase();
            if (v.startsWith('data:') || v.startsWith('#')) {
                return match;
            }
            return 'none';
        });
}

function cleanElementTree(root) {
    const elements = [...root.querySelectorAll('*')];
    for (const el of elements) {
        if (DROPPED_TAGS.has(el.tagName)) {
            el.remove();
            continue;
        }
        if (el.tagName === 'LINK') {
            el.remove();
            continue;
        }
        if (el.tagName === 'STYLE') {
            el.textContent = cleanCSS(el.textContent);
            continue;
        }

        for (const attr of [...el.attributes]) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on') || name === 'http-equiv') {
                el.removeAttribute(attr.name);
                continue;
            }
            if (name === 'style') {
                el.setAttribute('style', cleanCSS(attr.value));
                continue;
            }
            if (URL_ATTRS.has(name) || name.endsWith(':href')) {
                const v = attr.value.trim();
                const lower = v.toLowerCase();
                const safe =
                    lower.startsWith('#') ||
                    lower.startsWith('data:image/') ||
                    (el.tagName === 'IMG' && (lower.startsWith('https://') || lower.startsWith('http://')));
                if (!safe) {
                    el.removeAttribute(attr.name);
                }
            }
        }
    }
}

/**
 * 从卡片根节点提取可读标题（优先 h1/h2/h3/.main-title）
 * @param {Element|DocumentFragment|null} root
 * @param {number} [maxLen=42]
 * @returns {string}
 */
export function extractCardTitle(root, maxLen = 42) {
    if (!root) return '';
    const card = root.querySelector?.('.card') || root.firstElementChild || root;
    const heading = card.querySelector?.('h1, .main-title, h2, h3');
    const raw = (heading ? heading.textContent : card.textContent) || '';
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}…` : collapsed;
}

/**
 * 解析并清洗完整卡片 HTML，拆分出样式、正文片段、字体链接与标题
 * @param {string} rawHtml
 * @returns {{ css: string, bodyHTML: string, fontLinks: string[], title: string }}
 */
export function parseAndCleanCardHTML(rawHtml) {
    const doc = new DOMParser().parseFromString(rawHtml || '', 'text/html');

    const fontLinks = [];
    for (const link of doc.querySelectorAll('link[rel="stylesheet"][href]')) {
        const href = link.getAttribute('href')?.trim();
        if (href && isAllowedFontUrl(href) && !fontLinks.includes(href)) {
            fontLinks.push(href);
        }
    }

    const cssParts = [];
    for (const style of doc.querySelectorAll('style')) {
        const cleaned = cleanCSS(style.textContent || '');
        if (cleaned.trim()) cssParts.push(cleaned);
        style.remove();
    }

    if (doc.body) {
        cleanElementTree(doc.body);
    }

    const title = extractCardTitle(doc.body);
    const bodyHTML = doc.body ? doc.body.innerHTML : '';

    return {
        css: cssParts.join('\n'),
        bodyHTML,
        fontLinks,
        title,
    };
}
