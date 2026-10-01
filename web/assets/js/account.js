// The account page: who is signed in, appearance, model usage and cost, sign out.

import { api, session } from './api.js';
import { h, setThemePref, themePref } from './ui.js';

const OPS = [['generate', '生成'], ['repair', '自动修正']];

const money = (usd) => {
    if (!usd) return '$0';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    if (usd < 1) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
};
const num = (n) => n.toLocaleString('en-US');

export class Account {
    constructor({ onLogout }) {
        const $ = (id) => document.getElementById(id);
        this.el = { email: $('account-email'), theme: $('theme-seg'), range: $('usage-range'), usage: $('usage-body'), logout: $('logout-btn') };
        this.days = 30;
        this.loaded = false;
        this.el.email.textContent = session.email() || '已登录';
        for (const btn of this.el.theme.querySelectorAll('[data-theme-pref]')) {
            btn.addEventListener('click', () => {
                setThemePref(btn.dataset.themePref);
                this.syncTheme();
            });
        }
        for (const btn of this.el.range.querySelectorAll('[data-days]')) {
            btn.addEventListener('click', () => {
                const d = Number(btn.dataset.days);
                if (d !== this.days) {
                    this.days = d;
                    this.load();
                }
            });
        }
        this.el.logout.addEventListener('click', onLogout);
        this.syncTheme();
    }

    show() {
        this.syncTheme();
        if (!this.loaded) this.load();
    }

    invalidate() {
        this.loaded = false;
    }

    syncTheme() {
        const pref = themePref();
        for (const btn of this.el.theme.querySelectorAll('[data-theme-pref]')) {
            btn.setAttribute('aria-pressed', String(btn.dataset.themePref === pref));
        }
    }

    async load() {
        this.loaded = true;
        for (const btn of this.el.range.querySelectorAll('[data-days]')) {
            btn.setAttribute('aria-pressed', String(Number(btn.dataset.days) === this.days));
        }
        const skel = h('div', { class: 'q-skeleton', 'aria-hidden': 'true' });
        skel.style.height = '96px';
        this.el.usage.replaceChildren(skel);
        try {
            this.el.usage.replaceChildren(...content(await api(`/api/usage?days=${this.days}`)));
        } catch (err) {
            this.loaded = false;
            this.el.usage.replaceChildren(h('div', { class: 'q-state' },
                h('b', { text: '加载失败' }), h('span', { text: err.message }),
                h('button', { class: 'q-btn q-btn--sm', type: 'button', text: '重试', onclick: () => this.load() })));
        }
    }
}

function content(r) {
    const tokens = (s) => num(s.input_tokens + s.output_tokens + s.thought_tokens);
    return [
        h('div', { class: 'q-tiles' },
            tile('今天', money(r.today.cost_usd), `${r.today.calls} 次调用`),
            tile(`近 ${r.days} 天`, money(r.total.cost_usd), `${r.total.calls} 次调用`)),
        h('div', { class: 'q-table-wrap' },
            h('table', { class: 'q-table' },
                h('thead', {}, h('tr', {}, h('th', { text: '类型' }), h('th', { text: '调用' }), h('th', { text: 'Token' }), h('th', { text: '费用' }))),
                h('tbody', {}, OPS.map(([op, label]) => {
                    const s = r.by_op[op] || { calls: 0, input_tokens: 0, output_tokens: 0, thought_tokens: 0, cost_usd: 0 };
                    return h('tr', {}, h('td', { text: label }), h('td', { text: num(s.calls) }), h('td', { text: tokens(s) }), h('td', { text: money(s.cost_usd) }));
                })))),
        h('p', { class: 'usage-foot', text:
            '按 Google 官方单价估算：Gemini 3.8 Flash 每百万 token 输入 $0.75、输出 $3.75（思考也按输出计），2027 年 1 月 1 日起翻倍。' +
            '"自动修正"是卡片渲染后超出版面时，让模型改一次的调用。精确账单以 Google AI Studio 为准。' }),
    ];
}

function tile(label, value, sub) {
    return h('div', { class: 'q-tile' },
        h('span', { class: 'q-tile-label', text: label }),
        h('span', { class: 'q-tile-value', text: value }),
        h('span', { class: 'q-tile-sub', text: sub }));
}
