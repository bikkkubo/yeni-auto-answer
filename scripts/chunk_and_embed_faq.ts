import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4.47.1";
import { dirname, fromFileUrl, join } from "https://deno.land/std@0.224.0/path/mod.ts";

// --- 設定 ---
// const CSV_FILE_PATH = "../yeni_faq.csv"; // 古い定義 (コメントアウトまたは削除)
const EMBEDDING_MODEL = "text-embedding-ada-002";
const SUPABASE_TABLE_NAME = "faq_chunks";
const BATCH_SIZE = 50; // OpenAI API呼び出しとSupabase挿入のバッチサイズ

// --- 環境変数の読み込み ---
// スクリプト自身のディレクトリを取得
const scriptDir = dirname(fromFileUrl(import.meta.url));
// プロジェクトルートにある .env ファイルへのパスを構築
const envPath = join(scriptDir, "../.env");

// CSVファイルへのパスを構築 (変更箇所)
const CSV_FILE_PATH = join(scriptDir, "../yeni_faq.csv");
console.log(`Using CSV file path: ${CSV_FILE_PATH}`); // パス確認ログ追加

console.log(`Attempting to load .env file from: ${envPath}`); // デバッグログ追加

try {
    // .env ファイルを読み込み、Deno.env に設定する
    await load({ export: true, envPath: envPath });
    console.log(".env file loaded successfully (if it exists)."); // デバッグログ追加
} catch (error) {
    console.error(`Error loading .env file from ${envPath}:`, error); // エラーログ追加
}

// Deno.env から直接取得する
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// --- デバッグ用ログ追加 ---
console.log("--- 環境変数デバッグ (Deno.env.get) ---");
console.log("OPENAI_API_KEY:", OPENAI_API_KEY ? '設定あり' : '未設定');
console.log("SUPABASE_URL:", SUPABASE_URL ? '設定あり' : '未設定');
console.log("SUPABASE_SERVICE_ROLE_KEY:", SUPABASE_SERVICE_ROLE_KEY ? '設定あり' : '未設定');
console.log("----------------------");

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "エラー: 必要な環境変数が設定されていません (OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)",
  );
  Deno.exit(1);
}

// --- クライアント初期化 ---
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    // Service Role Keyを使用するため、自動リフレッシュ等を無効化
    autoRefreshToken: false,
    persistSession: false,
  }
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// --- 型定義 ---
interface FaqRecord {
  Question: string;
  Answer: string;
}

interface Chunk {
  question: string;
  content: string;
}

interface ChunkWithEmbedding extends Chunk {
    embedding: number[];
}

// --- チャンキング関数 ---
function chunkFaq(faq: FaqRecord): Chunk[] {
  const question = faq.Question.trim();
  const answer = faq.Answer.trim();
  const chunks: Chunk[] = [];

  // 回答を段落（空行または改行）で分割
  // CSVファイル内の改行文字に合わせて調整が必要な場合あり ('\n' or '\n\n')
  const paragraphs = answer.split(/\n\n/).map(p => p.trim()).filter(p => p.length > 0);

  if (paragraphs.length === 0 && answer.length > 0) {
      // 区切り文字がなく、回答が1つの塊の場合
      paragraphs.push(answer);
  }

  if (paragraphs.length > 0) {
    // 基本チャンク: 質問 + 回答の最初の段落
    chunks.push({
      question: question,
      content: `${question}
${paragraphs[0]}`, // 質問と回答を結合
    });

    // 追加チャンク: 回答の2段落目以降
    for (let i = 1; i < paragraphs.length; i++) {
      chunks.push({
        question: question, // 元の質問を保持
        content: paragraphs[i],
      });
    }
  } else if (question.length > 0) {
    // 回答がない場合でも質問だけはチャンクにする（必要に応じて）
     chunks.push({
       question: question,
       content: question,
     });
  }

  return chunks;
}

// --- Embedding取得関数 ---
async function getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
        const response = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: texts,
        });
        return response.data.map((item) => item.embedding);
    } catch (error) {
        console.error("OpenAI Embedding APIエラー:", error);
        // エラー処理: リトライ、一部失敗など考慮が必要だが、ここではシンプルにエラーを投げる
        throw error;
    }
}


