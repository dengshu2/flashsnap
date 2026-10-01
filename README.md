# FlashSnap

把一段文字做成一张信息卡：粘贴新闻、概念、清单、数据或名言，选一种风格，几秒后得到一张适合在手机上看、可以直接转发的图片。自用工具，需要登录。

## 怎么做出一张卡

1. **写**：Gemini 按"基础约定 + 风格"的提示词，直接写出一个完整的 HTML 文档，边写边推给页面，页面在一个禁止脚本的 iframe 里实时预览。
2. **清理**：服务端把 HTML 从回复里取出来，删掉脚本、事件属性、外部链接和外部资源，只留卡片本身。
3. **渲染**：容器里的无头 Chrome 按 600px 宽、2 倍分辨率把卡片截成 PNG，同时生成列表用的缩略图。字体装在容器里，渲染不依赖网络。
4. **检查**：量出卡片的高度、是否横向溢出、最小字号；超出规定就把问题告诉模型，让它改一次，再渲染一次。
5. **保存**：HTML、原文和图片存下来；复制和下载用的都是这张 PNG，所以看到的和拿到的完全一样。

## 提示词和风格

- `internal/prompt/prompts/base.md`：所有风格共用的约定，包括画布（600px 宽，正文 20–22px，最小 15px）、可用字体、不引外部资源、每句话都要在原文里有依据，以及按内容类型选版式。
- `internal/prompt/prompts/styles/*.md`：一个文件一种风格，开头写名称、简介和排序：

  ```
  ---
  name: 杂志
  summary: 暖白纸张、衬线大标题、粗强调线
  order: 1
  ---
  ## 风格：杂志
  ……
  ```

  加一种风格就是加一个文件，重新构建后自动出现在页面上。"自动"会把所有风格交给模型，让它按内容挑一种。
- 可用字体：Noto Sans SC、Noto Serif SC、Inter、Oswald、Playfair Display、JetBrains Mono。要加字体，需要同时改 `base.md`、`Dockerfile`（安装）和 `web/frame.html`（预览用的 Google Fonts）。

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Go 1.26 + [chi](https://github.com/go-chi/chi)，SQLite（[modernc.org/sqlite](https://modernc.org/sqlite)） |
| 模型 | Google Gemini `gemini-3.8-flash`，流式调用 |
| 渲染 | [chromedp](https://github.com/chromedp/chromedp) + `chromedp/headless-shell` |
| 前端 | 原生 HTML / CSS / ES modules，界面用共用设计规范 Quiet UI（`web/assets/css/quiet.css`，复制进来的，不要直接改），`go:embed` 打进二进制 |
| 部署 | Docker Compose，Caddy 反代 |

## 项目结构

```
main.go                 入口；也提供 health 和 user 子命令
internal/
  config/               环境变量
  store/                SQLite：用户、卡片、用量
  auth/                 登录、JWT、鉴权中间件（没有注册页）
  gemini/               Gemini 流式客户端
  prompt/               提示词：base.md + styles/*.md
  cardhtml/             从回复里取 HTML 并清理
  render/               无头 Chrome 渲染 PNG 和缩略图
  usage/                Gemini 计价
  api/                  路由；generate.go 是"写、清理、渲染、检查、保存"的流程
web/
  index.html            首页（输入卡片 + 卡片）、全部卡片、卡片详情、账户，用 hash 切换
  frame.html            实时预览用的文档（单独的 CSP，只允许内联样式和 Google Fonts）
  assets/js/            main（路由）/ home / preview / history / cardpage / cards / account / api / ui
```

## 开发

```bash
cp .env.example .env    # 填 JWT_SECRET 和 GEMINI_API_KEY
CHROME_PATH=$(which google-chrome) go run .
go run . user add you@example.com   # 按提示输入密码
```

```bash
gofmt -l . && go vet ./... && go test ./...
```

渲染测试需要 Chrome，没设 `CHROME_PATH` 时会跳过。可以在镜像里跑：先 `go test -c -o render.test ./internal/render`，再用 `docker run --rm -v "$PWD/render.test:/t" --entrypoint /t <镜像>` 执行。

## 部署

```bash
docker compose up -d --build
docker exec -i flashsnap /app/flashsnap user add you@example.com    # 首次：创建账号
```

数据库和图片都在 `./data`（容器内 `/app/data`）。容器所在网络必须只有 IPv4，因为 Google 会拒绝这台服务器的 IPv6 地址段。

已有 bcrypt 密码哈希时，可以用 `flashsnap user import <email> <hash>` 直接导入。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | 是 | — | `openssl rand -hex 32` |
| `GEMINI_API_KEY` | 是 | — | Google AI Studio 的 API Key |
| `GEMINI_MODEL` | — | `gemini-3.8-flash` | |
| `RENDER_CONCURRENCY` | — | `2` | 同时渲染的卡片数 |
| `UMAMI_WEBSITE_ID` | — | 空 | 填了才注入统计脚本 |
| `PORT` / `DATA_DIR` / `CHROME_PATH` | — | `8080` / `./data` / 镜像里已设好 | |

## API

除 `/health`、`/img/*` 和登录外，都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/api/styles` | 风格列表，"自动"在最前 |
| POST | `/api/cards` | `{text, style}` → 事件流：`stage`（writing / rendering / fixing）、`delta`（HTML 片段）、`done`（卡片）、`error` |
| GET | `/api/cards?q=&limit=&offset=` | 卡片列表 |
| GET / DELETE | `/api/cards/{id}` | 一张卡片（含 HTML）/ 删除 |
| GET | `/img/{id}.png`、`/img/{id}.jpg` | 卡片图片和缩略图；`?download=1` 下载。ID 是 128 位随机值，不需要登录 |
| GET | `/api/usage?days=30` | 调用次数、token 和费用 |
