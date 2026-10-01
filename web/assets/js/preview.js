// The live preview: as the model streams HTML, the part received so far is
// parsed and written into a sandboxed frame (no scripts run there), scaled to
// the column. Only the styles and the body are swapped, so the frame never
// reloads and fonts stay loaded between updates. Parsing happens inside the
// frame's own document (a <template>), so the card's inline styles fall under
// the frame's policy rather than the page's stricter one.

const CARD_WIDTH = 600;
const START = /<!doctype|<html|<head|<style|<body|<article/i;

/** The HTML part of a partial reply: from the first tag on, without a code fence. */
export function htmlSoFar(reply) {
    let text = reply.replace(/```(?:html)?/gi, '');
    const i = text.search(START);
    return i >= 0 ? text.slice(i) : '';
}

export class Preview {
    constructor(frame, stage) {
        this.frame = frame;
        this.stage = stage;
        this.pending = null;
        this.scheduled = false;
        this.height = 0;
        this.loaded = new Promise((resolve) => {
            if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.getElementById('card-css')) resolve();
            else frame.addEventListener('load', () => resolve(), { once: true });
        });
        new ResizeObserver(() => this.fit()).observe(stage);
    }

    clear() {
        this.pending = null;
        this.height = 0;
        this.loaded.then(() => {
            const doc = this.frame.contentDocument;
            doc.getElementById('card-css').textContent = '';
            doc.body.replaceChildren();
            this.fit();
        });
    }

    /** Shows `html` (possibly incomplete); updates are batched per frame. */
    show(html) {
        this.pending = html;
        if (this.scheduled) return;
        this.scheduled = true;
        this.loaded.then(() => requestAnimationFrame(() => {
            this.scheduled = false;
            this.apply(this.pending);
        }));
    }

    apply(html) {
        if (html == null) return;
        const doc = this.frame.contentDocument;
        // A template keeps the parsed card inert; <html>, <head> and <body>
        // tags are dropped and their contents kept.
        const tpl = doc.createElement('template');
        tpl.innerHTML = html;
        const styles = [...tpl.content.querySelectorAll('style')];
        doc.getElementById('card-css').textContent = styles.map((s) => s.textContent).join('\n');
        tpl.content.querySelectorAll('style, script, link, meta, title, base').forEach((el) => el.remove());
        doc.body.replaceChildren(tpl.content);
        const card = doc.querySelector('.card') || doc.body.firstElementChild;
        this.height = card ? Math.ceil(card.getBoundingClientRect().bottom) : 0;
        this.fit();
    }

    fit() {
        const scale = this.stage.clientWidth / CARD_WIDTH || 1;
        this.frame.style.height = `${Math.max(this.height, 1)}px`;
        this.frame.style.transform = `scale(${scale})`;
        this.stage.style.height = this.height ? `${Math.ceil(this.height * scale)}px` : '';
    }
}
