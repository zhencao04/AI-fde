# 观察型 AI 工作流定制 Agent

本项目把 HTML 源文件中描述的产品理念——**"让 AI 先观察工作，再定制真正合身的 Agent"**——落地为一个可以运行的 Node.js 工程。

## 目录

- [产品理念](#产品理念)
- [架构概览](#架构概览)
- [安全与边界](#安全与边界)
- [快速启动](#快速启动)
- [Docker 部署](#docker-部署)
- [本地演示](#本地演示)

## 产品理念

系统接收一段"屏幕行为"，从中识别：
1. **观察到的工作模式**（跨应用的重复操作）；
2. **AI 替代潜力评分**（自动化潜力、集成难度、风险、业务价值）；
3. **工作流蓝图 + Agent 规格**（直接复制到 AI 编程工具的提示词素材包）。

默认提供**确定性、不访问真实屏幕**的演示数据，用户可先感受完整链路，再决定是否接入真实录屏数据源。

## 架构概览

```
┌───────────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────┐
│ Observation Layer         │  │ Understanding Layer       │  │ Build Layer               │
│ 屏幕/键鼠事件采样         │  │ 任务聚类                  │  │ 工作流蓝图                │
│ 应用识别 & 敏感区域遮挡   │  │ 可解释评分模型            │  │ Agent 角色与权限白名单    │
│ AES-256-GCM 本地加密      │  │ 机会优先级排序            │  │ 提示词素材包              │
└───────────────────────────┘  └───────────────────────────┘  └───────────────────────────┘
                                    │ orchestrator 编排
                                    ▼
                          HTTP / JSON API Server
```

代码位置：
- 观察层：`src/layers/observation.ts`、`src/layers/observation-demo.ts`
- 理解层：`src/layers/understanding.ts`
- 生成层：`src/layers/build.ts`
- 编排器：`src/layers/orchestrator.ts`
- 安全层：`src/security/vault.ts`、`src/security/redactor.ts`、`src/security/storage.ts`
- HTTP 服务器与前端：`src/server/index.ts`

## 安全与边界

1. **密钥仅在请求生命周期内存活**：sessionKey 在最后都会被 `disposeSessionKey()` 清零。
2. **AES-256-GCM 认证加密**：写入磁盘的事件全部先加密，错误密码或篡改记录无法解码。
3. **敏感信息过滤**：身份证、手机号、邮箱、银行卡、token/password 字段、`密码:` 前缀等都会被自动替换为 `[REDACTED]`。
4. **应用白名单 + 黑名单**：默认黑名单覆盖 `password manager / bitwarden / 支付宝 / incognito` 等敏感应用。
5. **硬上限保护**：事件总量（10000）、会话时长（最多 7 天）、文件大小（64MB）、请求体大小（64KB）全部有上限。
6. **暴力破解减缓**：口令失败 10 次，5 分钟内拒绝新请求；恒定时间比较 token。
7. **HTTP 安全头**：`X-Content-Type-Options`、`Referrer-Policy: no-referrer`、严格 `Content-Security-Policy`。

## 快速启动

```bash
# 安装依赖（TypeScript 编译时需要）
npm install

# 直接运行（使用 tsx 免编译）
npx tsx src/server/index.ts
# 然后在浏览器打开 http://localhost:3000

# 或者先编译
npm run build
npm start
```

## Docker 部署

### 前置条件

- Docker >= 20.10
- Docker Compose >= 2.0

### 一键部署

```bash
# 1. 复制环境变量配置
cp .env.example .env

# 2. 编辑 .env 文件，配置 LLM API Key 等必要参数

# 3. 使用一键部署脚本
bash scripts/deploy.sh
```

### 手动部署

```bash
# 构建镜像
npm run docker:build

# 启动服务（包含 Redis）
npm run docker:start

# 查看日志
npm run docker:logs

# 停止服务
npm run docker:stop
```

### 服务管理

```bash
# 启动服务
bash scripts/start.sh

# 停止服务
bash scripts/stop.sh

# 一键部署（构建 + 启动 + 健康检查）
bash scripts/deploy.sh
```

### 环境变量

| 变量名 | 含义 | 默认值 |
|---|---|---|
| `NODE_ENV` | 运行环境 | `production` |
| `SERVER_HOST` | 服务绑定地址 | `0.0.0.0` |
| `SERVER_PORT` | 服务端口 | `3000` |
| `LLM_API_KEY` | LLM API Key | - |
| `LLM_API_BASE` | LLM API Base URL | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 模型名称 | `deepseek-chat` |
| `LLM_SEND_EVENTS` | 是否发送事件到 LLM | `false` |
| `LLM_MAX_TOKENS` | 单次调用最大 Token | `2048` |
| `OCR_PROVIDER` | OCR 提供商（local/external/mock） | `local` |
| `OCR_API_KEY` | OCR API Key | - |
| `OCR_API_ENDPOINT` | OCR API 端点 | - |
| `DATA_DIR` | 数据存储目录 | `/app/.data` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `REDIS_HOST` | Redis 地址 | `redis` |
| `REDIS_PORT` | Redis 端口 | `6379` |
| `REDIS_PASSWORD` | Redis 密码 | - |

### 数据持久化

- `app-data`：应用数据（会话记录等）
- `app-uploads`：上传文件
- `redis-data`：Redis 缓存数据

### 健康检查

服务启动后可通过以下方式检查健康状态：

```bash
# 检查容器健康状态
docker inspect --format='{{.State.Health.Status}}' ai-workflow-observer

# 访问健康检查接口
curl http://localhost:3000/health
```

## API Key 接入说明（统一标注与替换）

本项目在以下位置预留了 API Key 占位；只需填入密钥或通过环境变量/`.env` 提供，无需改动代码即可接入真实服务。

### 1. `.env` / `.env.example` 中的环境变量（推荐）

在项目根目录下复制 `.env.example` 为 `.env`，或直接修改：

| 变量名 | 含义 | 何时必填 |
|---|---|---|
| `LLM_API_KEY` | 对接 LLM 的 API Key（与 `LLM_API_BASE`、`LLM_MODEL` 配套使用） | 启用"AI 增强理解" / "AI 生成工作流" 时必填 |
| `LLM_API_BASE` | OpenAI 兼容协议的 Base URL（默认 `https://api.openai.com/v1`） | 非默认端点时必填 |
| `LLM_MODEL` | 模型名称（默认 `gpt-4o-mini`） | 需要切换模型时选填 |
| `OCR_API_KEY` | 第三方 OCR 服务的 Key（屏幕画面的文本识别） | 需要真实 OCR 时必填 |

示例：

```bash
# .env 文件
LLM_API_KEY=sk-your-llm-key-here
LLM_API_BASE=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
OCR_API_KEY=your-ocr-key-here
```

> 未配置密钥时，系统自动以 **mock 模式** 运行——仍可走完观察 → 聚类 → 报告 → Agent 生成 → Agent 执行全链路，仅 AI 增强能力与真实 OCR 降级为本地模板与占位。

### 2. 代码中的标注位置（便于查找与替换）

| 文件 | 标注行 | 说明 |
|---|---|---|
| `src/config.ts` | `process.env["LLM_API_KEY"]`、`process.env["OCR_API_KEY"]` | 从环境变量统一读取 |
| `src/ai/llm-client.ts` | `Authorization: "Bearer ${this.apiKey}"` | 调用 LLM 时用，未配置即降级 mock |

在当前代码中，所有 API Key **仅从环境变量读取**，不会出现在硬编码或提交的代码中。`getPublicConfigSummary()`（配置公开摘要接口）永远返回 `hasApiKey: boolean` 占位，绝不返回密钥字符串。

## 本地演示（不依赖浏览器 / HTTP 服务器）

```bash
npx tsx src/scripts/run-demo.ts
```

这个脚本会：
1. 创建观察会话；
2. 注入典型"销售助理一日"的事件（包含一条敏感关键词事件用于演示脱敏）；
3. 生成并打印 AI 机会清单与工作流蓝图；
4. 最后销毁本次会话。

示例输出：
```
[demo] session id: sess_xxxxxxxx
[demo] generated events: ... redacted: ...
[demo] sensitive event redacted: true → 复制客户手机：[REDACTED] 以及邮箱 [REDACTED]

[demo] ===== 报告输出 =====
[demo] observation hours: ...
[demo] clusters count: ...

  #1 客户信息助手  优先级=...  自动化=...  业务价值=...  风险=...
    ...
[demo] session wiped.
```

## 接入真实录屏

观察层留出了 `recordEvent(sk, { kind, appName, summary, durationMs, screenRect })` 接口。只要把屏幕内容 OCR 后的摘要喂进来，就可以复用其余三层。
