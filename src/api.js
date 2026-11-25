/**
 * FlashSnap — LLM API 模块
 * 支持 OpenAI 兼容协议（DeepSeek / OpenAI / OpenRouter / 中转站）与 Google Gemini 原生协议
 */

const GEMINI_MAX_OUTPUT_TOKENS = 16384;
const OPENAI_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

let aiInstance = null;
let aiInstanceKey = null;  // 缓存 key，用于判断是否需要重新创建

/**
 * 规范化 OpenAI 兼容接口 Base URL
 * - 留空时默认使用 https://api.openai.com/v1
 * - 去除末尾斜杠及误粘贴的 /chat/completions 或 /models 后缀
 * - 若仅填写了域名根路径（如 https://api.deepseek.com），自动补全 /v1
 */
export function normalizeOpenAIBaseUrl(baseUrl) {
    let url = (baseUrl || '').trim().replace(/\/+$/, '');
    if (!url) return DEFAULT_OPENAI_BASE_URL;

    url = url.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '');

    try {
        const parsed = new URL(url);
        if (!parsed.pathname || parsed.pathname === '/') {
            return `${parsed.origin}/v1`;
        }
    } catch {
        // 非标准 URL 保持原样，交由 fetch 报错
    }
    return url;
}

/**
 * 获取或创建 Gemini AI 实例（参数不变时复用已有实例）。
 * SDK 通过动态 import 按需加载，避免打进首屏 bundle。
 */
async function getGeminiAI(apiKey, baseUrl) {
    const cacheKey = `${apiKey}|${baseUrl || ''}`;
    if (aiInstance && aiInstanceKey === cacheKey) {
        return aiInstance;
    }
    const { GoogleGenAI } = await import('@google/genai');
    const options = { apiKey };
    if (baseUrl) {
        options.httpOptions = { baseUrl };
    }
    aiInstance = new GoogleGenAI(options);
    aiInstanceKey = cacheKey;
    return aiInstance;
}

async function parseErrorMessage(response) {
    const status = response.status;
    let detail = '';
    try {
        const text = await response.text();
        if (text) {
            try {
                const json = JSON.parse(text);
                detail = json?.error?.message || json?.message || text;
            } catch {
                detail = text.slice(0, 200);
            }
        }
    } catch {
        // ignore
    }
    if (status === 401 || status === 403) {
        return `API Key 无效或无权限 (HTTP ${status})${detail ? `：${detail}` : ''}`;
    }
    if (status === 404) {
        return `接口地址不正确 (HTTP 404)，请检查 Base URL`;
    }
    if (status === 429) {
        return `请求过于频繁或配额不足 (HTTP 429)${detail ? `：${detail}` : ''}`;
    }
    return detail ? `HTTP ${status}：${detail}` : `请求失败 (HTTP ${status})`;
}

function formatConnectionError(error) {
    const msg = error?.message || '';
    if (msg.includes('API Key 无效') || msg.includes('API key') || msg.includes('401') || msg.includes('403')) {
        return msg.startsWith('API Key') ? msg : 'API Key 无效';
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network')) {
        return '网络连接失败（请检查网络、Base URL，或确认接口允许浏览器跨域 CORS）';
    }
    if (msg.includes('404')) {
        return 'API 地址不正确，请检查 Base URL';
    }
    return msg || '未知错误';
}

/**
 * 测试 API 连接是否正常
 * @param {string} apiKey
 * @param {string} [baseUrl]
 * @param {'openai'|'gemini'} [provider='openai']
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testConnection(apiKey, baseUrl, provider = 'openai') {
    if (provider === 'gemini') {
        try {
            const ai = await getGeminiAI(apiKey, baseUrl);
            const pager = await ai.models.list({ config: { pageSize: 1 } });
            let hasModel = false;
            for await (const _model of pager) {
                hasModel = true;
                break;
            }
            if (hasModel) {
                return { success: true, message: 'API 连接正常！' };
            }
            return { success: false, message: '未收到有效响应' };
        } catch (error) {
            return { success: false, message: `API 连接失败：${formatConnectionError(error)}` };
        }
    }

    // OpenAI 兼容协议
    try {
        const endpoint = `${normalizeOpenAIBaseUrl(baseUrl)}/models`;
        const resp = await fetch(endpoint, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
        });
        if (!resp.ok) {
            const errMsg = await parseErrorMessage(resp);
            return { success: false, message: `API 连接失败：${errMsg}` };
        }
        return { success: true, message: 'API 连接正常！' };
    } catch (error) {
        return { success: false, message: `API 连接失败：${formatConnectionError(error)}` };
    }
}

/**
 * 获取可用模型列表
 * @param {string} apiKey
 * @param {string} [baseUrl]
 * @param {'openai'|'gemini'} [provider='openai']
 * @returns {Promise<{success: boolean, models?: Array<{id: string, name: string}>, message?: string}>}
 */
