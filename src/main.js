/**
 * FlashSnap — 主逻辑
 */

import { generateCard, testConnection, fetchModels } from './api.js';
import { copyToClipboard } from './export.js';
import { CARD_SYSTEM_PROMPT } from './prompts.js';

// ============================================
// State
// ============================================
const state = {
  isGenerating: false,
  currentHTML: null,
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

  btnRegenerate: $('#btn-regenerate'),
  btnSettings: $('#btn-settings'),
  btnHistory: $('#btn-history'),
  previewFrame: $('#preview-frame'),
  previewActions: $('#preview-actions'),
  previewContainer: $('#preview-container'),
  emptyState: $('#empty-state'),
  loadingState: $('#loading-state'),
  loadingProgress: $('#loading-progress'),

  // Settings modal
  settingsModal: $('#settings-modal'),
  btnCloseSettings: $('#btn-close-settings'),
  btnSaveSettings: $('#btn-save-settings'),
  apiKeyInput: $('#api-key-input'),
  modelSelect: $('#model-select'),
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

};

// ============================================
// Settings / Storage
// ============================================
function getSettings() {
  return {
    apiKey: localStorage.getItem('flashsnap_api_key') || '',
    model: localStorage.getItem('flashsnap_model') || 'gemini-2.5-flash',
    baseUrl: localStorage.getItem('flashsnap_base_url') || '',
  };
}

function saveSettings(settings) {
  if (settings.apiKey) localStorage.setItem('flashsnap_api_key', settings.apiKey);
  if (settings.model) localStorage.setItem('flashsnap_model', settings.model);
  if (settings.baseUrl !== undefined) localStorage.setItem('flashsnap_base_url', settings.baseUrl);
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem('flashsnap_history') || '[]');
  } catch {
    return [];
  }
}

function addHistory(input, html) {
  const history = getHistory();
  history.unshift({
    id: Date.now(),
    input: input.slice(0, 100),
    html,
    time: new Date().toISOString(),
  });
  // Keep only last 20
  if (history.length > 20) history.length = 20;
  try {
    localStorage.setItem('flashsnap_history', JSON.stringify(history));
  } catch (e) {
    // localStorage quota exceeded — drop oldest entries and retry
    console.warn('[FlashSnap] localStorage quota exceeded, trimming history');
    history.length = Math.max(1, Math.floor(history.length / 2));
    try {
      localStorage.setItem('flashsnap_history', JSON.stringify(history));
    } catch { /* give up silently */ }
  }
}

function clearHistory() {
  localStorage.removeItem('flashsnap_history');
}

