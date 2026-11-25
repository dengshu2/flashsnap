/**
 * FlashSnap — 主逻辑
 */

import { generateCard, testConnection, fetchModels } from './api.js';
import {
  copyToClipboard,
  downloadImage,
  invalidateCaptureCache,
  warmCaptureCache,
  prewarmDefaultFonts,
} from './export.js';
import { DEFAULT_FONT_HREF, parseAndCleanCardHTML, cleanCSS } from './cardhtml.js';
import { CARD_SYSTEM_PROMPT } from './prompts.js';
import { initTheme } from './theme.js';
import {
  getHistory,
  addHistory,
  clearHistory,
  deleteHistoryItem,
  restoreHistoryItem,
} from './history.js';

// 联调开关：?mock=stream 时用内置样例卡模拟 Gemini 流式返回（无需 API Key），
// 用于验证流式渲染管线。mock 代码按需加载，不进首屏包。
const MOCK_STREAM = new URLSearchParams(location.search).get('mock') === 'stream';

// ============================================
// State
// ============================================
const state = {
  isGenerating: false,
  currentHTML: null,
  currentTitle: '',
  lastInput: '',
  lastTestResult: null, // null = not tested, true = success, false = failed
  testedApiKey: null,   // the API key that was tested
};

// ============================================
// DOM Elements
// ============================================
const $ = (sel) => document.querySelector(sel);

const els = {
  inputText: $('#input-text'),
  charCount: $('#char-count'),
  btnGenerate: $('#btn-generate'),
  btnClear: $('#btn-clear'),
  btnCopy: $('#btn-copy'),
  btnDownload: $('#btn-download'),

  btnRegenerate: $('#btn-regenerate'),
  btnSettings: $('#btn-settings'),
  btnHistory: $('#btn-history'),
  previewFrame: $('#preview-frame'),
  previewActions: $('#preview-actions'),
  previewContainer: $('#preview-container'),
  emptyState: $('#empty-state'),
  loadingState: $('#loading-state'),
  loadingProgress: $('#loading-progress'),
  streamBadge: $('#stream-badge'),
  streamBadgeText: $('#stream-badge-text'),

  // Settings modal
  settingsModal: $('#settings-modal'),
  btnCloseSettings: $('#btn-close-settings'),
  btnSaveSettings: $('#btn-save-settings'),
  providerSelect: $('#provider-select'),
  openaiPresets: $('#openai-presets'),
  baseUrlLabel: $('#base-url-label'),
  baseUrlHint: $('#base-url-hint'),
  apiKeyLabel: $('#api-key-label'),
  apiKeyHint: $('#api-key-hint'),
  apiKeyInput: $('#api-key-input'),
  modelSelect: $('#model-select'),
  modelCustomInput: $('#model-custom-input'),
  baseUrlInput: $('#base-url-input'),
  btnToggleKey: $('#btn-toggle-key'),
  btnTestApi: $('#btn-test-api'),
  apiTestStatus: $('#api-test-status'),
  btnRefreshModels: $('#btn-refresh-models'),
  modelHint: $('#model-hint'),

  // History modal
  historyModal: $('#history-modal'),
  btnCloseHistory: $('#btn-close-history'),
  btnClearHistory: $('#btn-clear-history'),
  historyList: $('#history-list'),

  // Mobile tabs
  mobileTabBar: $('#mobile-tab-bar'),
  tabInput: $('#tab-input'),
  tabPreview: $('#tab-preview'),
  panelInput: document.querySelector('.panel-input'),
  panelPreview: document.querySelector('.panel-preview'),

  // Theme
  btnTheme: $('#btn-theme'),
};

// ============================================
// Settings / Storage
// ============================================
const CUSTOM_MODEL_VALUE = '__custom__';

const PROVIDER_DEFAULTS = {
  openai: {
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModels: [
      { id: 'deepseek-chat', name: 'deepseek-chat (DeepSeek)' },
      { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini (OpenAI)' },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini (OpenAI)' },
    ],
  },
  gemini: {
    model: 'gemini-2.5-flash',
    baseUrl: '',
    defaultModels: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash（默认）' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    ],
  },
};

const OPENAI_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash' },
};

function getSettings() {
  const savedProvider = localStorage.getItem('flashsnap_provider');
  const savedApiKey = localStorage.getItem('flashsnap_api_key') || '';
  // 兼容旧版：如果之前已保存过 Gemini API Key 但没写过 provider，默认沿用 gemini
  const provider = savedProvider || (savedApiKey ? 'gemini' : 'openai');
  const defaultModel = PROVIDER_DEFAULTS[provider]?.model || 'deepseek-chat';
  const defaultBaseUrl = savedProvider ? '' : (provider === 'openai' ? PROVIDER_DEFAULTS.openai.baseUrl : '');

  return {
    provider,
    apiKey: savedApiKey,
    model: localStorage.getItem('flashsnap_model') || defaultModel,
    baseUrl: localStorage.getItem('flashsnap_base_url') ?? defaultBaseUrl,
  };
}

function saveSettings(settings) {
  if (settings.provider) localStorage.setItem('flashsnap_provider', settings.provider);
  if (settings.apiKey) localStorage.setItem('flashsnap_api_key', settings.apiKey);
  if (settings.model) localStorage.setItem('flashsnap_model', settings.model);
  if (settings.baseUrl !== undefined) localStorage.setItem('flashsnap_base_url', settings.baseUrl);
}