export async function fetchModels(apiKey, baseUrl, provider = 'openai') {
    if (provider === 'gemini') {
        try {
            const ai = await getGeminiAI(apiKey, baseUrl);
            const pager = await ai.models.list({ config: { pageSize: 100 } });

            const models = [];
            for await (const model of pager) {
                const name = model.name || '';
                const displayName = model.displayName || name;

                if (
                    name.includes('gemini') &&
                    !name.includes('embedding') &&
                    !name.includes('aqa') &&
                    !name.includes('imagen') &&
                    !name.includes('bisheng') &&
                    !name.includes('veo') &&
                    !name.includes('tts') &&
                    !name.includes('image-generation') &&
                    !name.includes('image-preview') &&
                    !name.includes('robotics') &&
                    !name.includes('nano-banana') &&
                    !name.includes('deep-research') &&
                    !name.includes('computer-use')
                ) {
                    const modelId = name.replace('models/', '');
                    models.push({
                        id: modelId,
                        name: displayName,
                    });
                }
            }

            models.sort((a, b) => {
                const getVersion = (id) => {
                    const dotMatch = id.match(/gemini-(\d+)\.(\d+)/);
                    if (dotMatch) return parseFloat(`${dotMatch[1]}.${dotMatch[2]}`);
                    const intMatch = id.match(/gemini-(\d+)-/);
                    if (intMatch) return parseFloat(intMatch[1]);
                    return 0;
                };
                const vA = getVersion(a.id);
                const vB = getVersion(b.id);
                if (vB !== vA) return vB - vA;

                const typeOrder = (id) => {
                    if (id.includes('flash')) return 0;
                    if (id.includes('pro')) return 1;
                    return 2;
                };
                return typeOrder(a.id) - typeOrder(b.id);
            });

            return { success: true, models };
        } catch (error) {
            return {
                success: false,
                message: `获取模型列表失败：${formatConnectionError(error)}`,
            };
        }
    }

    // OpenAI 兼容协议
    try {
        const endpoint = `${normalizeOpenAIBaseUrl(baseUrl)}/models`;
        const resp = await fetch(endpoint, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
        });
        if (!resp.ok) {
            const errMsg = await parseErrorMessage(resp);
            return { success: false, message: `获取模型列表失败：${errMsg}` };
        }

        const data = await resp.json();
        const rawList = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        const excludePattern = /(embedding|whisper|tts|dall-e|moderation|rerank|babbage|davinci|omni-moderation|sora|transcribe|realtime|audio-preview|image-1)/i;

        const seen = new Set();
        const models = [];
        for (const item of rawList) {
            const id = typeof item === 'string' ? item : item?.id;
            if (!id || seen.has(id) || excludePattern.test(id)) continue;
            seen.add(id);
            models.push({
                id,
                name: item?.name && item.name !== id ? `${item.name} (${id})` : id,
            });
        }

        models.sort((a, b) => a.id.localeCompare(b.id));
        return { success: true, models };
    } catch (error) {
        return {
            success: false,
            message: `获取模型列表失败：${formatConnectionError(error)}`,
        };
    }
}

/**
 * 从 AI 返回的文本中提取纯 HTML 代码
 * 处理多种格式：
 * 1. 分析文字 + ```html ... ``` 代码块
 * 2. 整段就是 ```html ... ``` 代码块
 * 3. 直接输出的 HTML（以 <!DOCTYPE 或 <html 或 <link 开头）
 * 4. HTML 前后夹带分析/自检文字
 */
