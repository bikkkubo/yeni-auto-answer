# yeni-auto-v2

Channel.io からの問い合わせに対し、注文情報連携とAIによる回答案生成を行うSupabase Edge Functionです。

## 概要

このプロジェクトは、Channel.io の Webhook をトリガーとして起動する Supabase Edge Function です。主な目的は、顧客からの問い合わせに含まれる注文番号を基に外部システム（Logiless）から注文情報を取得し、オペレーターの対応を支援すること、および OpenAI を利用して問い合わせに対する回答案を自動生成することです。

## 機能

-   Channel.io Webhook の受信と処理
-   メッセージからの注文番号抽出 (例: `yeni-12345`)
-   Logiless API を利用した注文情報の取得 (注文ステータス, 詳細URLなど)
-   取得した注文情報を Channel.io の該当チャットへプライベートメッセージとして送信
-   OpenAI Embeddings API と Supabase pgvector を利用した関連ドキュメントのベクトル検索 (RAG - Retrieval)
-   OpenAI Chat Completions API を利用した回答案の生成 (RAG - Generation)
-   問い合わせ内容、Logiless情報、AI回答案を Slack へ通知
-   処理中のエラーを Slack のエラーチャンネルへ通知

## アーキテクチャ概要

```mermaid
graph LR
    A[Channel.io Webhook] --> B(Supabase Edge Function: channelio-webhook-handler);
    B -- 注文番号 --> C{Logiless API};
    C -- 注文情報 --> B;
    B -- プライベートメッセージ --> D[Channel.io API];
    B -- クエリ --> E{OpenAI Embeddings API};
    E -- Embedding --> B;
    B -- Embedding --> F[Supabase DB (pgvector)];
    F -- 関連文書 --> B;
    B -- プロンプト --> G{OpenAI Chat Completions API};
    G -- 回答案 --> B;
    B -- 通知 --> H[Slack API];
```

## セットアップ

### 1. 前提条件

-   Node.js と npm (または yarn)
-   Deno
-   Supabase CLI: `npm install -g supabase`
-   Supabase アカウントとプロジェクト
-   各種 API キー (OpenAI, Slack, Channel.io, Logiless)

### 2. リポジトリのクローン

```bash
git clone https://github.com/bikkkubo/yeni-auto-v2.git
cd yeni-auto-v2
```

### 3. Supabase プロジェクトとの連携

```bash
supabase login
supabase link --project-ref <your-project-ref> # プロジェクトIDをSupabaseダッシュボードで確認
```

### 4. データベースの準備

Supabase ダッシュボードの SQL Editor を使用して、以下の設定を行います。

1.  **pgvector 拡張機能の有効化:**
    ```sql
    CREATE EXTENSION IF NOT EXISTS vector;
    ```
2.  **documents テーブルの作成:** (ベクトルとメタデータを格納)
    ```sql
    -- 以前のチャット履歴や、提供されたSQLを参照してテーブルを作成してください
    CREATE TABLE documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content TEXT NOT NULL,
      question TEXT,
      source_type TEXT NOT NULL,
      embedding VECTOR(1536) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- 必要に応じて updated_at トリガーも作成
    ```
3.  **match_documents 関数の作成:** (ベクトル検索用)
    ```sql
    -- 以前のチャット履歴や、提供されたSQLを参照して関数を作成してください
    create or replace function match_documents (
      query_embedding vector(1536),
      match_threshold float,
      match_count int
    )
    returns table (...)
    language sql stable
    as $$
      -- 関数の本体を記述
    $$;
    ```

### 5. 環境変数の設定

プロジェクトルートに `.env.local` ファイルを作成し、以下の環境変数を設定します。`.env.example` ファイルがあれば、それをコピーして使用してください。

```dotenv
# Supabase (通常は自動リンクされるが、確認用)
# SUPABASE_URL=your_supabase_url
# SUPABASE_ANON_KEY=your_supabase_anon_key

# OpenAI
OPENAI_API_KEY=sk-...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C...
SLACK_ERROR_CHANNEL_ID=C...

# Channel.io
CHANNELIO_ACCESS_KEY=...
CHANNELIO_ACCESS_SECRET=...
# CHANNELIO_WEBHOOK_SECRET=... # (Optional, if webhook signature verification is implemented)

# Logiless
LOGILESS_API_KEY=...
```

設定後、Supabase Secrets に反映させます。

```bash
supabase secrets set --env-file .env.local
```

### 6. Edge Function のデプロイ

```bash
supabase functions deploy channelio-webhook-handler --no-verify-jwt
```

## ローカル開発

### テストの実行

```bash
cd supabase/tests
deno test --allow-read --allow-net --allow-env
```

### ローカルサーバーの起動

Docker が必要です。`.env.local` の環境変数を読み込ませて実行します。

```bash
supabase start # データベースなどをローカルで起動
supabase functions serve --env-file .env.local --no-verify-jwt
```

## API連携

-   **Logiless API:** 注文番号を基に注文詳細を取得します。APIキーが必要です。
-   **Channel.io API:** 注文情報をプライベートメッセージとして送信します。Access Key/Secretが必要です。
-   **OpenAI API:** Embedding生成とChat Completionに使用します。APIキーが必要です。
-   **Slack API:** 通知の送信に使用します。Bot Tokenが必要です。

## 注意点

