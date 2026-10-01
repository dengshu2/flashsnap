// One card: the full image, what to do with it, and the text it was made from.

import { api } from './api.js';
import { actions, imageURL, removeCard } from './cards.js';
import { h, icon, stamp } from './ui.js';

export class CardPage {
    constructor({ styleName, onRegenerate, onLeave }) {
        this.body = document.getElementById('card-body');
        this.styleName = styleName;
        this.onRegenerate = onRegenerate;
        this.onLeave = onLeave;
        this.id = null;
    }

    async show(id) {
        this.id = id;
        const skel = h('div', { class: 'q-skeleton', 'aria-hidden': 'true' });
        skel.style.aspectRatio = '3 / 4';
        this.body.replaceChildren(skel);
        let card;
        try {
            card = await api(`/api/cards/${id}`);
        } catch (err) {
            if (this.id !== id) return;
            this.body.replaceChildren(h('div', { class: 'q-state' }, h('b', { text: '打不开这张卡片' }), h('span', { text: err.message })));
            return;
        }
        if (this.id !== id) return;
        document.title = `${card.title} · FlashSnap`;
        const img = h('img', { class: 'shot', src: imageURL(card.id), alt: card.title });
        img.style.aspectRatio = `${card.width} / ${card.height}`;
        this.body.replaceChildren(
            h('figure', { class: 'card-figure' }, img),
            h('div', { class: 'q-actions' }, ...actions(card, [
                h('button', { class: 'q-btn q-btn--sm act', type: 'button', onclick: () => this.onRegenerate(card) }, icon('refresh', 'q-i--sm'), '再来一张'),
                h('button', { class: 'q-btn q-btn--sm q-btn--quiet act danger', type: 'button', onclick: () => { removeCard(card); this.onLeave(); } }, icon('trash', 'q-i--sm'), '删除'),
            ])),
            h('p', { class: 'q-meta', text: `${this.styleName(card.style)} · ${stamp(new Date(card.created_at))}` }),
            h('section', { class: 'q-sec' },
                h('h3', { text: '原文' }),
                h('div', { class: 'q-bubble source', text: card.text })),
        );
    }
}
