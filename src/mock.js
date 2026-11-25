/**
 * FlashSnap — Mock 流式输出（联调用，?mock=stream 启用）
 *
 * 无需 API Key，用内置样例卡模拟 Gemini 流式返回。刻意覆盖最复杂的
 * 输出形态：前置分析文字 + ```html 围栏 + 围栏后的结尾说明，
 * 用于验证流式渲染状态机的起点识别与终点截断。
 */

const SAMPLE_CARD = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@700;900&family=Noto+Sans+SC:wght@400;500;700&family=Oswald:wght@500;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  .card { width: 900px; background: #f5f3ed; padding: 50px; font-family: 'Noto Sans SC', sans-serif; color: #1a1a1a; display: flex; flex-direction: column; gap: 28px; }
  .meta { font-size: 13px; letter-spacing: 0.15em; font-weight: 700; text-transform: uppercase; color: #b3541e; }
  .main-title { font-family: 'Noto Serif SC', serif; font-size: 76px; font-weight: 900; line-height: 1.05; letter-spacing: -0.02em; color: #0a0a0a; }
  .accent-bar { height: 6px; width: 110px; background: #b3541e; }
  .lede { font-size: 20px; line-height: 1.6; color: #333; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; border-top: 4px solid #0a0a0a; padding-top: 28px; }
  .col h3 { font-family: 'Oswald', 'Noto Sans SC', sans-serif; font-size: 26px; margin-bottom: 12px; }
  .col p { font-size: 18px; line-height: 1.65; }
  .stats { display: flex; gap: 40px; background: rgba(0,0,0,0.04); padding: 26px 30px; }
  .stat b { display: block; font-family: 'Oswald', sans-serif; font-size: 44px; color: #b3541e; }
  .stat span { font-size: 15px; color: #555; }
  .footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(0,0,0,0.2); padding-top: 18px; font-size: 13px; color: #777; }
  .tags span { white-space: nowrap; border: 1px solid #0a0a0a; padding: 4px 10px; margin-left: 8px; font-weight: 700; color: #0a0a0a; }
</style>
</head>
<body>
<div class="card">
  <div class="meta">FlashSnap · Mock Stream · 联调样例</div>
  <h1 class="main-title">流式渲染<br>让等待变成观看</h1>
  <div class="accent-bar"></div>
  <p class="lede">这张卡片由内置 mock 流逐段写入 iframe，用于验证增量 document.write 渲染管线：围栏剥离、样式就绪后再展示、高度实时跟随，以及完成后的权威渲染。</p>
  <div class="grid">
    <div class="col"><h3>为什么是增量写入</h3><p>浏览器解析器天生为流式 HTML 设计：已渲染部分保持不动，新内容在尾部追加，无需整页重排，也就没有闪烁。</p></div>
    <div class="col"><h3>安全网在哪里</h3><p>流式渲染只是观感层。生成完成后仍会走完整的提取、校验与最终渲染路径，复制和下载的结果与非流式完全一致。</p></div>
  </div>
  <div class="stats">
    <div class="stat"><b>13.7KB</b><span>首屏 JS（原 303KB）</span></div>
    <div class="stat"><b>~90ms</b><span>模拟片间隔</span></div>
    <div class="stat"><b>0</b><span>API 消耗</span></div>
  </div>
  <div class="footer"><span>方案 B 验证 · 增量 document.write</span><div class="tags"><span>STREAMING</span><span>MOCK</span></div></div>
</div>
</body>
</html>`;

/**
 * 与 generateCard 同签名的回调驱动接口（多余字段被忽略）
 */
export function mockStreamCard({ onChunk, onComplete }) {
  const raw =
    '好的，这是为您设计的信息卡，采用杂志风排版：\n\n```html\n' +
    SAMPLE_CARD +
    '\n```\n\n希望您喜欢这个设计！';

  return new Promise((resolve) => {
    let pos = 0;
    let acc = '';
    const timer = setInterval(() => {
      const step = 60 + Math.floor(Math.random() * 140);
      acc += raw.slice(pos, pos + step);
      pos += step;
      onChunk?.(acc);
      if (pos >= raw.length) {
        clearInterval(timer);
        onComplete?.(SAMPLE_CARD);
        resolve();
      }
    }, 90);
  });
}
