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

export function addHistory(input, html) {
    const history = getHistory();
    if (html.length > MAX_HTML_SIZE) {
        return {
            saved: false,
            reason: 'too_large',
        };
    }

    history.unshift({
        id: Date.now(),
        input,
        html,
        time: new Date().toISOString(),
    });
    if (history.length > MAX_HISTORY_COUNT) history.length = MAX_HISTORY_COUNT;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        return { saved: true };
    } catch (e) {
        // localStorage quota exceeded — drop oldest entries and retry
        console.warn('[FlashSnap] localStorage quota exceeded, trimming history');
        history.length = Math.max(1, Math.floor(history.length / 2));
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
            return { saved: true };
        } catch {
            return {
                saved: false,
                reason: 'quota',
            };
        }
    }
}

export function clearHistory() {
    localStorage.removeItem(STORAGE_KEY);
}

export function deleteHistoryItem(id) {
    const history = getHistory();
    const filtered = history.filter(h => h.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}
