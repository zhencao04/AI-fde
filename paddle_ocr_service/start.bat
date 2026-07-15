@echo off
REM ===============================================================
REM  本地离线 OCR 服务启动脚本（基于 RapidOCR / PaddleOCR-ONNX）
REM  默认监听 127.0.0.1:9003，首次调用时初始化 ONNX 模型（约 15MB）
REM  若 Python 未安装依赖，脚本会先执行 pip install
REM ===============================================================

setlocal
set OCR_HOST=127.0.0.1
set OCR_PORT=9003

echo [ocr-server] 检测 Python 依赖...
python -c "import rapidocr_onnxruntime, cv2, numpy" 2>nul
if errorlevel 1 (
  echo [ocr-server] 未检测到依赖，开始安装 rapidocr_onnxruntime opencv-python-headless ...
  python -m pip install rapidocr_onnxruntime opencv-python-headless
  if errorlevel 1 (
    echo [ocr-server][ERROR] 依赖安装失败，请检查网络或手动执行：
    echo     pip install rapidocr_onnxruntime opencv-python-headless
    exit /b 1
  )
)

echo [ocr-server] 正在启动 HTTP 服务 http://%OCR_HOST%:%OCR_PORT% ...
echo [ocr-server] 提示：关闭此窗口即可停止服务；按 Ctrl+C 可安全退出
python "%~dp0ocr_server.py"
endlocal
