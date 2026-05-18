<!-- PR の目的を 1-2 行で。バグ修正なら関連 Issue 番号も書く。 -->

## やったこと

-

## 動機

(なぜこの変更が必要か。Issue を解決するならリンク: `Closes #...`)

## テスト

- [ ] `pytest backend -q --maxfail=1` を通した
- [ ] (UI 変更があれば) `docker compose up --build` でブラウザから動作確認した

## 影響範囲

- DB スキーマ変更: なし / あり (詳細:
- 環境変数追加・変更: なし / あり (`.env.example` も更新済)
- ワーカー側との互換性: 影響なし / 別途 geoscope-worker 側も対応必要

## チェックリスト

- [ ] ハードコードした個人情報・API キー・本番固有値が無いか
- [ ] `frontend/public/index.html` の `?v=N` を上げた (フロント変更時)
- [ ] CLAUDE.md / README.md / .env.example を更新した (該当する場合)
