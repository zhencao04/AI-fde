#!/bin/bash
set -e

echo "[INFO] 启动 AI Workflow Observer 服务..."

if [ ! -f .env ]; then
    echo "[WARN] .env 文件不存在，正在从 .env.example 创建..."
    cp .env.example .env
    echo "[INFO] 请编辑 .env 文件配置环境变量"
fi

docker-compose up -d

echo "[INFO] 等待服务启动..."
sleep 5

echo "[INFO] 服务状态:"
docker-compose ps

echo "[INFO] 服务已启动！"
echo "  服务地址: http://localhost:3000"
echo "  查看日志: docker-compose logs -f"