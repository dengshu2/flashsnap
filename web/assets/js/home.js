// The home page: pick a style, paste text, and the card is written live under
// the editor, then replaced by its rendered image. The last few cards follow.

import { api, streamCard } from './api.js';
import { actions, isGone, onCardsChange, tile } from './cards.js';
import { Preview, htmlSoFar } from './preview.js';
import { h, icon, toast } from './ui.js';

const MAX_LENGTH = 4000;
const RECENT = 6;
const STYLE_KEY = 'fs-style';
const DRAFT_KEY = 'fs-draft';

const SAMPLES = [
    ['番茄工作法', '番茄工作法是弗朗切斯科·西里洛在 1980 年代末想出来的。他当时还是大学生，总是没法专心读书，于是拿起一个番茄形状的厨房计时器，跟自己约定：只专心学 10 分钟。后来这个方法慢慢固定下来：选一件要做的事，定时 25 分钟，期间只做这一件事；铃响后休息 5 分钟，这算一个“番茄”。每完成 4 个番茄，休息 15 到 30 分钟。'],
    ['早起的 5 个习惯', '早起的 5 个小习惯：1. 前一晚把手机放在卧室外面；2. 起床先喝一杯水；3. 拉开窗帘晒 10 分钟太阳；4. 先做最重要的一件事，再看消息；5. 固定入睡时间，比固定起床时间更重要。'],
    ['什么是 RAG', '什么是检索增强生成（RAG）？先从资料库里检索和问题相关的段落，再把这些段落和问题一起交给大模型来回答。好处：答案有出处，知识可以随时更新，不用重新训练，也能减少胡编。难点：文档怎么切分，检索能不能把对的段落找回来，以及上下文放不放得下。'],
];

const STAGE = {
    thinking: '正在构思版面',
    writing: '正在写',
    rendering: '正在排版',
    fixing: '正在调整排版',
};

function read(key) {
    try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function write(key, value) {
    try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
    } catch { /* storage unavailable */ }
}

export class Home {
    constructor({ onCreated }) {
        const $ = (id) => document.getElementById(id);
        this.el = {
            seg: $('style-seg'), form: $('editor'), input: $('editor-input'), count: $('editor-count'),
            clear: $('editor-clear'), submit: $('editor-submit'), submitLabel: $('editor-submit-label'),
            ideas: $('ideas'), result: $('result'), label: $('result-label'), stage: $('result-stage'),
            img: $('result-img'), waiting: $('result-waiting'), actions: $('result-actions'),
            recentSec: $('recent-sec'), recent: $('recent'),
        };
        this.preview = new Preview($('preview'), this.el.stage);
        this.onCreated = onCreated;
        this.styles = [];
        this.style = read(STYLE_KEY) || 'auto';
        this.busy = false;
        this.card = null;      // the card in the result area
        this.recent = null;    // newest first; null = not loaded
        this.el.input.value = read(DRAFT_KEY);
        this.bind();
        this.renderIdeas();
        this.sync();
        this.loadStyles();
        onCardsChange(() => {
            if (this.card && isGone(this.card.id)) this.showCard(null);
            this.renderRecent();
        });
    }

