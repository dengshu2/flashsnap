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

    // Truncate oversized HTML to prevent localStorage quota issues
    const safeHTML = html.length > MAX_HTML_SIZE
        ? html.slice(0, MAX_HTML_SIZE) + '\n<!-- truncated -->'
        : html;

    history.unshift({
        id: Date.now(),
        input: input.slice(0, 100),
        html: safeHTML,
        time: new Date().toISOString(),
    });
    if (history.length > MAX_HISTORY_COUNT) history.length = MAX_HISTORY_COUNT;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
        // localStorage quota exceeded — drop oldest entries and retry
        console.warn('[FlashSnap] localStorage quota exceeded, trimming history');
        history.length = Math.max(1, Math.floor(history.length / 2));
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        } catch { /* give up silently */ }
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
