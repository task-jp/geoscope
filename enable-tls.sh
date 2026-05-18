#!/bin/bash
# Let's Encrypt で TLS を有効化するブートストラップスクリプト
#
# 使い方:
#   DOMAIN=example.com EMAIL=admin@example.com COMPOSE_DIR=/opt/geoscope bash enable-tls.sh
#
# 前提:
#   - DOMAIN の A レコードが既にこのホストを指している
#   - docker compose up でスタックが起動済 (HTTP モード)
#   - certbot-etc / certbot-var ボリュームが docker-compose.yml で定義済
set -e

: "${DOMAIN:?DOMAIN must be set (e.g. DOMAIN=example.com)}"
: "${EMAIL:?EMAIL must be set (e.g. EMAIL=admin@example.com)}"
: "${COMPOSE_DIR:=/opt/geoscope}"

echo "=== Step 1: Prepare certbot dirs ==="
docker run --rm -v geoscope_certbot-var:/var/www/certbot alpine mkdir -p /var/www/certbot

echo "=== Step 2: Issue certificate for $DOMAIN ==="
docker run --rm \
  -v geoscope_certbot-etc:/etc/letsencrypt \
  -v geoscope_certbot-var:/var/www/certbot \
  certbot/certbot certonly \
  --webroot -w /var/www/certbot \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive

echo "=== Step 3: Switch nginx.conf to HTTPS ==="
cd "$COMPOSE_DIR"
cat > frontend/nginx.conf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 100m;

    root /usr/share/nginx/html;
    index index.html;

    # OG meta tags (/@z/lat/lon/bearing/pitch) — CDNキャッシュ禁止
    location ~ ^/@[\d.]+/[\d.\-]+/[\d.\-]+ {
        proxy_pass http://backend:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        add_header Cache-Control "no-cache, no-store";
        add_header CDN-Cache-Control "no-store";
    }

    location /api/ {
        proxy_pass http://backend:8000/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /tiles/ {
        proxy_pass http://backend:8000/tiles/;
        proxy_set_header Host \$host;
        proxy_buffering off;
    }

    location /ws/ {
        proxy_pass http://backend:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }

    location ~* \.(js)\$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header CDN-Cache-Control "no-store";
        add_header X-Robots-Tag "noindex, nofollow";
        try_files \$uri =404;
    }

    location ~* \.(css)\$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header CDN-Cache-Control "no-store";
        try_files \$uri =404;
    }

    location / {
        add_header Cache-Control "no-cache";
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX

echo "=== Step 4: Rebuild and restart frontend ==="
docker compose up -d --build frontend

echo "=== Step 5: Install auto-renewal cron ==="
(crontab -l 2>/dev/null; echo "0 3 * * * docker run --rm -v geoscope_certbot-etc:/etc/letsencrypt -v geoscope_certbot-var:/var/www/certbot certbot/certbot renew --quiet && cd ${COMPOSE_DIR} && docker compose exec frontend nginx -s reload") | crontab -

echo ""
echo "=== Done! ==="
echo "https://${DOMAIN}/ is now live with TLS"
