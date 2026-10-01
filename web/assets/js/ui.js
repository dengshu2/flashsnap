// Small DOM helpers shared by every page.

/**
 * Creates an element. `props` keys starting with "on" become listeners,
 * `class`, `text`, `dataset` and `hidden` are handled specially, everything
 * else is set as an attribute. Children may be nodes, strings or falsy.
 */
export function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'hidden') el.hidden = Boolean(v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An icon from the inline sprite in index.html. */
export function icon(name, cls = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `q-i ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
}

// ── Toasts ───────────────────────────────────────────────────────────────────

/**
 * Shows a transient message. With `action`, the toast carries a button (e.g.
 * "撤销"); `onClose` fires once when it disappears, `undone` telling whether
 * the action was taken.
 */
export function toast(message, { type = 'info', action, duration = 3000, onClose } = {}) {
    const host = document.getElementById('toasts');
    if (!host) return;
    let closed = false;
    const el = h('div', { class: `q-toast${type === 'error' ? ' q-toast--error' : ''}`, role: type === 'error' ? 'alert' : 'status' },
        h('span', { text: message }),
    );
    const close = (undone = false) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        el.classList.add('is-leaving');
        setTimeout(() => el.remove(), 200);
        onClose?.(undone);
    };
    if (action) {
        el.append(h('button', {
            type: 'button', text: action.label,
            onclick: () => { action.onClick(); close(true); },
        }));
    }
    host.append(el);
    const timer = setTimeout(() => close(false), duration);
    return close;
}

// ── Clipboard ────────────────────────────────────────────────────────────────

export async function copyText(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        toast('复制失败', { type: 'error' });
        return;
    }
    if (!btn) return;
    const use = btn.querySelector('use');
    const prev = use?.getAttribute('href');
    btn.classList.add('done');
    btn.setAttribute('aria-label', '已复制');
    use?.setAttribute('href', '#i-check');
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
        btn.classList.remove('done');
        btn.setAttribute('aria-label', '复制');
        if (prev) use.setAttribute('href', prev);
    }, 1400);
}

// ── Dates ────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dayLabel(date) {
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return '今天';
    if (dayKey(date) === dayKey(yesterday)) return '昨天';
    const md = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    return date.getFullYear() === today.getFullYear() ? md : `${date.getFullYear()} 年 ${md}`;
}

export function clock(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The time for today, the day and time otherwise ("昨天 20:33"). */
export function stamp(date) {
    const day = dayLabel(date);
    return day === '今天' ? clock(date) : `${day} ${clock(date)}`;
}

// ── Theme ────────────────────────────────────────────────────────────────────

const THEME_KEY = 'flashsnap-theme';

/** 'system', 'light' or 'dark'; theme-init.js applies the saved choice before first paint. */
export function themePref() {
    try {
        const t = localStorage.getItem(THEME_KEY);
        return t === 'light' || t === 'dark' ? t : 'system';
    } catch {
        return 'system';
    }
}

export function setThemePref(pref) {
    const root = document.documentElement;
    try {
        if (pref === 'system') localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, pref);
    } catch { /* storage unavailable: applies to this visit only */ }
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
}
