/**
 * FlashSnap — Gemini API 模块
 * 处理与 Gemini Flash API 的通信
 */

import { GoogleGenAI } from '@google/genai';

const MAX_HTML_OUTPUT_TOKENS = 16384;

let aiInstance = null;
let aiInstanceKey = null;  // 缓存 key，用于判断是否需要重新创建

/**
 * 获取或创建 AI 实例（参数不变时复用已有实例）
 */
function getAI(apiKey, baseUrl) {
    const cacheKey = `${apiKey}|${baseUrl || ''}`;
    if (aiInstance && aiInstanceKey === cacheKey) {
        return aiInstance;
    }
    const options = { apiKey };
    if (baseUrl) {
        options.httpOptions = { baseUrl };
    }
    aiInstance = new GoogleGenAI(options);
    aiInstanceKey = cacheKey;
    return aiInstance;
}

/**
 * 测试 API 连接是否正常
 * @param {string} apiKey
 * @param {string} [baseUrl]
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testConnection(apiKey, baseUrl) {
    try {
        const ai = getAI(apiKey, baseUrl);
        // Use models.list() to verify API key — lightweight, no content generation needed
        const pager = await ai.models.list({ config: { pageSize: 1 } });
        let hasModel = false;
        for await (const model of pager) {
            hasModel = true;
            break; // We only need to confirm we can list at least one model
        }
        if (hasModel) {
            return { success: true, message: 'API 连接正常！' };
        }
        return { success: false, message: '未收到有效响应' };
    } catch (error) {
        let message = 'API 连接失败：';
        if (error.message?.includes('API key') || error.message?.includes('401') || error.message?.includes('403')) {
            message += 'API Key 无效';
        } else if (error.message?.includes('network') || error.message?.includes('Failed to fetch')) {
            message += '网络连接失败，请检查网络或 Base URL';
        } else if (error.message?.includes('404')) {
            message += 'API 地址不正确，请检查 Base URL';
        } else {
            message += error.message || '未知错误';
        }
        return { success: false, message };
    }
}

/**
 * 获取可用模型列表
 * @param {string} apiKey
 * @param {string} [baseUrl]
 * @returns {Promise<{success: boolean, models?: Array<{id: string, name: string}>, message?: string}>}
 */
export async function fetchModels(apiKey, baseUrl) {
    try {
        const ai = getAI(apiKey, baseUrl);
        const pager = await ai.models.list({ config: { pageSize: 100 } });

        const models = [];
        for await (const model of pager) {
            // Only include gemini models that support content generation
            const name = model.name || '';
            const displayName = model.displayName || name;

            // Filter: only gemini text generation models
            // Exclude non-text models (embedding, image gen, video, TTS, robotics, etc.)
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
                // model.name comes as "models/gemini-2.0-flash" — extract just the ID
                const modelId = name.replace('models/', '');
                models.push({
                    id: modelId,
                    name: displayName,
                });
            }
        }

        // Sort: prioritize flash models, then by version (newest first)
        models.sort((a, b) => {
            // Extract version numbers for sorting
            // Supports both "gemini-2.5-xxx" and "gemini-3-xxx" formats
            const getVersion = (id) => {
                // Try "X.Y" format first (e.g., gemini-2.5-flash)
                const dotMatch = id.match(/gemini-(\d+)\.(\d+)/);
                if (dotMatch) return parseFloat(`${dotMatch[1]}.${dotMatch[2]}`);
                // Try "X-" format (e.g., gemini-3-flash-preview)
                const intMatch = id.match(/gemini-(\d+)-/);
                if (intMatch) return parseFloat(intMatch[1]);
                return 0;
            };
            const vA = getVersion(a.id);
            const vB = getVersion(b.id);

            // Higher version first
            if (vB !== vA) return vB - vA;

            // Flash before Pro before others
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
            message: `获取模型列表失败：${error.message || '未知错误'}`,
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

function getFinishReason(response) {
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

/**
 * 生成信息卡 HTML（流式）
 * @param {Object} options
 * @param {string} options.apiKey - Gemini API Key
 * @param {string} options.model - 模型名称
 * @param {string} options.userContent - 用户输入的内容
 * @param {string} options.systemPrompt - System Prompt
 * @param {string} [options.baseUrl] - 可选的 API Base URL
 * @param {function} options.onChunk - 流式回调，接收累积的文本
 * @param {function} options.onComplete - 完成回调，接收最终 HTML
 * @param {function} options.onError - 错误回调
 * @returns {Promise<void>}
 */
export async function generateCard({ apiKey, model, userContent, systemPrompt, baseUrl, onChunk, onComplete, onError }) {
    try {
        const ai = getAI(apiKey, baseUrl);

        const response = await ai.models.generateContentStream({
            model,
            contents: userContent,
            config: {
                systemInstruction: systemPrompt,
                maxOutputTokens: MAX_HTML_OUTPUT_TOKENS,
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

        const finishReason = getFinishReason(lastChunk);
        if (finishReason && finishReason !== 'STOP') {
            if (finishReason === 'MAX_TOKENS') {
                throw new Error('模型输出被截断：已达到输出长度上限。请重试，或切换到更稳定的模型。');
            }
            throw new Error(`模型输出未正常完成：${finishReason}`);
        }

        const html = validateGeneratedHTML(extractHTML(fullText));
        onComplete?.(html);
    } catch (error) {
        console.error('Gemini API Error:', error);
        onError?.(error);
    }
}

/**
 * 生成信息卡 HTML（非流式，用于备用）
 */
export async function generateCardSync({ apiKey, model, userContent, systemPrompt, baseUrl }) {
    const ai = getAI(apiKey, baseUrl);

    const response = await ai.models.generateContent({
        model,
        contents: userContent,
        config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: MAX_HTML_OUTPUT_TOKENS,
        },
    });

    const finishReason = getFinishReason(response);
    if (finishReason && finishReason !== 'STOP') {
        if (finishReason === 'MAX_TOKENS') {
            throw new Error('模型输出被截断：已达到输出长度上限。请重试，或切换到更稳定的模型。');
        }
        throw new Error(`模型输出未正常完成：${finishReason}`);
    }

    return validateGeneratedHTML(extractHTML(response.text));
}
