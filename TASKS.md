# Yeni Auto V2 - タスクリスト

## フェーズ1: 注文番号抽出と外部連携 (既存のマークに従う)

-   [x] **目標:** Channel.ioメッセージから注文番号を抽出し、Logiless APIで注文情報を取得し、Channel.ioにプライベートメッセージを送信、AIプロンプトとSlack通知に情報を追加する。
-   [x] **基盤:** `supabase/functions/channelio-webhook-handler/index.ts` を変更。
-   [x] **注文番号抽出:** 正規表現で `yeni-12345` 形式の番号を抽出するロジックを実装。
-   [x] **Logiless API連携:**
    -   [x] `supabase/functions/_shared/logiless.ts` ヘルパーを作成。
    -   [x] `getLogilessOrderInfo` 関数を実装 (APIキーは環境変数から取得)。
    -   [x] `LogilessOrderInfo` インターフェースを定義 (URL、ステータスを含む)。
    -   [x] エラーハンドリングを追加。
-   [x] **Channel.io API連携 (注文情報投稿):**
    -   [x] `supabase/functions/_shared/channelio.ts` ヘルパーを作成。
    -   [x] `sendChannelioPrivateMessage` 関数を実装 (APIキーは環境変数から取得、`private` オプション指定)。
    -   [x] エラーハンドリングを追加。
-   [x] **index.ts への統合 (注文情報):**
    -   [x] 注文番号抽出ロジックを組み込み。
    -   [x] 注文番号が見つかった場合に `getLogilessOrderInfo` を呼び出し。
    -   [x] Logiless情報が取得できた場合に `sendChannelioPrivateMessage` を呼び出し。
-   [x] **AIプロンプト拡張:** 取得したLogilessデータをプロンプトに追加。
-   [x] **Slack通知拡張:** Logiless注文URLをSlackメッセージに追加。
-   [x] **シークレット設定:** `LOGILESS_API_KEY`, `CHANNELIO_ACCESS_KEY`, `CHANNELIO_ACCESS_SECRET` をSupabase Secretsに追加。
-   [x] **単体テスト:**
    -   [x] 注文番号抽出 (`extractOrderNumber`) のテストを作成・実行 (`supabase/tests/unit/order_number_extractor.test.ts`)。
    -   [x] Logiless APIヘルパー (`getLogilessOrderInfo`) のテストを作成・実行 (`supabase/tests/unit/logiless.test.ts`)。
    -   [x] Channel.io APIヘルパー (`sendChannelioPrivateMessage`) のテストを作成・実行 (`supabase/tests/unit/channelio.test.ts`)。
-   [x] **統合テスト:**
    -   [x] Webhookハンドラー全体の統合テストを作成 (`supabase/tests/integration/webhook-handler.test.ts`)。
    -   [x] モックAPI (`supabase/tests/mocks/api-mocks.ts`) を実装。
    -   [x] 統合テストを実行し、問題を修正。
-   [ ] **デプロイと動作確認:**
    -   [ ] Supabase Edge Function をデプロイ。
    -   [ ] 実際のChannel.io Webhookで動作を確認。
    -   [ ] Logiless API/Channel.io API との連携を実環境で確認。
    -   [ ] エラーハンドリングと通知を実環境で確認。
-   [ ] **ドキュメント更新:** READMEや関連ドキュメントを更新。

## フェーズ2: AI回答案のChannel.ioへの投稿

-   [x] **目標:** AIが生成した回答案を、Slack通知に加えて、元のChannel.ioチャットスレッドにプライベートメッセージとして投稿する。
-   [x] **環境変数:**
    -   [x] `CHANNELIO_API_KEY` (または `CHANNELIO_ACCESS_KEY`) が設定されていることを確認。
    -   [x] (任意) `CHANNELIO_BOT_PERSON_ID` を設定し、`index.ts` で読み込む。
-   [x] **`_shared/channelio.ts` の `sendChannelioPrivateMessage` 関数更新:**
    -   [x] APIキー (`apiKey`) を引数で受け取るように修正。
    -   [x] `personId` を直接の引数で受け取るように修正。
    -   [x] `fetch` でChannel.io API (`POST /open/v5/user_chats/{chatId}/messages`) を呼び出すロジックを実装・確認。
    -   [x] ヘッダー (`Authorization: Bearer ${apiKey}`, etc.) とリクエストボディ (`message`, `options: ["private"]`, `personId`) を正しく設定。
    -   [x] エラーハンドリングを実装・確認 (`try...catch`, `response.ok`)。
-   [x] **`index.ts` への統合 (AI回答案投稿):**
    -   [x] `handleWebhook` 関数内で `aiResponse` 取得後に処理を追加。
    -   [x] `chatId` と `CHANNELIO_API_KEY` の存在を確認。
    -   [x] `sendChannelioPrivateMessage` を `await` で呼び出し、必要な引数 (`chatId`, `message`, `apiKey`, `personId`) を渡す。
    -   [x] 投稿成功/失敗時のログ出力を追加。
    -   [x] 投稿ステップ用の `try...catch` ブロックとエラー通知 (`notifyError`) を追加。
    -   [x] (修正済み) Logiless連携部分の古い関数呼び出しを修正。
-   [ ] **テスト:**
    -   [ ] Webhookをトリガーし、AI回答案がプライベートメッセージとして投稿されることを確認。
    -   [ ] `CHANNELIO_BOT_PERSON_ID` 設定時の動作を確認。
    -   [ ] エラーケースでのログ出力を確認。
-   [ ] **デプロイと動作確認:**
    -   [ ] Supabase Edge Function をデプロイ。
    -   [ ] デプロイ後のログを監視し、動作を確認。

## Yeni Auto Answer 拡張機能 (yeni-auto-answer-chrome-extension) (既存のマークに従う)

-   [x] **目標:** Chrome拡張機能として、Channel.ioのチャット画面上に動作コントロールUIを追加する。
-   [x] **マニフェスト設定:** `manifest.json` を設定 (permissions, content_scripts, background, action)。
-   [x] **コンテンツスクリプト:** Channel.io UIを操作するスクリプト (`content.js`) を作成。
    -   [x] チャット入力欄の取得。
    -   [x] 送信ボタンの取得。
    -   [x] UI要素（トグルスイッチ、ステータス表示）を挿入するDOM操作。
-   [x] **バックグラウンドスクリプト:** 状態管理と外部通信 (`background.js`)。
    -   [x] 拡張機能の有効/無効状態を `chrome.storage` で管理。
    -   [x] コンテンツスクリプトからのメッセージ受信。
    -   [ ] (将来) Supabase Function との連携（設定取得など）。
-   [x] **ポップアップUI:** 拡張機能アイコンクリック時のUI (`popup.html`, `popup.js`)。
    -   [x] 有効/無効を切り替えるトグルスイッチ。
    -   [x] 設定画面へのリンク（将来）。
-   [x] **UI実装:** トグルスイッチなどのUIコンポーネントを作成。
-   [x] **メッセージング:** コンテンツスクリプト、バックグラウンド、ポップアップ間の連携を `chrome.runtime.sendMessage`/`onMessage` で実装。
-   [ ] **テスト:** 拡張機能を実際に読み込み、Channel.io上で動作確認。
-   [ ] **パッケージ化と配布:** 拡張機能をパッケージ化。

---
最終更新: 2024-06-10 