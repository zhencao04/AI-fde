#!/bin/bash
set -e

echo "[INFO] 停止 AI Workflow Observer 服务..."

docker-compose down

echo "[INFO] 服务已停止！"