// ============================================
// Toast
// ============================================
function showToast(message, type = 'success', { action = null, duration = 3000 } = {}) {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.textContent = icon;
  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  toast.appendChild(iconSpan);
  toast.appendChild(msgSpan);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    toast.style.animation = 'toastOut 300ms ease forwards';
    setTimeout(() => toast.remove(), 300);
  };

  if (action && action.label && typeof action.onClick === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'toast-action';
    actionBtn.textContent = action.label;
    actionBtn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    toast.appendChild(actionBtn);
  }

  container.appendChild(toast);
  const timer = setTimeout(dismiss, duration);
}

function syncCharCount() {
  els.charCount.textContent = `${els.inputText.value.length} 字`;
}

// ============================================
// UI State Management
// ============================================
function showState(stateName) {
  els.emptyState.style.display = stateName === 'empty' ? 'block' : 'none';
  els.loadingState.style.display = stateName === 'loading' ? 'block' : 'none';
  // 'streaming' = 卡片边生成边渲染：iframe 可见，但操作按钮仍隐藏
  // （此时复制/下载会截到半成品卡片）
  els.previewFrame.style.display =
    stateName === 'preview' || stateName === 'streaming' ? 'block' : 'none';
  els.streamBadge.style.display = stateName === 'streaming' ? 'flex' : 'none';
  // Use visibility+opacity via CSS class instead of display:none so that
  // the action buttons always occupy space and don't shift the header height.
  els.previewActions.classList.toggle('visible', stateName === 'preview');
}

function setGenerating(isGenerating) {
  state.isGenerating = isGenerating;
  els.btnGenerate.disabled = isGenerating;

  if (isGenerating) {
    els.btnGenerate.querySelector('.btn-text').textContent = '生成中...';
    els.btnGenerate.querySelector('.btn-icon').textContent = '⏳';
    // On mobile, switch to preview tab to show loading state
    if (isMobile()) {
      switchTab('preview');
    }
  } else {
    els.btnGenerate.querySelector('.btn-text').textContent = '生成卡片';
    els.btnGenerate.querySelector('.btn-icon').textContent = '✨';
  }
}

// ============================================
// Mobile Tab Switching
// ============================================
function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

let _activeTab = 'input';

function switchTab(tabName) {
  // No-op if already on this tab — prevents re-triggering the forceScrollTop
  // setTimeout chain and interfering with in-flight touch events on iOS.
  if (isMobile() && tabName === _activeTab) return;
  _activeTab = tabName;
  // 1. 收起键盘（必须在 DOM 变化前）
  if (isMobile() && document.activeElement) {
    document.activeElement.blur();
  }

  // 2. 先 scroll 到顶（在面板切换前，减少 layout shift 影响）
  if (isMobile()) {
    forceScrollTop();
  }

  // 3. Update tab buttons
  els.tabInput.classList.toggle('active', tabName === 'input');
  els.tabPreview.classList.toggle('active', tabName === 'preview');

  // 4. Switch panels
  els.panelInput.classList.toggle('panel-hidden', tabName !== 'input');
  els.panelPreview.classList.toggle('panel-hidden', tabName !== 'preview');

  // 5. 面板切换后多次延迟 scroll，覆盖键盘收起各阶段的 viewport 变化
  if (isMobile()) {
    forceScrollTop();
    requestAnimationFrame(forceScrollTop);
    setTimeout(forceScrollTop, 50);
    setTimeout(forceScrollTop, 150);
    setTimeout(forceScrollTop, 350);
  }
}

function initMobileTabs() {
  if (!isMobile()) {
    // Desktop: ensure both panels are visible
    els.panelInput.classList.remove('panel-hidden');
    els.panelPreview.classList.remove('panel-hidden');
    return;
  }

  // Mobile: default to input tab, hide preview
  els.panelPreview.classList.add('panel-hidden');
  els.panelInput.classList.remove('panel-hidden');
}

// ============================================
// Persistent Preview Shell（不重载 iframe，字体常驻、零闪烁）
// ============================================
let activeResizeObserver = null;
let activeResizeDisconnectTimer = null;

function ensurePreviewShell(iframe) {
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  if (doc.getElementById('card-css') && doc.getElementById('flashsnap-reset-style')) {
    return doc;
  }

  doc.open();
  doc.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${DEFAULT_FONT_HREF}">
<style id="flashsnap-reset-style">
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    background: transparent !important;
    height: auto !important;
    min-height: 0 !important;
    overflow: hidden !important;
  }
