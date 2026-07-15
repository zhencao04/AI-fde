#!/bin/bash
set -e

echo "=============================================="
echo "  AI Workflow Observer - 一键部署脚本"
echo "=============================================="

if [ ! -f .env ]; then
    echo "[WARN] .env 文件不存在，正在从 .env.example 创建..."
    cp .env.example .env
    echo "[INFO] 请编辑 .env 文件配置环境变量后重新运行"
    exit 1
fi

echo "[INFO] 检查 Docker 环境..."
if ! command -v docker &> /dev/null; then
    echo "[ERROR] Docker 未安装，请先安装 Docker"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "[ERROR] Docker Compose 未安装，请先安装 Docker Compose"
    exit 1
fi

echo "[INFO] 停止现有容器..."
./scripts/stop.sh 2>/dev/null || true

echo "[INFO] 构建并启动容器..."
docker-compose up -d --build

echo "[INFO] 等待服务启动..."
sleep 10

echo "[INFO] 检查服务状态..."
docker-compose ps

echo "[INFO] 检查健康状态..."
docker inspect --format='{{.State.Health.Status}}' ai-workflow-observer || echo "[INFO] 健康检查可能尚未就绪"

echo "=============================================="
echo "  部署完成！"
echo "  服务地址: http://localhost:3000"
echo "  查看日志: docker-compose logs -f"
echo "=============================================="