function extractHTML(text) {
    const raw = text.trim();

    // 1. 优先提取 markdown 代码块中的 HTML
    const codeBlockMatches = [...raw.matchAll(/```(?:html)?\s*\n?([\s\S]*?)\n?```/gi)];
    if (codeBlockMatches.length > 0) {
        const bestMatch = codeBlockMatches
            .map(match => match[1].trim())
            .find(candidate => /<(!DOCTYPE|html|body|style|div|section|article)\b/i.test(candidate));
        if (bestMatch) return bestMatch;
    }

    // 2. 优先截取完整 HTML 文档
    const documentStart = raw.search(/<!DOCTYPE|<html\b/i);
    if (documentStart >= 0) {
        let html = raw.slice(documentStart);
        const htmlEndMatch = html.match(/([\s\S]*<\/html\s*>)/i);
        if (htmlEndMatch) {
            html = htmlEndMatch[1];
        }
        return html.trim();
    }

    // 3. 若模型只返回片段，要求标签出现在新行开头，避免把解释文字中的 "<div>" 误识别为 HTML
    const fragmentMatch = raw.match(/(?:^|\n)\s*(<(?:link|style|body|main|section|article|div)\b[\s\S]*)/i);
    if (fragmentMatch) {
        return fragmentMatch[1].trim();
    }

    return raw;
}

function getGeminiFinishReason(response) {
    return response?.candidates?.[0]?.finishReason || '';
}

function getMeaningfulTextLength(root) {
    if (!root) return 0;

    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const text = node.textContent?.trim();
            if (!text) return NodeFilter.FILTER_REJECT;

            const parentTag = node.parentElement?.tagName;
            if (parentTag && ['STYLE', 'SCRIPT', 'NOSCRIPT', 'TITLE'].includes(parentTag)) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    let total = 0;
    while (walker.nextNode()) {
        total += walker.currentNode.textContent.trim().length;
    }
    return total;
}

function validateGeneratedHTML(html) {
    if (!html || html.length < 120) {
        throw new Error('模型返回的 HTML 过短，疑似未按要求输出卡片。');
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    const card = body?.querySelector('.card') || body?.firstElementChild;

    if (!card) {
        throw new Error('模型返回的 HTML 缺少卡片根节点，无法渲染。');
    }

    const textLength = getMeaningfulTextLength(card);
    const richContentCount = card.querySelectorAll('img, svg, canvas, picture, table, ul, ol, blockquote').length;

    if (textLength < 12 && richContentCount === 0) {
        throw new Error('模型返回的 HTML 没有实际内容，疑似被截断或输出格式跑偏。');
    }

    return html;
}

async function postOpenAIChat({ apiKey, model, userContent, systemPrompt, baseUrl, stream }) {
    const endpoint = `${normalizeOpenAIBaseUrl(baseUrl)}/chat/completions`;
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
    };
    const basePayload = {
        model,
        stream,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
    };

    let resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...basePayload, max_tokens: OPENAI_MAX_OUTPUT_TOKENS }),
    });

    // 部分新模型（如 OpenAI o1/o3/gpt-5）拒绝 max_tokens 参数，自动回退为不传 max_tokens 重试一次
    if (resp.status === 400) {
        const cloned = resp.clone();
        const errText = await cloned.text().catch(() => '');
        if (/max_tokens|max_completion_tokens/i.test(errText)) {
            resp = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(basePayload),
            });
        }
    }

    if (!resp.ok) {
        throw new Error(await parseErrorMessage(resp));
    }
    return resp;
}

async function generateCardOpenAI({ apiKey, model, userContent, systemPrompt, baseUrl, onChunk }) {
    const resp = await postOpenAIChat({
        apiKey,
        model,
        userContent,
        systemPrompt,
        baseUrl,
        stream: true,
    });

    const contentType = resp.headers.get('content-type') || '';
    // 兼容少数忽略 stream=true 而直接返回 JSON 的中转站
    if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
        const json = await resp.json();
        const choice = json?.choices?.[0];
        const content = choice?.message?.content || '';
        const finishReason = choice?.finish_reason || '';
        if (finishReason === 'length') {
            throw new Error('模型输出被截断：已达到输出长度上限。请重试，或切换到更稳定的模型。');
        }
        if (content) onChunk?.(content);
        return validateGeneratedHTML(extractHTML(content));
    }

    if (!resp.body) {
        throw new Error('接口未返回流式响应体');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';
    let finishReason = '';

    const processLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line || line.startsWith(':') || !line.startsWith('data:')) return;

        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;

        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            return;
        }

        if (parsed?.error?.message) {
            throw new Error(parsed.error.message);
        }

        const choice = parsed?.choices?.[0];
        if (!choice) return;

        const deltaText = choice.delta?.content;
        if (typeof deltaText === 'string' && deltaText.length > 0) {
            fullText += deltaText;
            onChunk?.(fullText);
        }
        if (choice.finish_reason) {
            finishReason = choice.finish_reason;
        }
    };

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                processLine(line);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
            for (const line of buffer.split(/\r?\n/)) {
                processLine(line);
            }
        }
    } finally {
        reader.releaseLock();
    }

    if (finishReason && finishReason !== 'stop') {
        if (finishReason === 'length') {
            throw new Error('模型输出被截断：已达到输出长度上限。请重试，或切换到更稳定的模型。');
        }
        throw new Error(`模型输出未正常完成：${finishReason}`);
    }

    return validateGeneratedHTML(extractHTML(fullText));
}