</style>
<style id="card-css"></style>
</head>
<body></body>
</html>`);
  doc.close();
  return doc;
}

function syncExtraFontLinks(doc, fontLinks) {
  if (!fontLinks || fontLinks.length === 0) return;
  const existing = new Set(
    [...doc.querySelectorAll('link[rel="stylesheet"][href]')].map((l) => l.getAttribute('href'))
  );
  for (const href of fontLinks) {
    if (existing.has(href)) continue;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    doc.head.appendChild(link);
    existing.add(href);
  }
}

function detachPreviewResizeObserver() {
  clearTimeout(activeResizeDisconnectTimer);
  activeResizeDisconnectTimer = null;
  if (activeResizeObserver) {
    activeResizeObserver.disconnect();
    activeResizeObserver = null;
  }
}

/**
 * 按卡片自然尺寸设置 iframe 大小，并缩放适配容器宽度。
 * 流式渲染与最终渲染共用同一套测量逻辑。
 * @returns {boolean} 文档是否已可测量（body/html 存在）
 */
function sizeIframeToCard(iframe, container, doc) {
  const body = doc.body;
  const htmlEl = doc.documentElement;
  if (!body || !htmlEl) return false;

  const cardEl = body.querySelector('.card') || body.firstElementChild;
  const cardWidth = cardEl ? Math.max(cardEl.scrollWidth, cardEl.offsetWidth, 900) : 900;

  iframe.style.width = cardWidth + 'px';

  const cardHeight = cardEl
    ? Math.max(cardEl.scrollHeight, cardEl.offsetHeight)
    : Math.max(body.scrollHeight, body.offsetHeight);
  const height = Math.max(cardHeight, 1);
  iframe.style.height = height + 'px';

  const containerWidth = container.clientWidth - 48; // subtract padding
  if (containerWidth > 0 && containerWidth < cardWidth) {
    const scale = containerWidth / cardWidth;
    iframe.style.transform = `scale(${scale})`;
    iframe.style.transformOrigin = 'top center';
    iframe.style.marginBottom = `-${Math.ceil(height * (1 - scale))}px`;
  } else {
    iframe.style.transform = 'none';
    iframe.style.marginBottom = '0';
  }
  return true;
}

/**
 * 将完整 HTML 清洗并渲染到常驻 iframe 壳中（不重建文档、不闪烁），
 * 渲染后立即后台预热 PNG Blob 以实现瞬时复制/下载。
 * @param {string} html
 * @param {Object} [options]
 * @param {boolean} [options.instant] - 流式渲染已展示过内容时置 true
 * @returns {string} 提取出的卡片标题
 */
function renderToIframe(html, { instant = false } = {}) {
  const iframe = els.previewFrame;
  const container = els.previewContainer;
  invalidateCaptureCache(iframe);
  detachPreviewResizeObserver();

  if (!instant) {
    iframe.style.opacity = '0';
    iframe.style.transition = 'none';
    iframe.style.transform = 'none';
    iframe.style.transformOrigin = 'top left';
    iframe.style.width = '900px';
    iframe.style.maxWidth = 'none';
    iframe.style.height = 'auto';
  }

  const doc = ensurePreviewShell(iframe);
  const { css, bodyHTML, fontLinks, title } = parseAndCleanCardHTML(html);

  syncExtraFontLinks(doc, fontLinks);
  doc.getElementById('card-css').textContent = css;
  doc.body.innerHTML = bodyHTML;

  let revealed = instant;
  let warmed = false;
  const resizeIframe = () => {
    try {
      if (!sizeIframeToCard(iframe, container, doc)) return;

      if (!revealed) {
        revealed = true;
        iframe.offsetHeight;
        iframe.style.transition = 'opacity 200ms ease';
        iframe.style.opacity = '1';

        if (isMobile()) {
          forceScrollTop();
          setTimeout(forceScrollTop, 50);
        }
      }

      if (!warmed) {
        warmed = true;
        warmCaptureCache(iframe);
      }
    } catch {
      // ignore
    }
  };

  requestAnimationFrame(resizeIframe);
  setTimeout(resizeIframe, 250);

  try {
    if (doc.body) {
      activeResizeObserver = new ResizeObserver(() => {
        resizeIframe();
        clearTimeout(activeResizeDisconnectTimer);
        activeResizeDisconnectTimer = setTimeout(detachPreviewResizeObserver, 2000);
      });
      activeResizeObserver.observe(doc.body);
    }
  } catch {
    setTimeout(resizeIframe, 800);
  }

  return title;
}

// ============================================
// Streaming Preview（常驻 iframe + <template> 合帧局部替换）
// ============================================
const STREAM_REVEAL_FALLBACK_CHARS = 3000;

function extractStreamHTML(reply) {
  const fence = reply.match(/```(?:html)?\s*\n/i);
  const tagIdx = reply.search(/<!DOCTYPE|<html\b|<head\b|<link\b|<style\b|<body\b|<div\b|<article\b/i);
  let start = -1;
  if (fence && (tagIdx === -1 || fence.index <= tagIdx)) {
    start = fence.index + fence[0].length;
  } else {
    start = tagIdx;
  }
  if (start < 0) return '';

  let slice = reply.slice(start);
  const fenceEnd = slice.indexOf('\n```');
  if (fenceEnd !== -1) {
    slice = slice.slice(0, fenceEnd);
  }
  return slice;
}

