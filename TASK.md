# Channel.io Webhook Slack スレッド化 実装タスク

以下のステップで実装を進めます。

- [x] **1. Supabase テーブル作成:**
    *   `slack_thread_store` テーブルを Supabase プロジェクト内に作成しました。
    *   SQL スキーマ:
        ```sql
        CREATE TABLE slack_thread_store (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          channelio_chat_id TEXT NOT NULL UNIQUE,
          slack_thread_ts TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX idx_slack_thread_store_expires_at ON slack_thread_store (expires_at);
        CREATE INDEX idx_slack_thread_store_chat_id ON slack_thread_store (channelio_chat_id);
        ```
    *   **担当:** ユーザー (Supabase Studio またはマイグレーションファイル経由で実行) - **完了**

- [x] **2. 型定義の更新:**
    *   対象ファイル: `supabase/functions/channelio-webhook-handler/index.ts`
    *   `postToSlack` 関数のシグネチャを `(channel: string, text: string, blocks?: any[], threadTs?: string) => Promise<string | undefined>` に変更しました。
    *   `SlackThreadInfo` インターフェースを追加しました。
    *   `ChannelioWebhookPayload`, `ChannelioEntity`, `ChannelioRefers` の型定義を更新しました。

- [x] **3. ストア操作関数の実装:**
    *   対象ファイル: `supabase/functions/channelio-webhook-handler/index.ts`
    *   Supabase クライアントの初期化をグローバルスコープに移動し、`SERVICE_ROLE_KEY` を使用するようにしました。
    *   `getActiveThreadTs(chatId: string): Promise<string | null>` を実装しました。
    *   `saveThreadTs(chatId: string, threadTs: string): Promise<void>` を実装しました。
    *   (任意) `deleteThreadTs(chatId: string): Promise<void>` を実装しました。

- [x] **4. `postToSlack` 関数の修正:**
    *   対象ファイル: `supabase/functions/channelio-webhook-handler/index.ts`
    *   引数 `threadTs` が渡された場合に `thread_ts` を含めるように修正しました。
    *   API のレスポンスから `ts` を返し、エラー時は `undefined` を返すように修正しました。

- [x] **5. `handleWebhook` 関数のロジック変更:**
    *   対象ファイル: `supabase/functions/channelio-webhook-handler/index.ts`
    *   `channelio_chat_id` を取得し、存在を確認するようにしました。
    *   `getActiveThreadTs` を呼び出すようにしました。
    *   `postToSlack` に `threadTs` を渡すようにしました。
    *   `postToSlack` の戻り値 (`newTs`) を受け取り、新しいスレッドの場合に `saveThreadTs` を呼び出すようにしました。

- [x] **6. 環境変数の設定確認:**
    *   Supabase Function の設定で `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` が正しく設定されていることを確認しました。
    *   RLS ポリシーが Disabled であることを確認しました。
    *   **担当:** ユーザー - **完了**

- [ ] **7. デプロイとテスト:**
    *   修正したコードをデプロイします (`supabase functions deploy ...`)。
    *   Channel.io からテスト Webhook を送信し、Slack でスレッド化・有効期限を確認します。
    *   **担当:** ユーザー 