async function generateCardGemini({ apiKey, model, userContent, systemPrompt, baseUrl, onChunk }) {
    const ai = await getGeminiAI(apiKey, baseUrl);

    const response = await ai.models.generateContentStream({
        model,
        contents: userContent,
        config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        },
    });

    let fullText = '';
    let lastChunk = null;

    for await (const chunk of response) {
        lastChunk = chunk;
        if (chunk.text) {
            fullText += chunk.text;
            onChunk?.(fullText);
        }
    }

    const finishReason = getGeminiFinishReason(lastChunk);
    if (finishReason && finishReason !== 'STOP') {
        if (finishReason === 'MAX_TOKENS') {
            throw new Error('模型输出被截断：已达到输出长度上限。请重试，或切换到更稳定的模型。');
        }
        throw new Error(`模型输出未正常完成：${finishReason}`);
    }

    return validateGeneratedHTML(extractHTML(fullText));
}

/**
 * 生成信息卡 HTML（流式）
 * @param {Object} options
 * @param {'openai'|'gemini'} [options.provider='openai'] - 接口协议
 * @param {string} options.apiKey - API Key
 * @param {string} options.model - 模型名称
 * @param {string} options.userContent - 用户输入的内容
 * @param {string} options.systemPrompt - System Prompt
 * @param {string} [options.baseUrl] - 可选的 API Base URL
 * @param {function} options.onChunk - 流式回调，接收累积的文本
 * @param {function} options.onComplete - 完成回调，接收最终 HTML
 * @param {function} options.onError - 错误回调
 * @returns {Promise<void>}
 */
export async function generateCard({ provider = 'openai', apiKey, model, userContent, systemPrompt, baseUrl, onChunk, onComplete, onError }) {
    try {
        const html = provider === 'gemini'
            ? await generateCardGemini({ apiKey, model, userContent, systemPrompt, baseUrl, onChunk })
            : await generateCardOpenAI({ apiKey, model, userContent, systemPrompt, baseUrl, onChunk });
        onComplete?.(html);
    } catch (error) {
        console.error('LLM API Error:', error);
        onError?.(error);
    }
}

/**
 * 生成信息卡 HTML（非流式，用于备用）
 */
export async function generateCardSync({ provider = 'openai', apiKey, model, userContent, systemPrompt, baseUrl }) {
    if (provider === 'gemini') {
        const ai = await getGeminiAI(apiKey, baseUrl);
        const response = await ai.models.generateContent({
            model,
            contents: userContent,
            config: {
                systemInstruction: systemPrompt,
                maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            },
        });
        const finishReason = getGeminiFinishReason(response);
        if (finishReason && finishReason !== 'STOP') {
            if (finishReason === 'MAX_TOKENS') {
                throw new Error('模型输出被截断：已达到输出长度上限。请重试，或切换到更稳定的模型。');
            }
            throw new Error(`模型输出未正常完成：${finishReason}`);
        }
        return validateGeneratedHTML(extractHTML(response.text));
    }

    const resp = await postOpenAIChat({
        apiKey,
        model,
        userContent,
        systemPrompt,
        baseUrl,
        stream: false,
    });
    const json = await resp.json();
    const choice = json?.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== 'stop') {
        if (choice.finish_reason === 'length') {
            throw new Error('模型输出被截断：已达到输出长度上限。请重试，或切换到更稳定的模型。');
        }
        throw new Error(`模型输出未正常完成：${choice.finish_reason}`);
    }
    return validateGeneratedHTML(extractHTML(choice?.message?.content || ''));
}
