// Session storage and the authenticated fetch wrapper.

const TOKEN_KEY = 'fs_token';

function read(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

export const session = {
    token: () => read(TOKEN_KEY),

    /** Email from the JWT payload (tokens carry it; nothing else to store). */
    email() {
        const token = read(TOKEN_KEY);
        if (!token) return '';
        try {
            const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const json = decodeURIComponent(escape(atob(b64)));
            return JSON.parse(json).email || '';
        } catch {
            return '';
        }
    },

    save(token) {
        try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
    },

    clear() {
        try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    },
};

export function logout() {
    session.clear();
    window.location.replace('/login');
}

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/**
 * Calls the JSON API. Returns parsed JSON (null for 204), or the raw Response
 * when `raw` is set. Non-2xx responses throw ApiError with the server's
 * message; a 401 on an authenticated call ends the session.
 */
export async function api(path, { method = 'GET', body, raw = false, keepalive = false } = {}) {
    const headers = {};
    const token = session.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
        res = await fetch(path, {
            method,
            headers,
            keepalive,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError('网络连接失败，请检查网络后重试', 0);
    }

    if (res.status === 401 && token) {
        logout();
        throw new ApiError('登录已过期，请重新登录', 401);
    }
    if (!res.ok) {
        let message = `请求失败（${res.status}）`;
        try { message = (await res.json()).error || message; } catch { /* non-JSON body */ }
        throw new ApiError(message, res.status);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    return res.json();
}

/**
 * Starts a card and reads its server-sent events, calling onEvent(name, data)
 * for each. Resolves when the stream ends.
 */
export async function streamCard(body, onEvent) {
    const token = session.token();
    let res;
    try {
        res = await fetch('/api/cards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body),
        });
    } catch {
        throw new ApiError('网络连接失败，请检查网络后重试', 0);
    }
    if (res.status === 401 && token) {
        logout();
        throw new ApiError('登录已过期，请重新登录', 401);
    }
    if (!res.ok) {
        let message = `请求失败（${res.status}）`;
        try { message = (await res.json()).error || message; } catch { /* non-JSON body */ }
        throw new ApiError(message, res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
        let chunk;
        try {
            chunk = await reader.read();
        } catch {
            throw new ApiError('连接中断了；卡片会在后台继续生成，稍后可以在全部卡片里找到', 0);
        }
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, end);
            buf = buf.slice(end + 2);
            let name = 'message';
            let data = '';
            for (const line of block.split('\n')) {
                if (line.startsWith('event: ')) name = line.slice(7);
                else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) onEvent(name, JSON.parse(data));
        }
    }
}
