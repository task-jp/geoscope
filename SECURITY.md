# Security Policy

## 脆弱性の報告

GeoScope に脆弱性を発見された場合は、**公開 Issue ではなく**以下のいずれかで非公開に報告してください:

1. [GitHub Private Vulnerability Reporting](https://github.com/task-jp/geoscope/security/advisories/new) (推奨)
2. リポジトリオーナーへの直接連絡 (GitHub の任意の Issue・Discussion にメンションして連絡先を依頼)

報告には以下を含めてください:

- 影響範囲 (どのコンポーネント・どのバージョン)
- 再現手順 (PoC コードがあれば添付)
- 想定される影響 (情報漏洩 / 権限昇格 / DoS など)

## 対応プロセス

1. 受領確認: 5 営業日以内に返信します
2. 影響評価 + 修正方針共有: 14 日以内
3. パッチリリース: 影響度に応じて 30〜90 日以内
4. CVE 取得 (重大な場合)
5. 修正公開後に Security Advisory を公開

## サポート範囲

`main` ブランチ最新版が対象です。古いタグの個別バックポートは原則行いません。

## 既知の制約

- GeoScope は **ユーザーの RunPod API key を一時的に Job レコードに保存**します。ジョブ完了後に削除されますが、DB ダンプ等で漏洩しないよう運用注意してください
- バックアップ (`scripts/backup_db.sh`) はユーザーデータ全体を R2 などにアップロードします。バケット権限を厳密に設定してください
- `frontend/public/account.js` 等はそのままユーザーに配信されるため、機密情報を埋め込まないでください
