// What every page does with a saved card: its tile, copying and downloading
// the image, and deletes that can be undone for a few seconds.

import { api } from './api.js';
import { h, icon, stamp, toast } from './ui.js';

export const imageURL = (id) => `/img/${id}.png`;
export const thumbURL = (id) => `/img/${id}.jpg`;

/** A thumbnail linking to the card's page. */
export function tile(card) {
    const img = h('img', { src: thumbURL(card.id), alt: '', loading: 'lazy', decoding: 'async' });
    img.style.aspectRatio = `${card.width} / ${card.height}`;
    return h('a', { class: 'tile', href: `#card/${card.id}`, dataset: { id: card.id } },
        h('span', { class: 'tile-img' }, img),
        h('span', { class: 'tile-title', text: card.title }),
        h('span', { class: 'tile-meta', text: stamp(new Date(card.created_at)) }));
}

/**
 * Copies the card image. The clipboard write starts inside the click (Safari
 * requires it) with the image still downloading.
 */
export function copyImage(id, btn) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        toast('这个浏览器不能复制图片，请下载', { type: 'error' });
        return;
    }
    const blob = fetch(imageURL(id)).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
    });
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
        if (!btn) return;
        const use = btn.querySelector('use');
        use?.setAttribute('href', '#i-check');
        btn.classList.add('done');
        setTimeout(() => { use?.setAttribute('href', '#i-copy'); btn.classList.remove('done'); }, 1400);
        toast('已复制图片');
    }, () => toast('复制失败，请下载', { type: 'error' }));
}

/** The action buttons for a card: copy, download, then any extras. */
export function actions(card, extras = []) {
    const copy = h('button', { class: 'q-btn q-btn--sm act', type: 'button', onclick: () => copyImage(card.id, copy) }, icon('copy', 'q-i--sm'), '复制图片');
    const download = h('a', { class: 'q-btn q-btn--sm act', href: `${imageURL(card.id)}?download=1`, download: '' }, icon('download', 'q-i--sm'), '下载');
    return [copy, download, ...extras];
}

// ── Deleting with undo ─────────────────────────────────────────────────────────

const UNDO_MS = 5000;
const pending = new Map(); // id -> { timer, card }
const deleted = new Set();
const listeners = new Set();

/** Calls fn() whenever the set of cards changes (a delete or its undo). */
export function onCardsChange(fn) {
    listeners.add(fn);
}

function changed() {
    for (const fn of listeners) fn();
}

/** Whether a card is deleted or waiting to be (lists leave it out). */
export function isGone(id) {
    return pending.has(id) || deleted.has(id);
}

/** Hides a card now and deletes it after the undo window. */
export function removeCard(card) {
    if (pending.has(card.id)) return;
    const entry = { card, timer: setTimeout(() => commit(card.id), UNDO_MS) };
    pending.set(card.id, entry);
    changed();
    toast('已删除', {
        duration: UNDO_MS,
        action: {
            label: '撤销',
            onClick: () => {
                clearTimeout(entry.timer);
                pending.delete(card.id);
                changed();
            },
        },
    });
}

async function commit(id, keepalive = false) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
        await api(`/api/cards/${id}`, { method: 'DELETE', keepalive });
    } catch (err) {
        if (err.status !== 404) {
            pending.delete(id);
            changed();
            toast(`删除失败：${err.message}`, { type: 'error' });
            return;
        }
    }
    pending.delete(id);
    deleted.add(id);
    changed();
}

// Deletes wait out the undo window; do not lose them when the tab closes.
window.addEventListener('pagehide', () => {
    for (const id of [...pending.keys()]) commit(id, true);
});
