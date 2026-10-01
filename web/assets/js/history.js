// All cards, newest first: a grid of thumbnails with search and infinite scroll.

import { api } from './api.js';
import { isGone, onCardsChange, tile } from './cards.js';
import { h, toast } from './ui.js';

const PAGE_SIZE = 24;

export class History {
    constructor() {
        const $ = (id) => document.getElementById(id);
        this.el = { count: $('history-count'), search: $('history-search'), grid: $('history-grid'), sentinel: $('history-sentinel') };
        this.items = [];
        this.total = 0;
        this.hasMore = false;
        this.loading = false;
        this.query = '';
        this.gen = 0;
        this.visible = false;
        this.stale = true;
        this.sentinelVisible = false;

        let timer;
        this.el.search.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const q = this.el.search.value.trim();
                if (q !== this.query) {
                    this.query = q;
                    this.reload();
                }
            }, 250);
        });
        this.el.search.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.el.search.value) {
                e.preventDefault(); // Esc clears the search before it leaves the page
                this.el.search.value = '';
                this.el.search.dispatchEvent(new Event('input'));
            }
        });
        new IntersectionObserver(([entry]) => {
            this.sentinelVisible = entry.isIntersecting;
            this.maybeLoadMore();
        }, { rootMargin: '600px' }).observe(this.el.sentinel);
        onCardsChange(() => this.render());
    }

    show() {
        this.visible = true;
        if (this.stale) this.reload();
    }

    hide() {
        this.visible = false;
    }

    invalidate() {
        this.stale = true;
    }

    reload() {
        this.gen++;
        this.stale = false;
        this.items = [];
        this.total = 0;
        this.hasMore = false;
        this.loading = false;
        this.el.grid.replaceChildren(...Array.from({ length: 4 }, () => h('span', { class: 'q-skeleton tile-skel', 'aria-hidden': 'true' })));
        this.el.count.textContent = '';
        this.loadMore(true);
    }

    maybeLoadMore() {
        if (this.visible && this.sentinelVisible && this.hasMore && !this.loading) this.loadMore();
    }

    async loadMore(initial = false) {
        const gen = this.gen;
        this.loading = true;
        try {
            const qs = new URLSearchParams({ limit: PAGE_SIZE, offset: this.items.length });
            if (this.query) qs.set('q', this.query);
            const page = await api(`/api/cards?${qs}`);
            if (gen !== this.gen) return;
            this.items.push(...page.items);
            this.total = page.total;
            this.hasMore = page.has_more;
            this.render();
        } catch (err) {
            if (gen !== this.gen) return;
            if (initial) {
                this.el.grid.replaceChildren(h('div', { class: 'q-state' },
                    h('b', { text: '加载失败' }), h('span', { text: err.message }),
                    h('button', { class: 'q-btn q-btn--sm', type: 'button', text: '重试', onclick: () => this.reload() })));
            } else {
                toast(err.message, { type: 'error' });
                this.hasMore = false;
            }
        } finally {
            if (gen === this.gen) {
                this.loading = false;
                requestAnimationFrame(() => this.maybeLoadMore());
            }
        }
    }

    render() {
        if (this.stale && !this.items.length) return;
        const items = this.items.filter((c) => !isGone(c.id));
        const gone = this.items.length - items.length;
        const total = Math.max(0, this.total - gone);
        this.el.count.textContent = total ? `${total} 张` : '';
        if (!items.length && !this.hasMore && !this.loading) {
            const [title, text] = this.query ? ['没有匹配的卡片', '换个关键词试试'] : ['还没有卡片', '在首页粘贴一段文字，生成的卡片都会保存在这里'];
            this.el.grid.replaceChildren(h('div', { class: 'q-state' }, h('b', { text: title }), h('span', { text })));
            return;
        }
        this.el.grid.replaceChildren(...items.map(tile));
    }
}
