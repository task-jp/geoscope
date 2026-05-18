#!/bin/bash
# GeoScope デプロイスクリプト
#
# 使い方:
#   SERVER=user@host.example.com REMOTE=/opt/geoscope bash deploy.sh [-f|-b]
#
# フラグ:
#   -f, --frontend-only  フロントエンドのみ
#   -b, --backend        バックエンド + フロントエンド
#   (なし)               フル (現状は -b と同義: ローカル worker は別リポ task-jp/geoscope-worker に分離済)
#
# 前提: リモートに docker compose が入っており、REMOTE 配下に .env と
#       tiles ボリュームが既に存在すること。
set -e
cd "$(dirname "$0")"

: "${SERVER:?SERVER must be set (e.g. SERVER=user@host.example.com)}"
: "${REMOTE:=/opt/geoscope}"

# フラグ
MODE=full
if [ "$1" = "--frontend-only" ] || [ "$1" = "-f" ]; then
    MODE=frontend
elif [ "$1" = "--backend" ] || [ "$1" = "-b" ]; then
    MODE=backend
fi

echo "=== Deploying to $SERVER:$REMOTE ==="

if [ "$MODE" = "frontend" ]; then
    echo "Frontend only"
    rsync -avz --delete --exclude='node_modules' frontend/public/ "$SERVER:$REMOTE/frontend/public/"
    rsync -avz frontend/nginx.conf frontend/Dockerfile "$SERVER:$REMOTE/frontend/"
    ssh "$SERVER" "cd $REMOTE && docker compose build frontend && docker compose up -d frontend"
else
    echo "Backend + Frontend mode"
    rsync -avz --delete --exclude='node_modules' frontend/public/ "$SERVER:$REMOTE/frontend/public/"
    rsync -avz frontend/nginx.conf frontend/Dockerfile "$SERVER:$REMOTE/frontend/"
    rsync -avz --delete --exclude='__pycache__' --exclude='.env' --exclude='datasets' --exclude='models' backend/ "$SERVER:$REMOTE/backend/"
    rsync -avz docker-compose.yml "$SERVER:$REMOTE/"
    ssh "$SERVER" "cd $REMOTE && docker compose build backend frontend && docker compose up -d backend frontend"
fi

echo "=== Deploy complete ==="
