// import_faq.ts - FAQをCSVから読み込みベクトル化してSupabaseに格納するスクリプト
import { parse as csvParse } from "https://deno.land/std@0.177.0/encoding/csv.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 設定 - 実行前に環境に合わせて修正してください
const OPENAI_API_KEY = "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"; // OpenAI APIキーを入力
const SUPABASE_URL = "https://hwvtkmnbrtvxmxpwigjq.supabase.co"; // SupabaseプロジェクトのURL
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3dnRrbW5icnR2eG14cHdpZ2pxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0Mjg5MjIyNywiZXhwIjoyMDU4NDY4MjI3fQ.tPky06nkySWgRvcGzgyZ5N1VXbE2tUzZjkQ0cyaSH-Y"; // SupabaseのService Role Key（または十分な権限を持つキー）
const CSV_FILE_PATH = "./yeni_faq.csv"; // プロジェクトルートにあるCSVファイルのパス
const EMBEDDING_MODEL = "text-embedding-3-small"; // OpenAIのEmbeddingsモデル
const BATCH_SIZE = 10; // 一度に処理するCSVの行数（APIレート制限に応じて調整）

// Supabaseクライアントの初期化
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ファイルからCSVを読み込む関数
async function readCSV(filePath: string): Promise<Array<{ Question: string; Answer: string }>> {
  try {
    const text = await Deno.readTextFile(filePath);
    const result = await csvParse(text, {
      skipFirstRow: true, // ヘッダー行をスキップ
      columns: ["Question", "Answer"]    // 列名指定
    });
    return result;
  } catch (error) {
    console.error("CSVファイルの読み込みに失敗しました:", error);
    throw error;
  }
}

// テキストのベクトル化（OpenAI Embeddings API）
async function getEmbedding(text: string): Promise<number[]> {
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        input: text,
        model: EMBEDDING_MODEL
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI API error: ${JSON.stringify(error)}`);
    }

    const result = await response.json();
    return result.data[0].embedding;
  } catch (error) {
    console.error("ベクトル化に失敗しました:", error);
    throw error;
  }
}

// FAQデータをSupabaseに挿入
async function insertFAQ(faqs: Array<{ Question: string; Answer: string; embedding: number[] }>) {
  try {
    const { error } = await supabase.from("documents").insert(
      faqs.map(faq => ({
        content: faq.Answer,
        question: faq.Question,
        source_type: "faq",
        embedding: faq.embedding
      }))
    );
    
    if (error) {
      throw error;
    }
    
    console.log(`${faqs.length}件のFAQを挿入しました`);
  } catch (error) {
    console.error("Supabaseへの挿入に失敗しました:", error);
    throw error;
  }
}

// メイン処理
async function main() {
  try {
    // CSVファイルを読み込む
    console.log(`CSVファイル ${CSV_FILE_PATH} を読み込んでいます...`);
    const faqs = await readCSV(CSV_FILE_PATH);
    console.log(`${faqs.length}件のFAQを読み込みました`);

    // バッチ処理でベクトル化と挿入を行う
    for (let i = 0; i < faqs.length; i += BATCH_SIZE) {
      const batch = faqs.slice(i, i + BATCH_SIZE);
      console.log(`バッチ処理: ${i+1}〜${Math.min(i+BATCH_SIZE, faqs.length)}件目 (全${faqs.length}件中)`);
      
      // 各FAQをベクトル化
      const processedBatch = await Promise.all(
        batch.map(async (faq) => {
          // FAQの回答テキストをベクトル化（必要に応じて質問も含める）
          const embedding = await getEmbedding(faq.Answer);
          return {
            ...faq,
            embedding
          };
        })
      );
      
      // ベクトル化したデータをSupabaseに挿入
      await insertFAQ(processedBatch);
      
      // APIレート制限に配慮して少し待機
      if (i + BATCH_SIZE < faqs.length) {
        console.log("APIレート制限に配慮して待機中...");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log("すべてのFAQデータの処理が完了しました！");
  } catch (error) {
    console.error("エラーが発生しました:", error);
    Deno.exit(1);
  }
}

// スクリプトを実行
main();