    bind() {
        const { form, input, clear } = this.el;
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.generate();
        });
        let saveTimer;
        input.addEventListener('input', () => {
            this.sync();
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => write(DRAFT_KEY, input.value), 400);
        });
        input.addEventListener('keydown', (e) => {
            // Enter adds a line (the text is often several paragraphs); Ctrl/⌘+Enter generates.
            if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                this.generate();
            }
        });
        clear.addEventListener('click', () => {
            input.value = '';
            write(DRAFT_KEY, '');
            this.sync();
            this.focus();
        });
    }

    async loadStyles() {
        try {
            this.styles = await api('/api/styles');
        } catch (err) {
            toast(err.message, { type: 'error' });
            return;
        }
        if (!this.styles.some((s) => s.id === this.style)) this.style = 'auto';
        this.el.seg.replaceChildren(...this.styles.map((s) => h('button', {
            type: 'button', text: s.name, title: s.summary, dataset: { style: s.id },
            onclick: () => this.setStyle(s.id),
        })));
        this.setStyle(this.style);
    }

    setStyle(id) {
        this.style = id;
        write(STYLE_KEY, id === 'auto' ? '' : id);
        for (const b of this.el.seg.querySelectorAll('button')) {
            b.setAttribute('aria-pressed', String(b.dataset.style === id));
        }
    }

    styleName(id) {
        return this.styles.find((s) => s.id === id)?.name || '自动';
    }

    focus() {
        const { input } = this.el;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
    }

    show() {
        if (!this.recent) this.loadRecent();
    }

    /** Called when cards change elsewhere; the recent list reloads on next show. */
    invalidate() {
        this.recent = null;
    }

    // ── Editor ───────────────────────────────────────────────────────────

    sync() {
        const { input, count, clear, submit, ideas } = this.el;
        input.style.height = 'auto';
        input.style.height = `${input.scrollHeight}px`;
        const len = [...input.value].length;
        count.textContent = !len ? '' : len > MAX_LENGTH ? `超出 ${len - MAX_LENGTH} 字，请删减` : `${len} / ${MAX_LENGTH}`;
        count.classList.toggle('q-count--warn', len > MAX_LENGTH * 0.9);
        clear.hidden = !input.value || this.busy;
        submit.disabled = this.busy || !input.value.trim() || len > MAX_LENGTH;
        submit.classList.toggle('is-busy', this.busy);
        input.readOnly = this.busy;
        ideas.hidden = Boolean(input.value.trim()) || this.busy;
    }

    renderIdeas() {
        this.el.ideas.replaceChildren(...SAMPLES.map(([label, text]) => h('button', {
            class: 'q-idea', type: 'button', text: label,
            onclick: () => {
                this.el.input.value = text;
                write(DRAFT_KEY, text);
                this.sync();
                this.focus();
            },
        })));
    }

    /** Makes a card from the same text again (from a card's page). */
    regenerate(text, style) {
        this.el.input.value = text;
        write(DRAFT_KEY, text);
        if (this.styles.some((s) => s.id === style)) this.setStyle(style);
        this.sync();
        this.generate();
    }

    // ── Generating ───────────────────────────────────────────────────────

    async generate() {
        const { input, submitLabel, result } = this.el;
        const text = input.value.trim();
        if (this.busy || !text || [...text].length > MAX_LENGTH) return;
        const style = this.style;
        const previous = this.card;

        this.busy = true;
        this.card = null;
        this.sync();
        submitLabel.textContent = '生成中…';
        this.startPreview(style);
        if (matchMedia('(pointer: coarse)').matches) input.blur(); // put the keyboard away
        requestAnimationFrame(() => result.scrollIntoView({ block: 'start', behavior: 'smooth' }));

        let reply = '';
        let created = null;
        try {
            await streamCard({ text, style }, (name, data) => {
                if (name === 'delta') {
                    reply += data.text;
                    const html = htmlSoFar(reply);
                    if (html) {
                        if (!this.el.waiting.hidden) {
                            this.el.waiting.hidden = true;
                            this.el.label.textContent = `${STAGE.writing} · ${this.styleName(style)}…`;
                        }
                        this.preview.show(html);
                    }
                } else if (name === 'stage') {
                    // "writing" starts before the model has thought it through; the
                    // label switches when the first HTML arrives.
                    if (data.stage !== 'writing') this.el.label.textContent = `${STAGE[data.stage] || '处理中'}…`;
                } else if (name === 'done') {
                    created = data.card;
                } else if (name === 'error') {
                    throw new Error(data.message);
                }
            });
            if (!created) throw new Error('生成没有完成，请再试一次');
        } catch (err) {
            toast(err.message, { type: 'error' });
        } finally {
            this.busy = false;
            submitLabel.textContent = '生成';
            this.sync();
        }
        if (created) {
            this.showCard(created, true);
            if (this.recent) this.recent.unshift(created);
            this.onCreated(created);
        } else {
            this.showCard(previous);
        }
        this.renderRecent();
    }

    startPreview(style) {
        const { result, img, waiting, actions, label, stage } = this.el;
        result.hidden = false;
        result.classList.add('is-live');
        img.hidden = true;
        img.removeAttribute('src');
        waiting.hidden = false;
        actions.hidden = true;
        stage.classList.remove('q-rise');
        label.textContent = `${STAGE.thinking} · ${this.styleName(style)}…`;
        this.preview.clear();
    }

    /** Shows a saved card's image in the result area (null hides it). */
    showCard(card, fresh = false) {
        const { result, img, waiting, actions, label, stage } = this.el;
        this.card = card;
        result.classList.remove('is-live');
        if (!card) {
            result.hidden = true;
            this.preview.clear();
            return;
        }
        result.hidden = false;
        waiting.hidden = true;
        label.textContent = `${this.styleName(card.style)} · 刚刚`;
        img.style.aspectRatio = `${card.width} / ${card.height}`;
        img.alt = card.title;
        img.onload = () => {
            this.preview.clear();
            stage.style.height = '';
        };
        img.src = `/img/${card.id}.png`;
        img.hidden = false;
        if (fresh) {
            stage.classList.remove('q-rise');
            void stage.offsetWidth;
            stage.classList.add('q-rise');
        }
        actions.hidden = false;
        actions.replaceChildren(...cardActions(card, () => this.regenerate(card.text, card.style)));
    }

    // ── Recent cards ─────────────────────────────────────────────────────

    async loadRecent() {
        try {
            const page = await api(`/api/cards?limit=${RECENT + 1}`);
            this.recent = page.items;
        } catch (err) {
            this.recent = [];
            toast(err.message, { type: 'error' });
        }
        this.renderRecent();
    }

    renderRecent() {
        const { recentSec, recent } = this.el;
        if (!this.recent) return;
        const items = this.recent.filter((c) => !isGone(c.id) && c.id !== this.card?.id).slice(0, RECENT);
        recentSec.hidden = !items.length;
        recent.replaceChildren(...items.map(tile));
    }
}

function cardActions(card, regenerate) {
    return actions(card, [
        h('button', { class: 'q-btn q-btn--sm act', type: 'button', onclick: regenerate }, icon('refresh', 'q-i--sm'), '再来一张'),
        h('a', { class: 'q-btn q-btn--sm q-btn--quiet act', href: `#card/${card.id}` }, icon('open', 'q-i--sm'), '详情'),
    ]);
}
