/**
 * FlashSnap — Theme Management
 * Handles light/dark/system theme switching with localStorage persistence.
 */

const STORAGE_KEY = 'flashsnap_theme';

export function getThemePref() {
    return localStorage.getItem(STORAGE_KEY) || 'system';
}

export function applyTheme(pref, btnTheme) {
    const root = document.documentElement;
    if (pref === 'dark') {
        root.setAttribute('data-theme', 'dark');
    } else if (pref === 'light') {
        root.setAttribute('data-theme', 'light');
    } else {
        // system — remove attribute, let CSS @media handle it
        root.removeAttribute('data-theme');
    }
    updateThemeIcon(pref, btnTheme);
}

export function updateThemeIcon(pref, btnTheme) {
    const isDark = pref === 'dark' ||
        (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const sun = btnTheme.querySelector('.icon-sun');
    const moon = btnTheme.querySelector('.icon-moon');
    sun.style.display = isDark ? 'none' : 'block';
    moon.style.display = isDark ? 'block' : 'none';
}

export function toggleTheme(btnTheme) {
    const current = getThemePref();
    const systemIsDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    let next;
    if (current === 'system') {
        next = systemIsDark ? 'light' : 'dark';
    } else if (current === 'dark') {
        next = 'light';
    } else {
        next = 'dark';
    }

    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next, btnTheme);
}

/**
 * Initialize theme: apply saved preference, bind toggle button, listen for
 * system preference changes.
 */
export function initTheme(btnTheme) {
    applyTheme(getThemePref(), btnTheme);
    btnTheme.addEventListener('click', () => toggleTheme(btnTheme));

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getThemePref() === 'system') {
            updateThemeIcon('system', btnTheme);
        }
    });
}
