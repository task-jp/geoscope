#!/bin/bash
# GeoScope DB バックアップ
#
# 日次で PostgreSQL を pg_dump + gzip し、Cloudflare R2 (または rclone 対応の
# 任意のリモート) にアップロード。RETENTION_DAYS より古いバックアップは自動削除。
#
# Usage (cron):
#   sudo crontab -e
#   0 18 * * * DB_CONTAINER=geoscope-db-1 R2_REMOTE_PATH=r2:my-bucket/backups/ /opt/geoscope/scripts/backup_db.sh >> /var/log/geoscope-backup.log 2>&1
#
# 必要環境:
#   - rclone が R2_REMOTE_PATH の remote として設定済み
#   - DB_CONTAINER で指定した postgres コンテナが稼働中
#
# リストア手順:
#   rclone copy "${R2_REMOTE_PATH}geoscope-YYYY-MM-DD.sql.gz" /tmp/
#   gunzip /tmp/geoscope-YYYY-MM-DD.sql.gz
#   docker exec -i "$DB_CONTAINER" psql -U geoscope geoscope < /tmp/geoscope-YYYY-MM-DD.sql

set -euo pipefail

: "${DB_CONTAINER:?DB_CONTAINER must be set (e.g. DB_CONTAINER=geoscope-db-1)}"
: "${R2_REMOTE_PATH:?R2_REMOTE_PATH must be set (e.g. R2_REMOTE_PATH=r2:my-bucket/backups/)}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

DATE=$(date +%Y-%m-%d)
TMP_DIR=/tmp
DUMP_FILE="$TMP_DIR/geoscope-${DATE}.sql.gz"
# Ensure trailing slash on remote path
[[ "$R2_REMOTE_PATH" != */ ]] && R2_REMOTE_PATH="${R2_REMOTE_PATH}/"
REMOTE_FILE="${R2_REMOTE_PATH}geoscope-${DATE}.sql.gz"

echo "[$(date -Iseconds)] === DB backup start ==="

# 1. pg_dump → gzip
echo "[$(date -Iseconds)] dumping..."
docker exec "$DB_CONTAINER" pg_dump -U geoscope --no-owner --no-privileges geoscope | gzip -9 > "$DUMP_FILE"
SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "[$(date -Iseconds)] dump complete: $DUMP_FILE ($SIZE)"

# 2. リモートへアップロード
echo "[$(date -Iseconds)] uploading to $REMOTE_FILE..."
rclone copyto "$DUMP_FILE" "$REMOTE_FILE"
echo "[$(date -Iseconds)] upload complete"

# 3. ローカル一時ファイル削除
rm -f "$DUMP_FILE"

# 4. リテンション: RETENTION_DAYS より古いものを削除
echo "[$(date -Iseconds)] cleaning up backups older than ${RETENTION_DAYS}d..."
rclone delete --min-age "${RETENTION_DAYS}d" "$R2_REMOTE_PATH" 2>&1 || true

echo "[$(date -Iseconds)] === DB backup done ==="
