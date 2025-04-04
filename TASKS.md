# Yeni Auto V2 - タスクリスト

## フェーズ1: 注文番号抽出とLogiless連携 (OAuth 2.0)

-   [X] **目標:** Channel.ioメッセージから注文番号を抽出し、Logiless APIで注文情報を取得(OAuth 2.0認証を使用)、AIプロンプトとSlack通知に情報を追加する。
-   [X] **基盤:** `supabase/functions/channelio-webhook-handler/index.ts` を変更。
-   [X] **注文番号抽出:** 正規表現で `#?yeni-12345` 形式の番号を抽出するロジックを実装・確認。
-   [ ] **Logiless API連携 (OAuth 2.0):**
    -   [X] `LOGILESS_CLIENT_ID`, `LOGILESS_CLIENT_SECRET` を Supabase Secrets に設定済。
    -   [X] アクセストークン取得ヘルパー関数 `getLogilessAccessToken` を `index.ts` に追加 (Basic認証ヘッダー生成、トークン取得リクエスト)。
    -   [ ] **TODO:** トークン発行エンドポイントURL (`LOGILESS_TOKEN_URL` 定数) をLogilessドキュメントで**確認・修正**。
    -   [ ] `processUserQuery` 関数内で `getLogilessAccessToken` を呼び出し。
    -   [ ] 取得したアクセストークンを `Authorization: Bearer <トークン>` ヘッダーに設定して注文情報APIを呼び出す。
    -   [ ] **TODO:** 注文情報取得APIエンドポイントURL (`logilessApiUrl` 変数) とクエリパラメータ (`code=...`) をLogilessドキュメントで**確認・修正**。
    -   [ ] **TODO:** 注文情報取得APIのHTTPメソッド (`GET`) をLogilessドキュメントで**確認**。
    -   [ ] **TODO:** 注文情報取得APIレスポンス形式 (`LogilessOrderData` 型、配列か単一オブジェクトか) をLogilessドキュメントで**確認**し、情報抽出ロジック (`find` 条件など) を**修正**。
    -   [ ] **TODO:** ロジレス詳細URLの取得 (`details_url`) または組み立てロジック (`LOGILESS_MERCHANT_ID` 要否含む) をLogilessドキュメントで**確認・修正**。
    -   [ ] エラーハンドリング (トークン取得失敗、API 401/404/5xxエラー) を実装・確認。
-   [ ] **index.ts への統合:**
    -   [ ] 注文番号が見つかった場合に Logiless 認証・API呼び出しを行うように `processUserQuery` を修正。(OAuth対応)
-   [ ] **AIプロンプト拡張:**
    -   [ ] AIプロンプトにLogiless連携結果（成功、失敗、認証失敗など）を反映。
    -   [ ] 回答ガイドライン（注文関連）がLogiless情報を考慮しているか確認。
-   [ ] **Slack通知拡張:**
    -   [ ] Slack Block KitにLogiless情報とURL（または失敗情報）を反映。
-   [ ] **環境変数確認:**
    -   [ ] (任意) `LOGILESS_MERCHANT_ID` が必要か確認し、必要なら設定。
-   [ ] **テスト:**
    -   [ ] `getLogilessAccessToken` の単体テストを作成・実行。
    -   [ ] 注文情報取得部分のロジックを (可能であればモックを使って) テスト。
    -   [ ] 統合テストでLogiless連携を含む一連の流れを確認。
-   [ ] **デプロイと動作確認:**
    -   [ ] Supabase Edge Function をデプロイ。
    -   [ ] 実際のChannel.io Webhook (注文番号を含む/含まない) で動作を確認。
    -   [ ] Logiless API との連携を実環境で確認 (成功/失敗ケース)。
    -   [ ] AI回答案とSlack通知の内容を確認。
    -   [ ] エラーハンドリングと通知を実環境で確認。
-   [ ] **ドキュメント更新:** READMEや関連ドキュメントを更新。

## フェーズ2: AI回答案のChannel.ioへの投稿

-   [X] **目標:** AIが生成した回答案を、Slack通知に加えて、元のChannel.ioチャットスレッドにプライベートメッセージとして投稿する。
-   [X] **環境変数:** `CHANNELIO_ACCESS_KEY`, `CHANNELIO_ACCESS_SECRET`, (任意)`CHANNELIO_BOT_PERSON_ID` 設定済。
-   [X] **`_shared/channelio.ts` の `sendChannelioPrivateMessage` 関数更新:** (内容は別ファイルで管理されている前提)
    -   [X] Channel.io API (`POST /open/v5/user_chats/{chatId}/messages`) 呼び出しロジック実装済。
    -   [X] `private` オプション、`personId` 指定に対応済。
-   [X] **`index.ts` への統合 (AI回答案投稿):**
    -   [X] `processUserQuery` 内で `sendChannelioPrivateMessage` を呼び出し。
    -   [X] 必要な引数 (`chatId`, `message`, APIキー, `personId`) を渡す。
    -   [X] エラーハンドリングとログ出力。
-   [ ] **テスト:** (Logiless連携後に実施)
    -   [ ] Webhookをトリガーし、AI回答案がプライベートメッセージとして投稿されることを確認。
    -   [ ] `CHANNELIO_BOT_PERSON_ID` 設定時の動作を確認。
    -   [ ] エラーケースでのログ出力を確認。
-   [ ] **デプロイと動作確認:** (Logiless連携後に実施)
    -   [ ] Supabase Edge Function をデプロイ。
    -   [ ] デプロイ後のログを監視し、動作を確認。

## Channel.io Webhook Slack スレッド化

-   [X] **Supabase テーブル作成:** `slack_thread_store` 作成済。
-   [X] **型定義の更新:** `postToSlack`, `SlackThreadInfo`, Channel.io関連型 更新済。
-   [X] **ストア操作関数の実装:** `getActiveThreadTs`, `saveThreadTs` 実装済。
-   [X] **`postToSlack` 関数の修正:** `thread_ts` 対応、戻り値修正済。
-   [X] **`index.ts` / `processUserQuery` への統合:** スレッド確認・保存ロジック実装済。
-   [X] **環境変数の設定確認:** `SUPABASE_SERVICE_ROLE_KEY` 使用確認済。
-   [ ] **デプロイとテスト:**
    -   [ ] 修正したコードをデプロイします (`supabase functions deploy ...`)。
    -   [ ] Channel.io からテスト Webhook を送信し、Slack でスレッド化・有効期限を確認します。
    -   [ ] **担当:** ユーザー

## その他

-   [ ] **リンターエラー対応:** Deno環境起因と思われるエラーは無視、それ以外は修正。
-   [ ] **依存関係:** `base64.ts` インポート確認。

---
最終更新: 2024-06-10 (更新日時は手動更新) 