function createStreamRenderer() {
  const iframe = els.previewFrame;
  const container = els.previewContainer;

  let doc = null;
  let started = false;
  let finished = false;
  let revealed = false;
  let pendingText = null;
  let rafId = 0;

  const begin = () => {
    started = true;
    invalidateCaptureCache(iframe);
    detachPreviewResizeObserver();
    iframe.style.opacity = '0';
    iframe.style.transition = 'none';
    iframe.style.transform = 'none';
    iframe.style.transformOrigin = 'top left';
    iframe.style.width = '900px';
    iframe.style.maxWidth = 'none';
    iframe.style.height = 'auto';
    iframe.style.marginBottom = '0';
    doc = ensurePreviewShell(iframe);
    doc.getElementById('card-css').textContent = '';
    doc.body.replaceChildren();
  };

  const reveal = () => {
    if (revealed) return;
    revealed = true;
    showState('streaming');
    iframe.offsetHeight;
    iframe.style.transition = 'opacity 200ms ease';
    iframe.style.opacity = '1';
    if (isMobile()) forceScrollTop();
  };

  const flush = () => {
    rafId = 0;
    if (finished || pendingText == null) return;
    const raw = pendingText;
    pendingText = null;

    const partial = extractStreamHTML(raw);
    if (!partial) return;

    try {
      if (!started) begin();

      // 在 iframe 自身的 document 内使用 <template> 惰性解析，零脚本执行、零页面重载
      const tpl = doc.createElement('template');
      tpl.innerHTML = partial;

      const styles = [...tpl.content.querySelectorAll('style')];
      doc.getElementById('card-css').textContent = styles
        .map((s) => cleanCSS(s.textContent || ''))
        .join('\n');

      tpl.content
        .querySelectorAll('style, script, link, meta, title, base, iframe, object, embed')
        .forEach((el) => el.remove());

      doc.body.replaceChildren(tpl.content);

      const hasContent = (doc.body.textContent || '').trim().length > 0;
      if (!revealed && hasContent) {
        const styleClosed = /<\/style>/i.test(partial);
        if (styleClosed || partial.length > STREAM_REVEAL_FALLBACK_CHARS) {
          reveal();
        }
      }

      if (revealed) {
        sizeIframeToCard(iframe, container, doc);
      }
    } catch {
      // 流式预览异常不影响最终完整渲染
    }
  };

  return {
    isRevealed: () => revealed,

    /** @param {string} fullText 模型累积输出（onChunk 传入） */
    update(fullText) {
      if (finished) return;
      pendingText = fullText;
      if (!rafId) {
        rafId = requestAnimationFrame(flush);
      }
    },

    finish() {
      if (finished) return;
      finished = true;
      pendingText = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    },
  };
}

// ============================================
// Core: Generate Card
// ============================================
async function handleGenerate() {
  // 防止生成过程中再次触发（例如点击"重试"）导致并发请求互相覆盖
  if (state.isGenerating) return;

  const input = els.inputText.value.trim() || (MOCK_STREAM ? '[mock stream]' : '');

  if (!input) {
    showToast('请输入要生成信息卡的内容', 'error');
    els.inputText.focus();
    return;
  }

  const settings = getSettings();
  if (!settings.apiKey && !MOCK_STREAM) {
    showToast('请先在设置中配置 API Key', 'error');
    showSettingsModal();
    return;
  }

  // 记录上一张卡，若本次生成中途失败则自动恢复，不清空界面
  const previousCard = state.currentHTML
    ? { html: state.currentHTML, title: state.currentTitle, input: state.lastInput }
    : null;

  state.lastInput = input;
  state.currentHTML = null; // 流式期间禁止复制/下载到上一张卡
  state.currentTitle = '';
  setGenerating(true);
  showState('loading');
  els.loadingProgress.textContent = '';
  els.streamBadgeText.textContent = '生成中…';

  // Scroll to top after all DOM changes have settled
  if (isMobile()) {
    forceScrollTop();
    requestAnimationFrame(forceScrollTop);
    setTimeout(forceScrollTop, 100);
    setTimeout(forceScrollTop, 400);
  }

  const startTime = Date.now();
  const streamRenderer = createStreamRenderer();

  const generateOptions = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    model: settings.model,
    userContent: input,
    systemPrompt: CARD_SYSTEM_PROMPT,
    baseUrl: settings.baseUrl || undefined,
    onChunk(text) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const progress = `已接收 ${text.length} 字符 · ${elapsed}s`;
      els.loadingProgress.textContent = progress;
      els.streamBadgeText.textContent = `生成中 · ${progress}`;
      streamRenderer.update(text);
    },
    onComplete(html) {
      streamRenderer.finish();
      state.currentHTML = html;
      // 流式渲染已展示过卡片时用 instant 模式做权威渲染，避免闪屏
      const title = renderToIframe(html, { instant: streamRenderer.isRevealed() });
      state.currentTitle = title;
      showState('preview');
      setGenerating(false);
      const historyResult = MOCK_STREAM ? { saved: true } : addHistory(input, html, title);
      if (historyResult?.saved === false) {
        const message = historyResult.reason === 'too_large'
          ? '卡片过大，未写入历史记录'
          : '历史记录空间不足，未写入本次卡片';
        showToast(message, 'info');
      }
      if (isMobile()) {
        switchTab('preview');
      }
      showToast('信息卡生成完成！');
    },
    onError(error) {
      streamRenderer.finish();
      setGenerating(false);

      if (previousCard) {
        state.currentHTML = previousCard.html;
        state.currentTitle = previousCard.title;
        state.lastInput = previousCard.input;
        renderToIframe(previousCard.html, { instant: false });
        showState('preview');
      } else {
        showState('empty');
      }

      let errorMsg = '生成失败：';
      if (error.message?.includes('API Key') || error.message?.includes('API key') || error.message?.includes('401')) {
        errorMsg += 'API Key 无效，请检查设置';
      } else if (error.message?.includes('quota') || error.message?.includes('429')) {
        errorMsg += 'API 配额不足或请求过于频繁';
      } else if (error.message?.includes('network') || error.message?.includes('Failed to fetch')) {
        errorMsg += '网络连接失败（请检查网络、Base URL 或 CORS 配置）';
      } else {
        errorMsg += error.message || '未知错误';
      }

      showToast(errorMsg, 'error');
    },
  };

  if (MOCK_STREAM) {
    const { mockStreamCard } = await import('./mock.js');
    await mockStreamCard(generateOptions);
  } else {
    await generateCard(generateOptions);
  }
}