// ============================================
// Toast
// ============================================
function showToast(message, type = 'success') {
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
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 300ms ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================
// UI State Management
// ============================================
function showState(stateName) {
  els.emptyState.style.display = stateName === 'empty' ? 'block' : 'none';
  els.loadingState.style.display = stateName === 'loading' ? 'block' : 'none';
  els.previewFrame.style.display = stateName === 'preview' ? 'block' : 'none';
  els.previewActions.style.display = stateName === 'preview' ? 'flex' : 'none';
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

function switchTab(tabName) {
  // Update tab buttons
  els.tabInput.classList.toggle('active', tabName === 'input');
  els.tabPreview.classList.toggle('active', tabName === 'preview');

  // Switch panels
  els.panelInput.classList.toggle('panel-hidden', tabName !== 'input');
  els.panelPreview.classList.toggle('panel-hidden', tabName !== 'preview');

  // Clear notification dot when switching to preview
  if (tabName === 'preview') {
    els.tabPreview.classList.remove('has-content');
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

/**
 * 将 HTML 内容写入 iframe 并自适应高度
 */
function renderToIframe(html) {
  const iframe = els.previewFrame;
  const container = els.previewContainer;

  // Reset transform before measuring
  iframe.style.transform = 'none';
  iframe.style.transformOrigin = 'top left';
  iframe.style.width = '900px';
  iframe.style.maxWidth = 'none';
  iframe.style.height = 'auto';

  const doc = iframe.contentDocument || iframe.contentWindow.document;

  doc.open();
  doc.write(html);
  doc.close();

  // Auto-resize iframe to fit content, then scale to fit container
  const resizeIframe = () => {
    try {
      const body = doc.body;
      const htmlEl = doc.documentElement;
      if (body && htmlEl) {
        // Read the card's natural dimensions at full width
        const cardEl = body.querySelector('.card') || body.firstElementChild;
        const cardWidth = cardEl ? Math.max(cardEl.scrollWidth, cardEl.offsetWidth, 900) : 900;

        // Set iframe to card's natural size
        iframe.style.width = cardWidth + 'px';

        const height = Math.max(
          body.scrollHeight, body.offsetHeight,
          htmlEl.clientHeight, htmlEl.scrollHeight, htmlEl.offsetHeight
        );
        iframe.style.height = height + 'px';

        // Scale down to fit the preview container if needed
        const containerWidth = container.clientWidth - 48; // subtract padding
        if (containerWidth > 0 && containerWidth < cardWidth) {
          const scale = containerWidth / cardWidth;
          iframe.style.transform = `scale(${scale})`;
          iframe.style.transformOrigin = 'top left';
          // transform:scale doesn't affect layout flow, so we must collapse the
          // extra space manually. Use a wrapper approach via marginBottom so the
          // element following the iframe sees the correct visual height.
          // Visual height after scale = height * scale
          // Extra dead space = height * (1 - scale)  →  collapse with negative margin
          iframe.style.marginBottom = `-${Math.ceil(height * (1 - scale))}px`;
          // Also shift horizontally to center the scaled iframe within the container
          const scaledWidth = cardWidth * scale;
          const leftOffset = (containerWidth - scaledWidth) / 2;
          iframe.style.marginLeft = `${Math.max(0, leftOffset)}px`;
        } else {
          iframe.style.transform = 'none';
          iframe.style.marginBottom = '0';
          iframe.style.marginLeft = '0';
        }
      }
    } catch (e) {
      // Cross-origin restrictions, ignore
    }
  };

  // Wait for content + fonts, then resize
  iframe.onload = resizeIframe;
  setTimeout(resizeIframe, 300);
  setTimeout(resizeIframe, 1000);
  setTimeout(resizeIframe, 2500);
}

// ============================================
// Core: Generate Card
// ============================================
async function handleGenerate() {
  const input = els.inputText.value.trim();

  if (!input) {
    showToast('请输入要生成信息卡的内容', 'error');
    els.inputText.focus();
    return;
  }

  const settings = getSettings();
  if (!settings.apiKey) {
    showToast('请先在设置中配置 API Key', 'error');
    showSettingsModal();
    return;
  }

  state.lastInput = input;
  setGenerating(true);
  showState('loading');
  els.loadingProgress.textContent = '';

  let chunkCount = 0;

  await generateCard({
    apiKey: settings.apiKey,
    model: settings.model,
    userContent: input,
    systemPrompt: CARD_SYSTEM_PROMPT,
    baseUrl: settings.baseUrl || undefined,
    onChunk(text) {
      chunkCount++;
      els.loadingProgress.textContent = `已接收 ${text.length} 字符...`;
    },
    onComplete(html) {
      state.currentHTML = html;
      renderToIframe(html);
      showState('preview');
      setGenerating(false);
      addHistory(input, html);
      // On mobile, switch to preview & show a dot if not already there
      if (isMobile()) {
        switchTab('preview');
      }
      showToast('信息卡生成完成！');
    },
    onError(error) {
      setGenerating(false);
      showState('empty');

      let errorMsg = '生成失败：';
      if (error.message?.includes('API key')) {
        errorMsg += 'API Key 无效，请检查设置';
      } else if (error.message?.includes('quota')) {
        errorMsg += 'API 配额已用完';
      } else if (error.message?.includes('network') || error.message?.includes('fetch')) {
        errorMsg += '网络连接失败，请检查网络';
      } else {
        errorMsg += error.message || '未知错误';
      }

      showToast(errorMsg, 'error');
    },
  });
}

// ============================================
// Export Actions
// ============================================
async function handleCopy() {
  if (!state.currentHTML) return;

  try {
    els.btnCopy.querySelector('span:last-child').textContent = '复制中...';
    await copyToClipboard(els.previewFrame);
    els.btnCopy.querySelector('span:last-child').textContent = '复制';
    showToast('已复制到剪贴板！');
  } catch (error) {
    els.btnCopy.querySelector('span:last-child').textContent = '复制';
    showToast(`复制失败：${error.message}`, 'error');
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
function showSettingsModal() {
  const settings = getSettings();
  els.apiKeyInput.value = settings.apiKey;
  els.baseUrlInput.value = settings.baseUrl;
  els.apiTestStatus.textContent = '';
  els.apiTestStatus.className = 'api-test-status';
  els.settingsModal.style.display = 'flex';

  // If we have a key, try to load models and restore selection
  if (settings.apiKey) {
    loadModelsAndRestore(settings);
  } else {
    // Reset to default
    els.modelSelect.innerHTML = '<option value="gemini-2.5-flash">Gemini 2.5 Flash（默认）</option>';
  }
}

async function loadModelsAndRestore(settings) {
  // Try loading cached models first for faster display
  const cached = getCachedModels();
  if (cached && cached.length > 0) {
    renderModelOptions(cached, settings.model);
    els.modelHint.textContent = `已加载 ${cached.length} 个模型（缓存）`;
  }
  // Then fetch fresh in background
  await handleRefreshModels(true);
}

function hideSettingsModal() {
  els.settingsModal.style.display = 'none';
}

function handleSaveSettings() {
  const apiKey = els.apiKeyInput.value.trim();
  const model = els.modelSelect.value;
  const baseUrl = els.baseUrlInput.value.trim();

  if (!apiKey) {
    showToast('请输入 API Key', 'error');
    return;
  }

  // If the current key was tested and failed, warn the user
  if (state.lastTestResult === false && state.testedApiKey === apiKey) {
    if (!confirm('API Key 测试失败，确定要保存吗？')) {
      return;
    }
  }

  saveSettings({ apiKey, model, baseUrl });
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

  const result = await testConnection(apiKey, baseUrl || undefined);

  // Record the test result
  state.lastTestResult = result.success;
  state.testedApiKey = apiKey;

  // Show result
  btnText.textContent = '测试连接';
  els.btnTestApi.disabled = false;
  els.apiTestStatus.textContent = result.message;
  els.apiTestStatus.className = `api-test-status ${result.success ? 'status-success' : 'status-error'}`;

  // If success, also refresh models
  if (result.success) {
    handleRefreshModels();
  }
}

// ============================================
// Dynamic Model List
// ============================================
function getCachedModels() {
  try {
    const data = JSON.parse(localStorage.getItem('flashsnap_models_cache') || 'null');
    if (data && data.models && Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
      return data.models;
    }
  } catch { }
  return null;
}

function setCachedModels(models) {
  localStorage.setItem('flashsnap_models_cache', JSON.stringify({
    models,
    timestamp: Date.now(),
  }));
}

function renderModelOptions(models, selectedModel) {
  // Group models by type
  const flash = models.filter(m => m.id.includes('flash'));
  const pro = models.filter(m => m.id.includes('pro'));
  const others = models.filter(m => !m.id.includes('flash') && !m.id.includes('pro'));

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let html = '';

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

  els.modelSelect.innerHTML = html;

  // Restore selection
  if (selectedModel) {
    const optionExists = [...els.modelSelect.options].some(o => o.value === selectedModel);
    if (optionExists) {
      els.modelSelect.value = selectedModel;
    }
  }
}

async function handleRefreshModels(silent = false) {
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

  const currentModel = els.modelSelect.value || getSettings().model;
  const result = await fetchModels(apiKey, baseUrl || undefined);

  els.btnRefreshModels.classList.remove('spinning');
  els.modelSelect.classList.remove('loading');

  if (result.success && result.models.length > 0) {
    setCachedModels(result.models);
    renderModelOptions(result.models, currentModel);
    els.modelHint.textContent = `已加载 ${result.models.length} 个可用模型`;
    if (!silent) showToast(`已获取 ${result.models.length} 个模型`);
  } else {
    els.modelHint.textContent = result.message || '获取失败，使用默认模型';
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

function renderHistoryList() {
  const history = getHistory();

  if (history.length === 0) {
    els.historyList.innerHTML = '<p class="empty-desc">暂无历史记录</p>';
    return;
  }

  els.historyList.innerHTML = history.map(item => {
    const time = new Date(item.time);
    const timeStr = `${time.getMonth() + 1}/${time.getDate()} ${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;

    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-item-content">
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
        renderToIframe(entry.html);
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
      const history = getHistory();
      const filtered = history.filter(h => h.id !== id);
      localStorage.setItem('flashsnap_history', JSON.stringify(filtered));
      renderHistoryList();
      showToast('已删除');
    });
  });
}

function handleClearHistory() {
  if (confirm('确定要清空所有历史记录吗？')) {
    clearHistory();

    // 重置应用状态
    state.currentHTML = null;
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

// ============================================
// Event Bindings
// ============================================
function init() {
  // Character count
  els.inputText.addEventListener('input', () => {
    const len = els.inputText.value.length;
    els.charCount.textContent = `${len} 字`;
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

  els.btnRegenerate.addEventListener('click', handleRegenerate);



  // Settings
  els.btnSettings.addEventListener('click', showSettingsModal);
  els.btnCloseSettings.addEventListener('click', hideSettingsModal);
  els.btnSaveSettings.addEventListener('click', handleSaveSettings);
  els.btnToggleKey.addEventListener('click', toggleKeyVisibility);
  els.btnTestApi.addEventListener('click', handleTestConnection);
  els.btnRefreshModels.addEventListener('click', () => handleRefreshModels(false));

  // Reset test status when API key changes
  els.apiKeyInput.addEventListener('input', () => {
    state.lastTestResult = null;
    state.testedApiKey = null;
    els.apiTestStatus.textContent = '';
    els.apiTestStatus.className = 'api-test-status';
  });

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
}

// Boot
init();