// --- メイン処理 ---
async function main() {
  console.log("--- FAQチャンキング＆ベクトル化スクリプト開始 ---");

  // 1. CSVファイルの読み込み
  console.log(`CSVファイルを読み込み中: ${CSV_FILE_PATH}`);
  let fileContent: string;
  try {
      fileContent = await Deno.readTextFile(CSV_FILE_PATH);
  } catch (error) {
      console.error(`エラー: CSVファイル '${CSV_FILE_PATH}' が見つからないか、読み込めません。`);
      console.error(error);
      Deno.exit(1);
  }

  // BOM除去 (必要な場合)
  if (fileContent.charCodeAt(0) === 0xFEFF) {
    fileContent = fileContent.slice(1);
  }

  const records: FaqRecord[] = parse(fileContent, {
    header: true, // ヘッダー行をキーとして使用
    skipFirstRow: true, // ヘッダー行をスキップ
  }) as FaqRecord[];

  console.log(`読み込み完了: ${records.length} 件のFAQ`);

  // 2. チャンキング処理
  console.log("チャンキング処理を開始...");
  const allChunks: Chunk[] = [];
  for (const record of records) {
    if (record.Question && record.Answer) { // QuestionとAnswerが存在する行のみ処理
      const chunks = chunkFaq(record);
      allChunks.push(...chunks);
    } else {
        console.warn("警告: QuestionまたはAnswerが空の行をスキップしました:", record);
    }
  }
  console.log(`チャンキング完了: ${allChunks.length} 個のチャンクを生成`);

  // 3. ベクトル化とDB挿入 (バッチ処理)
  console.log("ベクトル化とSupabaseへの挿入を開始 (バッチ処理)...");
  let insertedCount = 0;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batchChunks = allChunks.slice(i, i + BATCH_SIZE);
    const contentsToEmbed = batchChunks.map(chunk => chunk.content);

    console.log(`  バッチ ${Math.floor(i / BATCH_SIZE) + 1}: ${batchChunks.length}個のチャンクを処理中...`);

    // ベクトル化
    let embeddings: number[][] = [];
    try {
        embeddings = await getEmbeddings(contentsToEmbed);
    } catch (error) {
        console.error(`  バッチ ${Math.floor(i / BATCH_SIZE) + 1} のベクトル化中にエラーが発生しました。このバッチをスキップします。`);
        continue; // エラーが発生したバッチはスキップ（あるいはリトライ処理を追加）
    }


    if (embeddings.length !== batchChunks.length) {
        console.error(`  エラー: 取得したEmbeddingの数 (${embeddings.length}) がチャンク数 (${batchChunks.length}) と一致しません。`);
        continue;
    }

    const dataToInsert = batchChunks.map((chunk, index) => ({
      question: chunk.question,
      content: chunk.content,
      embedding: embeddings[index],
    }));

    // Supabaseへ挿入
    try {
      const { error: insertError } = await supabase
        .from(SUPABASE_TABLE_NAME)
        .insert(dataToInsert);

      if (insertError) {
        console.error(`  Supabase挿入エラー (バッチ ${Math.floor(i / BATCH_SIZE) + 1}):`, insertError);
        // 詳細なエラーハンドリングが必要な場合あり
      } else {
        insertedCount += batchChunks.length;
        console.log(`  バッチ ${Math.floor(i / BATCH_SIZE) + 1}: ${batchChunks.length}個のチャンクを挿入完了`);
      }
    } catch (error) {
      console.error(`  Supabase接続または予期せぬエラー (バッチ ${Math.floor(i / BATCH_SIZE) + 1}):`, error);
    }

    // APIレートリミット対策（必要に応じてウェイトを入れる）
    // await new Promise(resolve => setTimeout(resolve, 1000)); // 例: 1秒待機
  }

  console.log("--- 処理完了 ---");
  console.log(`合計 ${insertedCount} / ${allChunks.length} 個のチャンクをDBに挿入しました。`);
}

// スクリプト実行
main().catch((err) => {
  console.error("スクリプト実行中に予期せぬエラーが発生しました:", err);
  Deno.exit(1);
}); 