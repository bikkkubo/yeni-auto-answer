# 環境変数読み込みエラー 解決タスク (`LOGILESS_API_KEY`, `CHANNELIO_ACCESS_KEY`, `CHANNELIO_ACCESS_SECRET`)

現在、Supabase Function 実行時に特定の環境変数 (`LOGILESS_API_KEY`, `CHANNELIO_ACCESS_KEY`, `CHANNELIO_ACCESS_SECRET`) が `undefined` となる問題を解決するためのタスクリストです。

- [ ] **1. シークレット名の再確認:**
    *   Supabase ダッシュボードの Secrets セクションで、`LOGILESS_API_KEY`, `CHANNELIO_ACCESS_KEY`, `CHANNELIO_ACCESS_SECRET` の名前が、コード (`index.ts`) 内の `Deno.env.get()` で指定されている名前と完全に一致しているか（大文字小文字、タイプミス含む）を確認する。
    *   **担当:** ユーザー

- [ ] **2. シークレットの再設定:**
    *   Supabase ダッシュボード上で、問題の3つのシークレット (`LOGILESS_API_KEY`, `CHANNELIO_ACCESS_KEY`, `CHANNELIO_ACCESS_SECRET`) を一度削除する。
    *   再度、正しい値をコピー＆ペーストして上記3つのシークレットを追加する（値の前後に余計な空白等が含まれないよう注意）。
    *   **担当:** ユーザー

- [ ] **3. 再デプロイと動作確認:**
    *   コードは変更せずに、Function (`channelio-webhook-handler`) を再度デプロイする。
        ```bash
        # 例: /opt/homebrew/bin/supabase functions deploy channelio-webhook-handler --no-verify-jwt
        ```
    *   Channel.io でユーザーとしてメッセージを送信し、エラーが発生しないか、環境変数ログ（`Checking env vars before validation:...`）で値が正しく表示されるかを確認する。
    *   **担当:** ユーザー 