// ============================================
// Export Actions
// ============================================
async function handleCopy() {
  if (!state.currentHTML) return;
  if (els.btnCopy.disabled) return;

  const label = els.btnCopy.querySelector('.btn-label');
  els.btnCopy.disabled = true;
  try {
    label.textContent = '复制中...';
    await copyToClipboard(els.previewFrame);

    // 短暂显示成功状态
    label.textContent = '已复制 ✓';
    showToast('已复制到剪贴板');
    setTimeout(() => {
      label.textContent = '复制';
    }, 1500);
  } catch (error) {
    label.textContent = '复制';
    showToast(`复制失败：${error.message}`, 'error');
  } finally {
    els.btnCopy.disabled = false;
  }
}

async function handleDownload() {
  if (!state.currentHTML) return;
  if (els.btnDownload.disabled) return;

  const label = els.btnDownload.querySelector('.btn-label');
  els.btnDownload.disabled = true;
  try {
    label.textContent = '导出中...';
    await downloadImage(els.previewFrame, state.currentTitle);
    label.textContent = '下载';
    showToast('图片已开始下载');
  } catch (error) {
    label.textContent = '下载';
    showToast(`下载失败：${error.message}`, 'error');
  } finally {
    els.btnDownload.disabled = false;
  }
}

function handleRegenerate() {
  if (state.lastInput) {
    els.inputText.value = state.lastInput;
    handleGenerate();
  }
}

// ============================================
// Settings Modal
// ============================================
function resetTestStatus() {
  state.lastTestResult = null;
  state.testedApiKey = null;
  els.apiTestStatus.textContent = '';
  els.apiTestStatus.className = 'api-test-status';
}

function syncProviderUI(provider) {
  const isGemini = provider === 'gemini';
  els.openaiPresets.style.display = isGemini ? 'none' : 'flex';

  if (isGemini) {
    els.baseUrlLabel.textContent = 'API Base URL（可选）';
    els.baseUrlHint.textContent = '如需使用代理，可修改此地址。留空使用默认地址。';
    els.baseUrlInput.placeholder = 'https://generativelanguage.googleapis.com';
    els.apiKeyLabel.textContent = 'Gemini API Key';
    els.apiKeyHint.innerHTML = '从 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> 获取你的 API Key';
    els.apiKeyInput.placeholder = '输入你的 Gemini API Key...';
    els.modelCustomInput.placeholder = '输入自定义模型 ID，例如 gemini-2.5-flash';
  } else {
    els.baseUrlLabel.textContent = 'API Base URL';
    els.baseUrlHint.textContent = '支持任意 OpenAI 兼容接口地址，留空默认使用 https://api.openai.com/v1。';
    els.baseUrlInput.placeholder = 'https://api.deepseek.com/v1';
    els.apiKeyLabel.textContent = 'API Key';
    els.apiKeyHint.textContent = '仅保存在当前浏览器本地，直接请求你配置的接口。';
    els.apiKeyInput.placeholder = '输入你的 API Key（如 sk-...）';
    els.modelCustomInput.placeholder = '输入自定义模型 ID，例如 deepseek-chat';
  }
}

function syncCustomModelVisibility() {
  const isCustom = els.modelSelect.value === CUSTOM_MODEL_VALUE;
  els.modelCustomInput.style.display = isCustom ? 'block' : 'none';
}

function getSelectedModelValue() {
  if (els.modelSelect.value === CUSTOM_MODEL_VALUE) {
    return els.modelCustomInput.value.trim();
  }
  return els.modelSelect.value;
}

function showSettingsModal() {
  const settings = getSettings();
  els.providerSelect.value = settings.provider;
  syncProviderUI(settings.provider);
  els.apiKeyInput.value = settings.apiKey;
  els.baseUrlInput.value = settings.baseUrl;
  resetTestStatus();
  els.settingsModal.style.display = 'flex';

  // Seed the select with the saved model so it survives even when the
  // model list can't be fetched (no cache + network failure). Otherwise
  // saving settings would silently reset the model to the default.
  renderModelOptions(buildInitialModelOptions(settings.provider, settings.model), settings.model, settings.provider);

  // If we have a key, try to load models and restore selection
  if (settings.apiKey) {
    loadModelsAndRestore(settings);
  }
}

function buildInitialModelOptions(provider, savedModel) {
  const defaults = PROVIDER_DEFAULTS[provider]?.defaultModels || PROVIDER_DEFAULTS.openai.defaultModels;
  const options = defaults.map(m => ({ ...m }));
  if (savedModel && !options.some(m => m.id === savedModel)) {
    options.unshift({ id: savedModel, name: `${savedModel}（当前）` });
  }
  return options;
}

