import { logout, session } from './api.js';
import { Account } from './account.js';
import { CardPage } from './cardpage.js';
import { History } from './history.js';
import { Home } from './home.js';

if (session.token()) {
    boot();
} else {
    window.location.replace('/login');
}

// Full pages switched by the hash, no overlays: home (#), all cards (#history),
// one card (#card/<id>) and the account (#account). The browser's back button
// and Esc return to where you were, with the scroll position kept.
function boot() {
    const $ = (id) => document.getElementById(id);
    const views = { home: $('view-home'), history: $('view-history'), card: $('view-card'), account: $('view-account') };

    const records = new History();
    const account = new Account({ onLogout: () => logout() });
    const home = new Home({
        onCreated: () => {
            records.invalidate();
            account.invalidate();
        },
    });
    const cardPage = new CardPage({
        styleName: (id) => home.styleName(id),
        onRegenerate: (card) => {
            goHome();
            home.regenerate(card.text, card.style);
        },
        onLeave: () => leave(),
    });

    let current = null;
    const scroll = {};
    let moves = 0; // in-app navigations, so Back knows whether it can use the browser history

    function show(name, arg) {
        const from = current;
        if (from === name && name !== 'card') return;
        if (from) scroll[from] = window.scrollY;
        if (from === 'history') records.hide();
        for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
        current = name;

        const el = views[name];
        if (from && from !== name) {
            const cls = name === 'home' || (name === 'history' && from === 'card') ? 'q-enter-back' : 'q-enter';
            el.classList.add(cls);
            el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
        }
        switch (name) {
            case 'home':
                home.show();
                document.title = 'FlashSnap';
                window.scrollTo({ top: scroll.home || 0 });
                break;
            case 'history':
                records.show();
                document.title = '全部卡片 · FlashSnap';
                window.scrollTo({ top: from === 'card' ? scroll.history || 0 : 0 });
                break;
            case 'card':
                cardPage.show(arg);
                window.scrollTo({ top: 0 });
                break;
            case 'account':
                account.show();
                document.title = '账户 · FlashSnap';
                window.scrollTo({ top: 0 });
                break;
        }
    }

    function route() {
        const hash = location.hash.slice(1);
        if (hash.startsWith('card/')) show('card', hash.slice(5));
        else show(hash === 'history' || hash === 'account' ? hash : 'home');
    }

    function goHome() {
        if (location.hash) location.hash = '';
    }

    /** Back to the previous page. */
    function leave() {
        if (moves > 0) window.history.back();
        else location.hash = current === 'card' ? 'history' : '';
    }

    window.addEventListener('hashchange', () => {
        moves = Math.max(0, moves + (location.hash ? 1 : -1));
        route();
    });
    for (const btn of document.querySelectorAll('[data-back]')) btn.addEventListener('click', leave);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && current !== 'home' && !e.defaultPrevented) leave();
    });

    route();
    if (current === 'home' && !matchMedia('(pointer: coarse)').matches) home.focus();
}
