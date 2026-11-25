/**
 * FlashSnap — History Management
 * Handles history CRUD operations with localStorage persistence.
 */

const STORAGE_KEY = 'flashsnap_history';
const MAX_HISTORY_COUNT = 15;
const MAX_HTML_SIZE = 200 * 1024; // 200 KB per entry

export function getHistory() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
        return [];
    }
}

function persistHistory(history) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        return { saved: true };
    } catch {
        // localStorage quota exceeded — drop oldest entries and retry
        console.warn('[FlashSnap] localStorage quota exceeded, trimming history');
        const trimmed = history.slice(0, Math.max(1, Math.floor(history.length / 2)));
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
            return { saved: true };
        } catch {
            return {
                saved: false,
                reason: 'quota',
            };
        }
    }
}

export function addHistory(input, html, title = '') {
    const history = getHistory();
    if (html.length > MAX_HTML_SIZE) {
        return {
            saved: false,
            reason: 'too_large',
        };
    }

    history.unshift({
        id: Date.now(),
        title: title || '',
        input,
        html,
        time: new Date().toISOString(),
    });
    if (history.length > MAX_HISTORY_COUNT) history.length = MAX_HISTORY_COUNT;
    return persistHistory(history);
}

export function clearHistory() {
    localStorage.removeItem(STORAGE_KEY);
}

export function deleteHistoryItem(id) {
    const history = getHistory();
    const index = history.findIndex((h) => h.id === id);
    if (index === -1) return null;
    const [item] = history.splice(index, 1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    return { item, index };
}

export function restoreHistoryItem(item, index = 0) {
    if (!item) return { saved: false };
    const history = getHistory().filter((h) => h.id !== item.id);
    const pos = Math.max(0, Math.min(index, history.length));
    history.splice(pos, 0, item);
    if (history.length > MAX_HISTORY_COUNT) history.length = MAX_HISTORY_COUNT;
    return persistHistory(history);
}
