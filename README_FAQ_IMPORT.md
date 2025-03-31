# FAQ データベクトル化と Supabase への格納手順

このプロジェクトは、FAQデータ（質問と回答のペア）をベクトル化し、Supabase データベースに格納するツールを提供します。これにより、Channelio からの問い合わせに対して、関連性の高い FAQ 情報を元に AI が回答を生成できるようになります。

## 事前準備

1. **OpenAI API キーの取得**:
   - [OpenAI のウェブサイト](https://platform.openai.com/) からアカウントを作成し、API キーを取得してください。

2. **Supabase のアクセス情報を取得**:
   - Supabase プロジェクトの URL
   - Supabase の Service Role Key（または十分な権限を持つ API キー）

3. **Deno のインストール**:
   ```bash
   # macOS（Homebrew）
   brew install deno
   
   # または Windows（Chocolatey）
   choco install deno
   ```

## 使用方法

### 1. データベーステーブルの準備

`reset_documents_table.sql` ファイルに含まれる SQL を Supabase の SQL エディターで実行し、必要なテーブルとベクトル検索用の関数を作成します。

1. [Supabase ダッシュボード](https://supabase.com/dashboard/) にログイン
2. プロジェクトを選択 → 「SQL エディター」をクリック
3. `reset_documents_table.sql` の内容をコピーしてエディターに貼り付け
4. 「Run」ボタンをクリックして実行

### 2. スクリプトの設定

`import_faq.ts` ファイルを開き、以下の変数を実際の値に更新します:

```typescript
const OPENAI_API_KEY = "sk-..."; // あなたの OpenAI API キー
const SUPABASE_URL = "https://hwvtkmnbrtvxmxpwigjq.supabase.co"; // あなたの Supabase プロジェクト URL
const SUPABASE_KEY = "..."; // あなたの Supabase Service Role Key
```

### 3. スクリプトの実行

ターミナルで以下のコマンドを実行して、FAQデータをベクトル化し Supabase に格納します:

```bash
deno run --allow-read --allow-net --allow-env import_faq.ts
```

必要なパーミッションが要求されたら許可してください。

### 4. 確認

スクリプトの実行が完了したら、Supabase ダッシュボードの「Table Editor」で `documents` テーブルを確認し、データが正しく挿入されていることを確認してください。

## トラブルシューティング

- **CSVファイル読み込みエラー**: `yeni_faq.csv` が正しい形式（"Question"列と"Answer"列を持つ）であることを確認してください。
- **OpenAI API エラー**: API キーが正しいこと、および API の利用制限に達していないことを確認してください。
- **Supabase 接続エラー**: URL と API キーが正しいこと、およびテーブルが正しく作成されていることを確認してください。

## 注意点

- 大量のデータを一度に処理するとAPIレート制限に達する可能性があります。その場合は `BATCH_SIZE` の値を小さくしてください。
- ベクトル検索は OpenAI の Embeddings API を使用しています。これにはAPI利用料金が発生します。 