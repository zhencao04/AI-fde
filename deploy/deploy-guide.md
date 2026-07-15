# AI FDE 助手 - 宝塔 Windows 面板部署指南

本文档介绍如何将 AI FDE 助手部署到**腾讯云轻量应用服务器（宝塔 Windows 面板）**。

---

## 一、环境准备

### 1.1 安装 Node.js

在宝塔面板中操作：

1. 左侧菜单 → **软件商店**
2. 搜索 **Node.js 版本管理器** 或直接搜索 `node`
3. 安装 **Node.js 18.x 或 20.x**（推荐 20.x LTS）
4. 安装完成后，在终端执行 `node -v` 和 `npm -v` 验证

或通过终端命令安装（推荐使用 nvm）：
```powershell
# 下载 nvm-windows
# 访问 https://github.com/coreybutler/nvm-windows/releases 下载安装包
nvm install 20
nvm use 20
node -v
```

### 1.2 安装 PM2（进程守护）

```powershell
npm install -g pm2
pm2 -v
```

### 1.3 安装 Python（仅 OCR=external 模式需要）

如果需要使用本地 PaddleOCR 服务，需要安装 Python 3.10+：

1. 宝塔面板 → **软件商店** → 搜索安装 Python
2. 或从 [python.org](https://www.python.org/downloads/) 下载安装
3. 安装时勾选 **"Add Python to PATH"**

验证：
```powershell
python --version
pip --version
```

---

## 二、上传项目文件

### 2.1 需要上传的文件和目录

```
项目根目录 ─┬─ dist/              ← TypeScript 编译产物（必须）
            ├─ ai-fde-minimal/    ← 前端静态页面（必须）
            ├─ paddle_ocr_service/ ← OCR Python 服务（可选，local 模式不需要）
            ├─ .env               ← 生产环境配置（必须，从 .env.production 复制）
            ├─ config.json        ← 服务配置（必须）
            ├─ package.json       ← 依赖声明（必须）
            ├─ package-lock.json  ← 依赖锁定（推荐）
            ├─ ecosystem.config.cjs ← PM2 配置（推荐）
            └─ deploy/            ← 部署相关文件（含 nginx.conf）
```

### 2.2 不需要上传的文件（可忽略）

- `node_modules/` — 服务器上用 `npm install` 重新安装
- `.data/` — 本地会话数据，服务器会自动创建
- `src/` — TypeScript 源码，已编译到 `dist/`
- `.trae/`、`_tmp_taste_skill/`、`.agents/`、`agent/` — 开发相关
- `ai-workflow-observer-agent/` — 旧版前端
- `natapp.exe`、`run_natapp.bat` — 内网穿透工具
- 各种 `.js` 临时脚本（`check-js*.js`、`test-*.js`、`*.js` 临时文件）
- `.git/`、`.gitignore` — 版本控制
- `*.md`（可选，README 等文档）
- `tsconfig.json`（可选，仅编译需要）
- `out.txt`、`err.txt` — 日志临时文件

### 2.3 上传方式

**方式 A：宝塔文件管理器**
1. 宝塔面板 → **文件** → 进入 `/www/wwwroot/`
2. 新建文件夹 `ai-fde-observer`
3. 将上述文件通过文件管理器上传

**方式 B：FTP/SFTP**
1. 宝塔面板 → **FTP** → 创建 FTP 账号
2. 使用 FileZilla 等工具上传

**方式 C：Git 拉取（推荐，如果项目在 Git 仓库）**
```powershell
cd C:\wwwroot\
git clone <你的仓库地址> ai-fde-observer
cd ai-fde-observer
```

> **提示**：上传前请确保本地已执行 `npm run build` 生成了 `dist/` 目录。

---

## 三、安装依赖与配置

### 3.1 安装 Node 依赖

打开宝塔终端，进入项目目录：

```powershell
cd C:\wwwroot\ai-fde-observer
npm install --production
```

> 如果需要构建（没有 dist 目录），执行完整安装并构建：
> ```powershell
> npm install
> npm run build
> ```

### 3.2 配置环境变量

复制生产环境配置模板：

```powershell
copy .env.production .env
```

然后编辑 `.env`，填写真实的 API Key：

```powershell
# 用记事本或宝塔文件管理器编辑
notepad .env
```

至少修改以下项：
- `LLM_API_KEY` — 你的 DeepSeek（或其他）API Key
- `LLM_API_BASE` — 如使用其他模型提供商，修改此项
- `LLM_MODEL` — 对应模型名称
- `OCR_PROVIDER` — 默认 `local`，如需完整 OCR 改为 `external`

### 3.3 安装 OCR 服务（可选，OCR_PROVIDER=external 时）

```powershell
cd C:\wwwroot\ai-fde-observer\paddle_ocr_service
pip install -r requirements.txt
```

> 首次运行 OCR 服务会自动下载 ~15MB 的 ONNX 模型文件，请确保服务器能访问外网。

---

## 四、启动服务（PM2 守护）

### 4.1 使用 PM2 配置文件启动

项目根目录已有 `ecosystem.config.cjs`，直接启动：

```powershell
cd C:\wwwroot\ai-fde-observer

# 启动 API 服务
pm2 start ecosystem.config.cjs --only observer-api

# 如需同时启动 OCR 服务（OCR_PROVIDER=external 且用自建 OCR 时）
pm2 start ecosystem.config.cjs --only observer-ocr

# 查看状态
pm2 status

# 设置开机自启
pm2 save
pm2-startup install
```

### 4.2 手动启动（不用 PM2 配置文件）

```powershell
# 启动 API 服务
pm2 start dist/server/index.js --name observer-api --node-args="--max-old-space-size=2048"

# 启动 OCR 服务（可选）
pm2 start paddle_ocr_service/ocr_server.py --name observer-ocr --interpreter python
```

### 4.3 常用 PM2 命令

```powershell
pm2 list                    # 查看所有进程
pm2 logs observer-api       # 查看 API 日志
pm2 logs observer-ocr       # 查看 OCR 日志
pm2 restart observer-api    # 重启 API
pm2 stop observer-api       # 停止 API
pm2 delete observer-api     # 删除进程
pm2 monit                   # 实时监控
```

---

## 五、配置 Nginx 反向代理

### 5.1 在宝塔中创建站点

1. 宝塔面板 → **网站** → **添加站点**
2. 域名：填写你的域名（如 `ai.example.com`），或填服务器公网 IP
3. 根目录：`C:\wwwroot\ai-fde-observer\ai-fde-minimal\pages`
4. PHP 版本：纯静态
5. 点击**提交**

### 5.2 修改站点配置

1. 站点列表中找到刚创建的站点 → 点击**设置**
2. 左侧 → **配置文件**
3. 将 `deploy/nginx.conf` 中的 `server { ... }` 块内容复制进去
4. 修改以下路径为实际路径：
   - `root` 路径改为 `C:/wwwroot/ai-fde-observer/ai-fde-minimal/pages`
   - 静态资源 `root` 改为 `C:/wwwroot/ai-fde-observer/ai-fde-minimal`
5. **保存**

> **注意**：Windows 宝塔 Nginx 路径用正斜杠 `/` 或双反斜杠 `\\`。
> 如果宝塔默认生成了一个 server 块，**替换**整个 server 块内容。

### 5.3 放行端口

1. 宝塔面板 → **安全** → **防火墙**
2. 添加放行端口：
   - `3000` — Node 后端服务（如果不通过 Nginx 代理直接访问）
   - `80` — HTTP（已默认放行）
   - `443` — HTTPS（申请 SSL 后需要）
3. 同时在**腾讯云轻量控制台** → **防火墙** 中放行相同端口

---

## 六、申请 SSL 证书（HTTPS）

1. 宝塔面板 → **网站** → 站点设置 → **SSL**
2. 选择 **Let's Encrypt**（免费）：
   - 勾选你的域名
   - 填写邮箱
   - 点击**申请**
3. 申请成功后，开启 **强制 HTTPS**
4. 确认 Nginx 配置中的 `listen 443 ssl` 已正确生成

> 如果域名还没备案，Let's Encrypt 证书可能无法申请（国内服务器 80 端口受限）。
> 可以先使用 `http://IP:3000` 直接访问，或使用自签名证书。

---

## 七、验证部署成功

### 7.1 页面访问验证

| 页面 | 地址 | 预期结果 |
|------|------|----------|
| 登录页 | `http://你的域名/` 或 `http://IP:3000/` | 显示登录页面 |
| 仪表盘 | 登录后自动跳转 | 显示观察仪表盘 |
| 前端脚本 | `http://你的域名/frontend.js` | 返回 JS 内容 |

### 7.2 API 接口验证

在浏览器或 Postman 中测试：

```
# 系统状态
GET http://你的域名/api/system/status

# 公共配置
GET http://你的域名/api/config/public

# 会话列表（需要登录后获取）
GET http://你的域名/api/sessions
```

### 7.3 功能验证

1. **登录**：使用任意用户名密码登录（当前版本无鉴权）
2. **创建会话**：点击新建观察会话
3. **上传截图**：测试截图上传功能（验证 20MB 限制是否生效）
4. **生成报告**：测试 AI 报告生成（验证 LLM API 是否正常）

---

## 八、代码更新流程

后续更新代码时，只需替换核心文件并重启服务：

```powershell
# 1. 上传新的 dist/ 目录（覆盖旧文件）
# 2. 上传新的 ai-fde-minimal/ 目录（覆盖旧文件）
# 3. 如 package.json 有变化，重新安装依赖
cd C:\wwwroot\ai-fde-observer
npm install --production

# 4. 重启服务
pm2 restart observer-api

# 5. 验证
pm2 status
```

> 如果前端有更新，记得清除浏览器缓存或强制刷新（Ctrl+F5）。

---

## 九、常见问题

### Q1：访问页面显示 502 Bad Gateway

**原因**：Node 服务未启动或端口不对。

**解决**：
```powershell
pm2 status
pm2 logs observer-api
# 检查 3000 端口是否在监听
netstat -ano | findstr ":3000"
```

### Q2：上传图片提示 413 Request Entity Too Large

**原因**：Nginx `client_max_body_size` 太小。

**解决**：在 Nginx 配置的 `server` 块中确保有 `client_max_body_size 20m;`，然后 `nginx -s reload`。

### Q3：PM2 开机自启不生效

**解决**：
```powershell
pm2 startup
# 按照输出的命令执行
pm2 save
```

### Q4：OCR 服务启动失败

**原因**：Python 环境问题或依赖缺失。

**解决**：
```powershell
cd C:\wwwroot\ai-fde-observer\paddle_ocr_service
pip install -r requirements.txt
python ocr_server.py
# 查看具体错误
```

### Q5：Windows 路径问题

Nginx 配置中的路径使用正斜杠 `/`：
```nginx
root C:/wwwroot/ai-fde-observer/ai-fde-minimal/pages;
```

---

## 十、联系方式

如部署遇到问题，检查 PM2 日志和 Nginx 日志：
- PM2 日志：`pm2 logs observer-api`
- Nginx 日志：宝塔面板 → 网站 → 站点设置 → 日志
- 应用日志：项目 `.data/logs/` 目录
