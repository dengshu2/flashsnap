/**
 * FlashSnap — Gemini API 模块
 * 处理与 Gemini Flash API 的通信
 */

import { GoogleGenAI } from '@google/genai';

let aiInstance = null;

/**
 * 获取或创建 AI 实例
 */
function getAI(apiKey, baseUrl) {
    const options = { apiKey };
    if (baseUrl) {
        options.httpOptions = { baseUrl };
    }
    aiInstance = new GoogleGenAI(options);
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
    let raw = text.trim();

    // 1. Try to find a ```html ... ``` or ``` ... ``` code block WITHIN the text
    const codeBlockInText = /```(?:html)?\s*\n([\s\S]*?)\n\s*```/;
    const blockMatch = raw.match(codeBlockInText);
    if (blockMatch) {
        return blockMatch[1].trim();
    }

    // 2. Find the HTML boundaries — strip leading and trailing non-HTML text
    const htmlStart = raw.search(/<(!DOCTYPE|html|link|head|style|div)/i);
    if (htmlStart >= 0) {
        let html = raw.slice(htmlStart);

        // Strip trailing text after the last closing </html> tag
        const htmlEndMatch = html.match(/([\s\S]*<\/html\s*>)/i);
        if (htmlEndMatch) {
            html = htmlEndMatch[1];
        }

        return html.trim();
    }

    // 3. Fallback: return the whole text
    return raw;
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
                maxOutputTokens: 8192,
            },
        });

        let fullText = '';

        for await (const chunk of response) {
            if (chunk.text) {
                fullText += chunk.text;
                onChunk?.(fullText);
            }
        }

        const html = extractHTML(fullText);
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
            maxOutputTokens: 8192,
        },
    });

    return extractHTML(response.text);
}