-   APIキーは `.env.local` に記述し、Git にはコミットせず、`supabase secrets` で管理してください。
-   データベースのセットアップ（拡張機能、テーブル、関数）が正しく行われていることを確認してください。
-   (未実装) Channel.io Webhook の署名検証を実装することで、セキュリティを向上できます。

## 主要コンポーネント

### 1. Supabase Edge Function: `channelio-webhook-handler`

Channelioからのwebhookを受け取り、問い合わせ内容を処理してSlackに通知します。

- **場所**: `supabase/functions/channelio-webhook-handler/index.ts`
- **機能**:
  - Channelioからのwebhookリクエスト受信
  - 問い合わせ内容の抽出とベクトル化 (OpenAI Embeddings)
  - pgvectorを使った関連FAQ検索
  - カスタマイズされたプロンプトを使ったAI回答案の生成 (OpenAI Chat Completions)
  - Slackへの通知

### 2. ベクトル検索用データベース

FAQデータを検索可能な形で格納するSupabase PostgreSQLデータベース。

- **テーブル**: `documents`
- **フィールド**: `id`, `content`, `question`, `source_type`, `embedding`, `created_at`, `updated_at`
- **拡張機能**: `pgvector`

### 3. FAQインポートスクリプト

CSVファイルからFAQデータを読み込み、ベクトル化してデータベースに格納します。

- **場所**: `import_faq.ts`
- **実行方法**: `deno run --allow-read --allow-net --allow-env import_faq.ts`

## セットアップ方法

### 前提条件

- Supabaseアカウントとプロジェクト (DBに`pgvector`拡張が有効であること)
- OpenAI APIキー
- Slack Botトークンと通知用チャンネルID (通常用・エラー用)
- ChannelioアカウントとWebhook設定
- Deno (ローカル開発用: `brew install deno` or via official installer)
- Supabase CLI (`brew install supabase/tap/supabase` or `npm i -g supabase`)

### インストール手順

1. **リポジトリのクローン**:
   ```bash
   git clone https://github.com/bikkkubo/yeni-auto-answer.git
   cd yeni-auto-answer
   ```

2. **Supabase CLI ログインとリンク**:
   ```bash
   supabase login
   supabase link --project-ref <YOUR-PROJECT-REF>
   ```

3. **データベースのセットアップ**:
   - Supabase SQLエディタで `reset_documents_table.sql` の内容を実行します。

4. **環境変数の設定 (Supabase Secrets)**:
   - `supabase/.env` ファイルを作成または編集し、以下のキーと値を記述します。
     ```dotenv
     OPENAI_API_KEY=sk-...
     SLACK_BOT_TOKEN=xoxb-...
     SLACK_CHANNEL_ID=C...
     SLACK_ERROR_CHANNEL_ID=C...
     # SUPABASE_URL, SUPABASE_ANON_KEY は通常不要 (自動設定)
     ```
   - 以下のコマンドでSupabaseにSecretsを設定します。
     ```bash
     supabase secrets set --env-file ./supabase/.env
     ```
   - **重要:** `.gitignore` に `supabase/.env` が含まれていることを確認してください。

5. **Edge Functionのデプロイ**:
   ```bash
   supabase functions deploy channelio-webhook-handler --no-verify-jwt
   ```

6. **FAQデータのインポート**:
   - FAQ情報をCSVファイル (`yeni_faq.csv`) に整理します (ヘッダー行: `Question,Answer`)。
   - `import_faq.ts` ファイルを開き、`OPENAI_API_KEY` と `SUPABASE_KEY` (Service Role Key) を実際の値に更新します。
   - スクリプトを実行:
     ```bash
     deno run --allow-read --allow-net --allow-env import_faq.ts
     ```

7. **Channelio Webhook設定**:
   - Channelioの管理画面 > Webhook管理 でWebhookを作成または編集します。
   - URLにデプロイされたSupabase Functionのエンドポイント (`https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/channelio-webhook-handler`) を指定します。
   - トリガーしたいイベント（例: 新規接客チャットの受信時）を選択します。

## ファイル説明

- `supabase/functions/channelio-webhook-handler/index.ts`: メインのWebhook処理を行うEdge Function。
- `supabase/functions/_shared/cors.ts`: CORS設定用の共有ファイル。
- `import_faq.ts`: ローカルで実行するFAQインポート用Denoスクリプト。
- `reset_documents_table.sql`: `documents`テーブルと`match_documents`関数を準備するSQL。
- `README_FAQ_IMPORT.md`: FAQインポートスクリプトの詳細な手順。
- `README.md`: 本ファイル（プロジェクト全体の説明）。
- `yeni_faq.csv`: FAQデータのサンプル（実際のデータに置き換えてください）。
- `.gitignore`: Gitで追跡しないファイル（`.env`など）を指定。

## 使用技術

- **言語/ランタイム**: TypeScript, Deno
- **プラットフォーム**: Supabase (Edge Functions, Database, Auth, Secrets)
- **データベース**: PostgreSQL + `pgvector`拡張
- **AI**: OpenAI API (Embeddings API, Chat Completions API)
- **外部連携**: Channelio (Webhook), Slack (API)

## 注意事項

- OpenAI APIの使用にはコストが発生します。料金体系を確認してください。
- Supabaseのプランによっては、Functionの実行時間やDBリソースに制限があります。
- APIキーやトークンなどの機密情報は、`.env`ファイルに記述し、絶対にGitリポジトリにコミットしないでください。

## ライセンス

[ライセンス情報を記述] 