async function loadModelsAndRestore(settings) {
  // Try loading cached models first for faster display
  const cached = getCachedModels(settings.provider, settings.baseUrl);
  if (cached && cached.length > 0) {
    renderModelOptions(cached, settings.model, settings.provider);
    els.modelHint.textContent = `已加载 ${cached.length} 个模型（缓存）`;
  }
  // Then fetch fresh in background
  await handleRefreshModels(true);
}

function hideSettingsModal() {
  els.settingsModal.style.display = 'none';
}

function handleSaveSettings() {
  const provider = els.providerSelect.value;
  const apiKey = els.apiKeyInput.value.trim();
  const model = getSelectedModelValue();
  const baseUrl = els.baseUrlInput.value.trim();

  if (!apiKey) {
    showToast('请输入 API Key', 'error');
    els.apiKeyInput.focus();
    return;
  }

  if (!model) {
    showToast('请选择或输入模型名称', 'error');
    if (els.modelSelect.value === CUSTOM_MODEL_VALUE) {
      els.modelCustomInput.focus();
    }
    return;
  }

  // If the current key was tested and failed, warn the user
  if (state.lastTestResult === false && state.testedApiKey === `${provider}|${baseUrl}|${apiKey}`) {
    if (!confirm('API 连接测试失败，确定要保存吗？')) {
      return;
    }
  }

  saveSettings({ provider, apiKey, model, baseUrl });
  hideSettingsModal();
  showToast('设置已保存');
}

function toggleKeyVisibility() {
  const input = els.apiKeyInput;
  input.type = input.type === 'password' ? 'text' : 'password';
}

// ============================================
// API Test
// ============================================
async function handleTestConnection() {
  const provider = els.providerSelect.value;
  const apiKey = els.apiKeyInput.value.trim();
  const baseUrl = els.baseUrlInput.value.trim();

  if (!apiKey) {
    showToast('请先输入 API Key', 'error');
    els.apiKeyInput.focus();
    return;
  }

  // Show loading state
  const btnText = els.btnTestApi.querySelector('span');
  btnText.textContent = '测试中...';
  els.btnTestApi.disabled = true;
  els.apiTestStatus.textContent = '正在连接...';
  els.apiTestStatus.className = 'api-test-status status-loading';

  const result = await testConnection(apiKey, baseUrl || undefined, provider);

  // Record the test result
  state.lastTestResult = result.success;
  state.testedApiKey = `${provider}|${baseUrl}|${apiKey}`;

  // Show result
  btnText.textContent = '测试连接';
  els.btnTestApi.disabled = false;
  els.apiTestStatus.textContent = result.message;
  els.apiTestStatus.className = `api-test-status ${result.success ? 'status-success' : 'status-error'}`;

  // If success, also refresh models
  if (result.success) {
    handleRefreshModels(true);
  }
}

// ============================================
// Dynamic Model List
// ============================================
function getModelsCacheKey(provider, baseUrl) {
  return `flashsnap_models_cache_${provider}_${(baseUrl || 'default').trim().toLowerCase()}`;
}

function getCachedModels(provider, baseUrl) {
  try {
    const data = JSON.parse(localStorage.getItem(getModelsCacheKey(provider, baseUrl)) || 'null');
    if (data && data.models && Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
      return data.models;
    }
  } catch { }
  return null;
}

function setCachedModels(provider, baseUrl, models) {
  try {
    localStorage.setItem(getModelsCacheKey(provider, baseUrl), JSON.stringify({
      models,
      timestamp: Date.now(),
    }));
  } catch { }
}

function renderModelOptions(models, selectedModel, provider = 'openai') {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const list = Array.isArray(models) ? [...models] : [];
  if (selectedModel && !list.some(m => m.id === selectedModel)) {
    list.unshift({ id: selectedModel, name: `${selectedModel}（当前）` });
  }

  let html = '';

  if (provider === 'gemini') {
    const flash = list.filter(m => m.id.includes('flash'));
    const pro = list.filter(m => m.id.includes('pro'));
    const others = list.filter(m => !m.id.includes('flash') && !m.id.includes('pro'));

    if (flash.length > 0) {
      html += '<optgroup label="⚡ Flash 系列">';
      flash.forEach(m => {
        html += `<option value="${esc(m.id)}">${esc(m.name)}</option>`;
      });
      html += '</optgroup>';
    }

    if (pro.length > 0) {
      html += '<optgroup label="💎 Pro 系列">';
      pro.forEach(m => {
        html += `<option value="${esc(m.id)}">${esc(m.name)}</option>`;
      });
      html += '</optgroup>';
    }

    if (others.length > 0) {
      html += '<optgroup label="🔧 其他">';
      others.forEach(m => {
        html += `<option value="${esc(m.id)}">${esc(m.name)}</option>`;
      });
      html += '</optgroup>';
    }
  } else {
    list.forEach(m => {
      html += `<option value="${esc(m.id)}">${esc(m.name)}</option>`;
    });
  }

  html += `<option value="${CUSTOM_MODEL_VALUE}">✏️ 自定义模型...</option>`;
  els.modelSelect.innerHTML = html;

  // Restore selection
  if (selectedModel) {
    const optionExists = [...els.modelSelect.options].some(o => o.value === selectedModel);
    if (optionExists) {
      els.modelSelect.value = selectedModel;
    }
  }
  syncCustomModelVisibility();
}

