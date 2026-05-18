# GeoScope

DEM 標高データから地形特徴 (古墳・洞窟入り口・ドーム状地形など) を自動検出する Web アプリ。

赤色立体地図 (RRIM) ビューア + アノテーション + マルチクラス YOLO 学習/推論ジョブ管理 + BYO クラウドワーカー (RunPod)。

本番運用例: [https://geoscope.jp](https://geoscope.jp)

## アーキテクチャ

```
Browser (Vanilla ES6 + MapLibre GL)
  │
  ├─ Nginx (frontend container, :80/:443)
  │    ├─ /           → SPA static
  │    ├─ /api/       → backend:8000
  │    ├─ /tiles/     → backend:8000 (CDN キャッシュ対応)
  │    ├─ /ws/        → WebSocket upgrade → backend:8000
  │    └─ /@z/lat/lon → backend:8000 (OG meta tags)
  │
  ├─ FastAPI backend (uvicorn --workers 4)
  │    ├─ routers/*  — アノテーション / 認証 / プロジェクト / ジョブ / 検出結果 / タイル
  │    ├─ services/cloud_worker.py  — RunPod Pod 起動・停止
  │    └─ core/      — DEM デコード, RRIM 可視化, 3ch 画像生成
  │
  ├─ PostgreSQL 16 + PostGIS 3.4
  ├─ Valkey 8 (Redis 互換、ジョブ進捗 Pub/Sub + OAuth state)
  │
  └─ ML ワーカー (別リポ, AGPL-3.0)
       https://github.com/task-jp/geoscope-worker
       ユーザーの RunPod アカウントで Pod 起動。
       DEM タイルは Cloudflare R2 等から per-tile HTTP fetch。
```

## クイックスタート (ローカル開発)

### 1. 前提

- Docker + Docker Compose
- DEM タイル WebP (z=10〜16) を入れるディレクトリ。GSI 基盤地図情報 DEM1A から自前生成する手順は [DEM タイルを用意する](#dem-タイルを用意する) を参照
- Google OAuth クライアント ([Cloud Console](https://console.cloud.google.com/apis/credentials) で作成、redirect URI に `http://localhost/api/auth/google/callback`)

### 2. 環境変数

```sh
git clone https://github.com/task-jp/geoscope.git
cd geoscope
cp .env.example .env
# .env を編集 — 最低限 DB_PASSWORD, SECRET_KEY, TILES_DIR, GOOGLE_CLIENT_ID/SECRET を設定
```

### 3. 起動

```sh
docker compose up --build
```

ブラウザで [http://localhost/](http://localhost/) → Google でログイン → 地図が出れば成功。

## DEM タイルを用意する

GeoScope は z=10〜16 の WebP タイルを `${TILES_DIR}/{z}/{x}/{y}.webp` から読みます。エンコードは GSI/Q地図互換の RGB 標高エンコード:

```
h = (R * 65536 + G * 256 + B) * 0.01  [m]
x == 2**23 は無効値 (NaN)
x  > 2**23 は負の標高 ((x - 2**24) * 0.01)
```

### 国土地理院 DEM1A から生成

`tools/` に GSI 基盤地図情報 DEM1A → XYZ WebP タイル変換スクリプトを同梱しています。

```sh
# 1. GSI のサイトから DEM1A の GML zip をダウンロード
#    https://fgd.gsi.go.jp/download/menu.php

# 2. zip → タイル
python3 tools/convert_gml_to_tiles.py /path/to/FG-GML-*-DEM1A-*.zip
# → ./qchizu_dem1a_tiles/{z}/{x}/{y}.webp (z=10..16)

# 3. (任意) スキャン用の 3ch 拡張タイル (hillshade + slope + curvature) を事前生成
#    backend は 3ch タイルをリクエスト時に動的生成しますが、CDN 前段で
#    事前生成しておくと初回アクセスが速いです。
python3 tools/generate_3ch_tiles.py ./qchizu_dem1a_tiles  # 出力先は引数で指定

# 4. TILES_DIR を生成先に設定して docker compose up
echo "TILES_DIR=$PWD/qchizu_dem1a_tiles" >> .env
docker compose up --build
```

### 他の DEM (DEM5A / DEM5B / DEM10B / DEMGM) を直接ダウンロード

```sh
python3 tools/download_dem_tiles.py --bbox 35.0,138.0,36.0,139.0 --zoom 16 --out ./tiles
```

## ML ワーカー (BYO クラウドワーカー)

スキャン (推論) と学習は別リポの [geoscope-worker](https://github.com/task-jp/geoscope-worker) (AGPL-3.0) が実行します。Docker イメージ: `ghcr.io/task-jp/geoscope-worker:latest`。

GeoScope は **ユーザーが自分の RunPod アカウントで Pod を起動する BYO 方式**を取っています。

- ユーザーは UI のアカウント設定で自分の RunPod API key を入力
- `探索` ボタン押下 → backend が RunPod REST API で Pod を起動
- Pod は `geoscope-worker` イメージで `GEOSCOPE_SERVER/api/worker/...` をポーリング
- ジョブ完了 → Pod 自動削除

ローカル GPU マシンを worker として使う場合:

```sh
docker run -d --gpus all --name geoscope-worker \
  --restart unless-stopped \
  -e WORKER_API_KEY=<UI のアカウント設定で発行した自分の api_key> \
  -e GEOSCOPE_SERVER=https://your-domain.example.com \
  ghcr.io/task-jp/geoscope-worker:latest
```

## 本番デプロイ

### 1. リモートホストに git clone + .env 配置 + 起動

```sh
ssh user@host
git clone https://github.com/task-jp/geoscope.git /opt/geoscope
cd /opt/geoscope
cp .env.example .env  # 編集
docker compose up -d --build
```

### 2. (ローカルから) 差分デプロイ

ローカル作業 → リモートへ rsync + リビルド:

```sh
SERVER=user@host.example.com REMOTE=/opt/geoscope bash deploy.sh        # backend + frontend
SERVER=user@host.example.com REMOTE=/opt/geoscope bash deploy.sh -f     # frontend のみ
```

### 3. TLS (Let's Encrypt)

DNS で本番ドメインがホストを指している状態で:

```sh
DOMAIN=example.com EMAIL=admin@example.com COMPOSE_DIR=/opt/geoscope bash enable-tls.sh
```

certbot で発行 + `frontend/nginx.conf` を HTTPS 版で書き換え + 自動更新 cron 設定までやります。

### 4. DB バックアップ

cron で日次バックアップ + R2 アップロード + リテンション:

```sh
sudo crontab -e
# 0 18 * * * DB_CONTAINER=geoscope-db-1 R2_REMOTE_PATH=r2:my-bucket/backups/ /opt/geoscope/scripts/backup_db.sh >> /var/log/geoscope-backup.log 2>&1
```

## テスト

```sh
pytest backend -q --maxfail=1
```

(backend ディレクトリで動かす場合は `DATABASE_URL` と `VALKEY_URL` を export してから。)

## 技術スタック

| Layer | Technology |
|---|---|
| Frontend | Vanilla ES6 modules (ビルドステップなし), MapLibre GL JS |
| Backend | FastAPI, SQLAlchemy 2.0 async (asyncpg), Python 3.12 |
| Database | PostgreSQL 16 + PostGIS 3.4 |
| Pub/Sub | Valkey 8 (Redis 互換) |
| Auth | Google OAuth + JWT |
| ML | YOLO (ultralytics, AGPL) — 別リポ [geoscope-worker](https://github.com/task-jp/geoscope-worker) |
| Container | Docker Compose, Nginx 1.27 |
| Rate limit / 観測 | slowapi, Sentry SDK |

## ライセンス

[AGPL-3.0-or-later](LICENSE)

GeoScope を改変して SaaS として運用する場合、利用者がアクセスできるソースコードを提供する義務があります (AGPL §13)。

## サードパーティ素材

- `db/prefectures.geojson` — 出典: [国土数値情報](https://nlftp.mlit.go.jp/ksj/) (国土交通省、再配布可) を簡略化
- DEM タイル元データ: [国土地理院 基盤地図情報](https://fgd.gsi.go.jp/download/menu.php) (利用申請の上で個別生成)
- YOLO (`ultralytics`): [AGPL-3.0](https://github.com/ultralytics/ultralytics) — 本リポには ultralytics 依存なし、worker 側で動作
- MapLibre GL JS: [BSD-3-Clause](https://github.com/maplibre/maplibre-gl-js)

## コントリビューション

[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。Issue は [GitHub Issues](https://github.com/task-jp/geoscope/issues) で受け付けています。

## Acknowledgements

赤色立体地図 (RRIM) は アジア航測株式会社 千葉達朗氏により考案されたものです。
