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
 * 从 AI 返回的文本中提取纯 HTML 代码
 * 去除 markdown 代码块标记等
 */
function extractHTML(text) {
    // Remove ```html ... ``` wrapper if present
    let html = text.trim();

    // Match ```html or ``` at start and ``` at end
    const codeBlockRegex = /^```(?:html)?\s*\n?([\s\S]*?)\n?\s*```$/;
    const match = html.match(codeBlockRegex);
    if (match) {
        html = match[1].trim();
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