async function handleRefreshModels(silent = false) {
  const provider = els.providerSelect.value;
  const apiKey = els.apiKeyInput.value.trim();
  const baseUrl = els.baseUrlInput.value.trim();

  if (!apiKey) {
    if (!silent) showToast('请先输入 API Key', 'error');
    return;
  }

  // Show loading
  els.btnRefreshModels.classList.add('spinning');
  els.modelSelect.classList.add('loading');
  els.modelHint.textContent = '正在获取模型列表...';

  const currentModel = getSelectedModelValue() || getSettings().model;
  const result = await fetchModels(apiKey, baseUrl || undefined, provider);

  els.btnRefreshModels.classList.remove('spinning');
  els.modelSelect.classList.remove('loading');

  if (result.success && result.models.length > 0) {
    setCachedModels(provider, baseUrl, result.models);
    renderModelOptions(result.models, currentModel, provider);
    els.modelHint.textContent = `已加载 ${result.models.length} 个可用模型`;
    if (!silent) showToast(`已获取 ${result.models.length} 个模型`);
  } else {
    els.modelHint.textContent = `${result.message || '获取失败'}，也可选择「自定义模型」手动输入`;
    if (!silent) showToast(result.message || '获取模型列表失败', 'error');
  }
}

// ============================================
// History Modal
// ============================================
function showHistoryModal() {
  renderHistoryList();
  els.historyModal.style.display = 'flex';
}

function hideHistoryModal() {
  els.historyModal.style.display = 'none';
}

function formatHistoryTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return `今天 ${clock}`;
  if (sameDay(date, yesterday)) return `昨天 ${clock}`;
  const md = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return date.getFullYear() === today.getFullYear()
    ? `${md} ${clock}`
    : `${date.getFullYear()} 年 ${md} ${clock}`;
}

