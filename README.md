# FlashSnap ⚡

基于 Gemini Flash 的 AI 信息卡生成工具。输入文字，秒生成精美杂志风格信息卡，一键复制到剪贴板。

## ✨ 功能

- 🎨 **AI 信息卡生成** — 输入任意文字，Gemini Flash 自动生成杂志质感 HTML 信息卡
- 📋 **一键复制** — 生成的卡片自动转为高清 PNG，一键复制到剪贴板
- 💾 **下载图片** — 支持下载为 2x 视网膜屏分辨率的 PNG
- ⚡ **流式渲染** — 实时显示 AI 生成进度
- 📜 **历史记录** — 本地保存已生成的卡片，随时回顾
- 🔑 **自带 Key** — 使用你自己的 Gemini API Key，安全私密

## 🚀 快速开始

### 开发模式

```bash
npm install
npm run dev
```

### 生产构建

```bash
npm run build
```

构建产物在 `dist/` 目录。

## ⚙️ 配置

1. 打开应用，点击右上角 ⚙️ 设置图标
2. 输入你的 [Gemini API Key](https://aistudio.google.com/apikey)
3. 选择模型（推荐 Gemini 2.5 Flash）
4. 如需代理，可配置 API Base URL

## 🏗️ 技术栈

- **Vite** — 极速开发与构建
- **@google/genai** — Google 官方 Gemini SDK
- **html-to-image** — HTML 转 PNG 截图
- **Vanilla JS + CSS** — 零框架，纯原生

## 📦 部署

纯静态站点，可部署到任何静态文件托管服务：

```bash
# 构建
npm run build

# 使用 Nginx 托管 dist/ 目录
# 配合 Nginx Proxy Manager + Cloudflare 使用
```

## 📄 License

MIT
