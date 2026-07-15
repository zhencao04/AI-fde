@echo off
REM ===============================================================
REM  一键启动：先启动 Python OCR 服务（127.0.0.1:9003）
REM  然后启动 Node/Express 主服务（127.0.0.1:3000）
REM  提示：关闭任何一个窗口都将退出
REM ===============================================================

setlocal

echo [start-all] 正在启动本地 Python OCR 服务（新窗口）...
start "paddle-ocr-service" cmd /k "cd /d %~dp0paddle_ocr_service && start.bat"

REM 等待几秒让 Python 服务启动，再启动 Node
timeout /t 5 /nobreak >nul

echo [start-all] 正在启动 Node 主服务（当前窗口）...
cd /d "%~dp0.."
if not exist node_modules (
  echo [start-all] 未检测到 node_modules，先执行 npm install...
  call npm install
)

REM 优先使用 tsx 直接运行（免编译）
where tsx >nul 2>nul
if %ERRORLEVEL%==0 (
  call tsx src/server/index.ts
) else (
  echo [start-all] 未找到 tsx，回退使用 npx tsx...
  call npx tsx src/server/index.ts
)

endlocal