function renderHistoryList() {
  const history = getHistory();

  if (history.length === 0) {
    els.historyList.innerHTML = '<p class="empty-desc">暂无历史记录</p>';
    return;
  }

  els.historyList.innerHTML = history.map(item => {
    const timeStr = formatHistoryTime(item.time);
    const titleHtml = item.title
      ? `<div class="history-item-title">${escapeHTML(item.title)}</div>`
      : '';

    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-item-content">
          ${titleHtml}
          <div class="history-item-text">${escapeHTML(item.input)}</div>
          <div class="history-item-time">${timeStr}</div>
        </div>
        <button class="history-item-delete" data-delete-id="${item.id}" title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    `;
  }).join('');

  // Bind events
  els.historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.history-item-delete')) return;

      const id = parseInt(item.dataset.id);
      const entry = history.find(h => h.id === id);
      if (entry) {
        state.currentHTML = entry.html;
        state.lastInput = entry.input;
        els.inputText.value = entry.input;
        syncCharCount();
        const title = renderToIframe(entry.html);
        state.currentTitle = entry.title || title;
        showState('preview');
        hideHistoryModal();
        if (isMobile()) switchTab('preview');
        showToast('已加载历史记录');
      }
    });
  });

  els.historyList.querySelectorAll('.history-item-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.deleteId);
      const removed = deleteHistoryItem(id);
      renderHistoryList();
      if (removed) {
        showToast('已删除', 'info', {
          duration: 5000,
          action: {
            label: '撤销',
            onClick: () => {
              restoreHistoryItem(removed.item, removed.index);
              renderHistoryList();
              showToast('已恢复历史记录');
            },
          },
        });
      }
    });
  });
}

function handleClearHistory() {
  if (confirm('确定要清空所有历史记录吗？')) {
    clearHistory();

    // 重置应用状态
    state.currentHTML = null;
    state.currentTitle = '';
    state.lastInput = '';

    // 清空输入框
    els.inputText.value = '';
    els.charCount.textContent = '0 字';

    // 回到空状态
    showState('empty');

    // 关闭弹窗
    hideHistoryModal();

    showToast('历史记录已清空');
  }
}

// ============================================
// Utilities
// ============================================
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function forceScrollTop() {
  // Primary: scrollIntoView on the visible panel header (more resilient than scrollTo)
  const header = document.querySelector('.panel-preview:not(.panel-hidden) .panel-header')
    || document.querySelector('.panel-input:not(.panel-hidden) .panel-header');
  if (header) {
    header.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  // Fallback: force all scroll containers to 0
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (document.body) document.body.scrollTop = 0;
  if (document.documentElement) document.documentElement.scrollTop = 0;
}

function initAnalytics() {
  const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID;
  if (!websiteId) return;

  const script = document.createElement('script');
  script.defer = true;
  script.src = 'https://umami.dengshu.ovh/script.js';
  script.dataset.websiteId = websiteId;
  document.head.appendChild(script);
}

// ============================================
// Event Bindings
// ============================================
function init() {
  // Character count
  els.inputText.addEventListener('input', () => {
    syncCharCount();
  });

  // Generate
  els.btnGenerate.addEventListener('click', handleGenerate);

  // Keyboard shortcut: Ctrl/Cmd + Enter to generate
  els.inputText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleGenerate();
    }
  });

  // Clear input
  els.btnClear.addEventListener('click', () => {
    els.inputText.value = '';
    els.charCount.textContent = '0 字';
    els.inputText.focus();
  });

  // Export actions
  els.btnCopy.addEventListener('click', handleCopy);
  els.btnDownload.addEventListener('click', handleDownload);

  els.btnRegenerate.addEventListener('click', handleRegenerate);



  // Settings
  els.btnSettings.addEventListener('click', showSettingsModal);
  els.btnCloseSettings.addEventListener('click', hideSettingsModal);
  els.btnSaveSettings.addEventListener('click', handleSaveSettings);
  els.btnToggleKey.addEventListener('click', toggleKeyVisibility);
  els.btnTestApi.addEventListener('click', handleTestConnection);
  els.btnRefreshModels.addEventListener('click', () => handleRefreshModels(false));

  // Switch provider
  els.providerSelect.addEventListener('change', () => {
    const provider = els.providerSelect.value;
    syncProviderUI(provider);
    resetTestStatus();

    const defaults = PROVIDER_DEFAULTS[provider];
    if (provider === 'gemini') {
      if (els.baseUrlInput.value.trim() === PROVIDER_DEFAULTS.openai.baseUrl ||
        Object.values(OPENAI_PRESETS).some(p => p.baseUrl === els.baseUrlInput.value.trim())) {
        els.baseUrlInput.value = '';
      }
    } else if (!els.baseUrlInput.value.trim()) {
      els.baseUrlInput.value = defaults.baseUrl;
    }

    const cached = getCachedModels(provider, els.baseUrlInput.value.trim());
    const models = cached && cached.length > 0 ? cached : buildInitialModelOptions(provider, defaults.model);
    renderModelOptions(models, defaults.model, provider);
    els.modelHint.textContent = cached && cached.length > 0
      ? `已加载 ${cached.length} 个模型（缓存）`
      : '可从接口拉取列表，也可选择「自定义模型」手动填写';
  });

  // OpenAI preset quick-fill buttons
  els.openaiPresets.querySelectorAll('.preset-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = OPENAI_PRESETS[btn.dataset.preset];
      if (!preset) return;
      els.providerSelect.value = 'openai';
      syncProviderUI('openai');
      els.baseUrlInput.value = preset.baseUrl;
      resetTestStatus();

      const cached = getCachedModels('openai', preset.baseUrl);
      const models = cached && cached.length > 0 ? cached : buildInitialModelOptions('openai', preset.model);
      renderModelOptions(models, preset.model, 'openai');
      els.modelHint.textContent = `已填充 ${btn.textContent} 默认配置`;
    });
  });

  // Model select custom input toggle
  els.modelSelect.addEventListener('change', () => {
    syncCustomModelVisibility();
    if (els.modelSelect.value === CUSTOM_MODEL_VALUE) {
      els.modelCustomInput.focus();
    }
  });

  // Reset test status when API key or Base URL changes
  els.apiKeyInput.addEventListener('input', resetTestStatus);
  els.baseUrlInput.addEventListener('input', resetTestStatus);

  // History
  els.btnHistory.addEventListener('click', showHistoryModal);
  els.btnCloseHistory.addEventListener('click', hideHistoryModal);
  els.btnClearHistory.addEventListener('click', handleClearHistory);

  // Close modals on overlay click
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) hideSettingsModal();
  });
  els.historyModal.addEventListener('click', (e) => {
    if (e.target === els.historyModal) hideHistoryModal();
  });

  // Close modals on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSettingsModal();
      hideHistoryModal();
    }
  });

  // --- Mobile Tab Switching ---
  els.tabInput.addEventListener('click', () => switchTab('input'));
  els.tabPreview.addEventListener('click', () => switchTab('preview'));

  // Initialize mobile layout
  initMobileTabs();

  // Re-initialize only on breakpoint crossing (not on every resize).
  // iOS keyboard show/hide triggers resize, which would reset the active tab
  // back to "input" every time the user dismisses the keyboard on the preview tab.
  let wasMobile = isMobile();
  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if (nowMobile !== wasMobile) {
      wasMobile = nowMobile;
      initMobileTabs();
    }
  });

  // Check if API key is configured, show settings if not
  const settings = getSettings();
  if (!settings.apiKey) {
    // Show a gentle reminder after a short delay
    setTimeout(() => {
      showToast('欢迎使用 FlashSnap！请先配置 API Key', 'info');
    }, 500);
  }

  // Focus input (only on desktop)
  if (!isMobile()) {
    els.inputText.focus();
  }

  // --- Theme ---
  initTheme(els.btnTheme);
  initAnalytics();

  // 空闲时预热按需加载的大依赖、默认字体样式表与常驻预览 iframe 壳，
  // 首屏零阻塞，首次生成与复制也能明显提速。
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  idle(() => {
    if (settings.provider === 'gemini') {
      import('@google/genai').catch(() => { });
    }
    import('html-to-image').catch(() => { });
    prewarmDefaultFonts();
    try {
      ensurePreviewShell(els.previewFrame);
    } catch {
      // ignore
    }
  });
}

// Boot
init();
