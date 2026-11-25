# FlashSnap ⚡

纯前端 AI 信息卡生成工具，无需登录，自带 API Key 即开即用。支持 **OpenAI 兼容接口（DeepSeek / OpenAI / OpenRouter / 中转站）** 与 **Google Gemini 原生接口**，输入文字秒生成杂志风格信息卡，一键复制或下载高清 PNG。

## ✨ 功能

- 🎨 **AI 信息卡生成** — 固化杂志社论风单 Prompt，自动将任意文字排版为 900px 信息卡
- 🔌 **多协议自带 Key** — 支持 OpenAI 兼容协议与 Gemini 原生协议，Key 仅存于浏览器 `localStorage`
- 📋 **一键复制 / 下载** — 浏览器端高清 PNG 导出，支持一键复制到剪贴板或下载本地
- ⚡ **流式渲染** — 实时预览 AI 生成进度
- 📜 **本地历史记录** — 卡片记录保存在浏览器本地，随时回看

## 🚀 开发与构建

```bash
npm install
npm run dev
```

> 联调技巧：访问 `/?mock=stream` 可在不配置 API Key 的情况下，用内置样例卡验证流式渲染与导出管线。

```bash
npm run build
```

构建产物位于 `dist/`，为纯静态站点，由 Caddy `spa_site` 直接托管。

## ⚙️ 配置

1. 打开应用，点击右上角 ⚙️ 设置图标
2. 选择接口类型：**OpenAI 兼容**（可一键填充 DeepSeek / OpenAI / OpenRouter）或 **Google Gemini**
3. 填写 API Base URL（可选）、API Key，并选择或手动输入模型名称

## 📄 License

MIT
