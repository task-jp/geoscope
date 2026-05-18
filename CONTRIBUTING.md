# コントリビューションガイド

GeoScope への貢献を歓迎します!

## バグ報告・機能リクエスト

[GitHub Issues](https://github.com/task-jp/geoscope/issues) を開いてください。Issue テンプレートが用意してあります。

## プルリクエストの流れ

1. Issue を立てて方向性を議論 (細かい修正なら省略可)
2. fork → ブランチ作成 (`feat/xxx`, `fix/xxx`)
3. ローカルで動作確認:
   - `pytest backend -q --maxfail=1`
   - 影響範囲によっては `docker compose up --build` で UI からも確認
4. PR を作成 (テンプレートに沿って記述)
5. レビュー対応 → マージ

## 開発環境セットアップ

[README.md - クイックスタート](README.md#クイックスタート-ローカル開発) を参照。

Backend をコンテナなしで動かす場合:

```sh
cd backend
pip install -r requirements.txt
export DATABASE_URL=postgresql+asyncpg://geoscope:changeme@localhost:5432/geoscope
export VALKEY_URL=redis://localhost:6379/0
uvicorn app.main:app --reload
```

## コーディング規約

### Python (backend / tools)

- PEP 8 + 4-space インデント
- snake_case 関数, PascalCase クラス, UPPER_SNAKE 定数
- public な関数・Pydantic モデルには型ヒントを付ける
- ルーターは薄く保ち、DB/IO は `services/` に置く
- 場当たり的な fix より根本原因の修正を優先

### Frontend (Vanilla ES6)

- ビルドステップなし。`public/` 配下の `.js` がそのまま配信される
- camelCase ハンドラ名、既存の ID/class 命名規約を踏襲
- 大きな新機能は別モジュールに分けて `app.js` から dynamic import
- `index.html` の `?v=N` キャッシュバスターを必ず上げる

### SQL / マイグレーション

- スキーマ変更は `db/init.sql` の対応箇所を更新
- 既存環境にも適用する場合は別ファイル (`db/migrate_*.sql`) を追加し PR description に反映手順を書く

## テスト

- バックエンド: `pytest backend/tests/` 配下に追加。`httpx.AsyncClient` でルーターを直接叩く
- フロントエンド: 現状自動テストなし。手動チェックの内容を PR description に書いてください

## コミット規約

短く目的を表すタイトル + 必要なら詳細本文。日本語/英語どちらでも OK。例:

- `公開β UI/UX 調整 + マルチワーカー対応`
- `Fix bbox interpretation in /annotations/import`
- `添削: ラベル削除を一括 SQL 化 (50万件で 3 秒)`

## 行動規範

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) を参照してください。
