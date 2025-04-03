import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { getLogilessOrderInfo, type LogilessOrderInfo } from "../_shared/logiless.ts";
import { sendChannelioPrivateMessage } from "../_shared/channelio.ts";

// --- 定数定義 ---
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
const SLACK_CHANNEL_ID = Deno.env.get("SLACK_CHANNEL_ID");
const SLACK_ERROR_CHANNEL_ID = Deno.env.get("SLACK_ERROR_CHANNEL_ID");
const LOGILESS_API_KEY = Deno.env.get("LOGILESS_API_KEY");
const CHANNELIO_ACCESS_KEY = Deno.env.get("CHANNELIO_ACCESS_KEY");
const CHANNELIO_ACCESS_SECRET = Deno.env.get("CHANNELIO_ACCESS_SECRET");
const CHANNELIO_BOT_PERSON_ID = Deno.env.get("CHANNELIO_BOT_PERSON_ID"); // Fetch Bot Person ID
const SLACK_THREAD_EXPIRY_HOURS = 48; // Slackスレッドの有効時間（時間）

// 注文番号抽出用の正規表現
const ORDER_NUMBER_PATTERN = /(?:#)?yeni-\d+/i;

const EMBEDDING_MODEL = "text-embedding-3-small";
const COMPLETION_MODEL = "gpt-3.5-turbo";
const MATCH_THRESHOLD = 0.7; // ベクトル検索の類似度閾値 (調整可能)
const MATCH_COUNT = 3; // ベクトル検索の取得件数
const RPC_FUNCTION_NAME = "match_documents"; // SupabaseのRPC関数名

// --- Supabase クライアント初期化 ---
// SERVICE_ROLE_KEY が必要
let supabase: SupabaseClient;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        // RLSをバイパスする場合や、サーバーサイドでの操作にはSERVICE_ROLE_KEYが適している
        // 必要に応じてオプションを追加
        auth: {
             persistSession: false, // サーバーサイドではセッション永続化不要
             autoRefreshToken: false,
        }
    });
    console.log("Supabase client initialized with Service Role Key.");
} else {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Supabase client could not be initialized.");
    // 起動時にエラーにするか、フォールバック処理を行うか検討
    // throw new Error("Missing Supabase credentials.");
}

// --- 型定義 ---
interface ChannelioEntity {
    plainText: string;
    personId?: string;
    personType?: 'user' | 'manager' | 'bot';
    chatId?: string;
    id?: string;
    // 他に必要なentity内のフィールドがあれば追加
}

interface ChannelioUserChat {
    id: string;
    state?: 'opened' | 'closed';
    userId?: string;
    // 他に必要なuserChat内のフィールドがあれば追加
}

interface ChannelioUser {
    id: string;
    name?: string;
    // 他に必要なuser内のフィールドがあれば追加
}

interface ChannelioRefers {
    userChat?: ChannelioUserChat;
    user?: ChannelioUser;
    // 他に必要なrefers内のオブジェクトがあれば追加
}

interface ChannelioWebhookPayload {
    entity: ChannelioEntity;
    refers?: ChannelioRefers;
    event?: string;
    type?: string;
    // 他のトップレベルフィールドがあれば追加
}

interface SlackThreadInfo {
  channelio_chat_id: string;
  slack_thread_ts: string;
  expires_at: string; // ISO 8601 format
}

interface Document {
    content: string;
    source_type?: string;
    question?: string;
    // 他のフィールドがあれば追加
}

// --- Slack Thread Store 操作関数 (Supabase) ---

/**
 * 指定されたChannel.ioチャットIDに紐づく、有効期限内のSlackスレッドタイムスタンプを取得する
 * @param chatId Channel.ioのチャットID (userChat.id または entity.chatId)
 * @returns 有効なタイムスタンプ(string)、見つからない/期限切れの場合はnull
 */
async function getActiveThreadTs(chatId: string): Promise<string | null> {
  if (!supabase) {
    console.error("Supabase client is not initialized. Cannot get thread ts.");
    return null;
  }
  try {
      const { data, error } = await supabase
        .from('slack_thread_store')
        .select('slack_thread_ts')
        .eq('channelio_chat_id', chatId)
        .gt('expires_at', new Date().toISOString()) // 有効期限をチェック
        .maybeSingle(); // 結果が1件または0件の場合に対応

      if (error) {
        // PGRST116は 'No rows found' なので無視してよい
        if (error.code !== 'PGRST116') {
            console.error(`Error fetching thread ts for chatId ${chatId}:`, error);
             await notifyError("GetActiveThreadTs", error, { userId: chatId }); // エラー通知
        }
        return null; // エラーの場合もnullを返す
      }
      return data?.slack_thread_ts ?? null;

  } catch (e) {
      console.error(`Unexpected error in getActiveThreadTs for chatId ${chatId}:`, e);
      await notifyError("GetActiveThreadTs Unexpected", e, { userId: chatId });
      return null;
  }
}

/**
 * Channel.ioチャットIDとSlackスレッドタイムスタンプを有効期限付きで保存（または更新）する
 * @param chatId Channel.ioのチャットID
 * @param threadTs 保存するSlackスレッドタイムスタンプ
 */
async function saveThreadTs(chatId: string, threadTs: string): Promise<void> {
  if (!supabase) {
    console.error("Supabase client is not initialized. Cannot save thread ts.");
    return;
  }
  try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + SLACK_THREAD_EXPIRY_HOURS);

      const { error } = await supabase
        .from('slack_thread_store')
        .upsert({
          channelio_chat_id: chatId,
          slack_thread_ts: threadTs,
          expires_at: expiresAt.toISOString(),
        }, { onConflict: 'channelio_chat_id' }); // channelio_chat_id が重複したら更新

      if (error) {
        console.error(`Error saving thread ts for chatId ${chatId}:`, error);
        await notifyError("SaveThreadTs", error, { userId: chatId });
      } else {
        console.log(`Saved/Updated thread ts ${threadTs} for chatId ${chatId}`);
      }
  } catch (e) {
       console.error(`Unexpected error in saveThreadTs for chatId ${chatId}:`, e);
       await notifyError("SaveThreadTs Unexpected", e, { userId: chatId });
  }
}

/**
 * (任意) 指定されたChannel.ioチャットIDに紐づくスレッド情報を削除する
 * @param chatId Channel.ioのチャットID
 */
async function deleteThreadTs(chatId: string): Promise<void> {
    if (!supabase) {
        console.error("Supabase client is not initialized. Cannot delete thread ts.");
        return;
    }
    try {
        const { error } = await supabase
            .from('slack_thread_store')
            .delete()
            .eq('channelio_chat_id', chatId);

        if (error) {
            console.error(`Error deleting thread ts for chatId ${chatId}:`, error);
             await notifyError("DeleteThreadTs", error, { userId: chatId });
        } else {
             console.log(`Deleted thread ts mapping for chatId ${chatId}`);
        }
    } catch (e) {
        console.error(`Unexpected error in deleteThreadTs for chatId ${chatId}:`, e);
        await notifyError("DeleteThreadTs Unexpected", e, { userId: chatId });
    }
}

// --- ヘルパー関数: Slack通知 ---
async function postToSlack(channel: string, text: string, blocks?: any[], threadTs?: string): Promise<string | undefined> {
    if (!SLACK_BOT_TOKEN) {
        console.error("SLACK_BOT_TOKEN is not set.");
        // エラー通知チャンネルにも通知できない可能性があるため、コンソール出力に留める
        return undefined;
    }
    try {
        const payload: { channel: string; text: string; blocks?: any[] } = {
            channel: channel,
            text: text, // フォールバック用テキスト
        };
        if (blocks) {
            payload.blocks = blocks;
        }

        // threadTs が指定されていれば、ペイロードに追加
        if (threadTs) {
            (payload as any).thread_ts = threadTs; // Slack APIの型に合わせて追加
        }

        const response = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error(`Failed to post message to Slack channel ${channel}: ${response.status} ${response.statusText}`, errorData);
            // ここでさらにエラー通知を試みることもできるが、ループを防ぐため注意
            return undefined; // エラー時はundefinedを返す
        } else {
            const data = await response.json();
            if (!data.ok) {
                 console.error(`Slack API Error: ${data.error}`);
                 return undefined; // エラー時はundefinedを返す
            } else {
                 // 成功した場合、メッセージのタイムスタンプ(ts)を返す
                 console.log(`Message posted successfully to ${channel}${threadTs ? ` (thread: ${threadTs})` : ''}. ts: ${data.ts}`);
                 return data.ts as string;
            }
        }
    } catch (error) {
        console.error(`Error posting to Slack channel ${channel}:`, error);
        // ここでエラー通知を呼ぶことも検討
        await notifyError("PostToSlack", error, { userId: `Channel: ${channel}` });
        return undefined; // エラー時はundefinedを返す
    }
}

// --- ヘルパー関数: エラー通知 ---
async function notifyError(step: string, error: any, context: { query?: string; userId?: string }) {
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    const fallbackText = `:warning: Channelio 自動応答エラー発生 (${step})`;

    if (SLACK_ERROR_CHANNEL_ID) {
         // Block Kit を使う場合はこちらを調整
         await postToSlack(SLACK_ERROR_CHANNEL_ID, fallbackText, [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": ":warning: Channelio 自動応答エラー",
                    "emoji": true
                }
            },
            {
                "type": "section",
                "fields": [
                    { "type": "mrkdwn", "text": `*発生日時:*\n${new Date().toLocaleString('ja-JP')}` },
                    { "type": "mrkdwn", "text": `*発生箇所:*\n${step}` }
                ]
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `*エラーメッセージ:*\n\`\`\`${errorMessage}\`\`\``
                }
            },
            ...(stack ? [{
                "type": "section",
                "text": { "type": "mrkdwn", "text": `*スタックトレース:*\n\`\`\`${stack}\`\`\`` }
            }] : []),
             {
                "type": "section",
                "fields": [
                     { "type": "mrkdwn", "text": `*Query:*\n${context.query ?? 'N/A'}` },
                     { "type": "mrkdwn", "text": `*UserID:*\n${context.userId ?? 'N/A'}` }
                ]
            },
             { "type": "divider" }
        ]);
    } else {
        // SlackエラーチャンネルIDがない場合はコンソールに出力
        const logMessage = `\nError Timestamp: ${timestamp}\nError Step: ${step}\nError Message: ${errorMessage}\nStack Trace: ${stack ?? 'N/A'}\nQuery: ${context.query ?? 'N/A'}\nUserID: ${context.userId ?? 'N/A'}\n`;
        console.error("SLACK_ERROR_CHANNEL_ID is not set. Error details:", logMessage);
    }
}

// 注文番号抽出関数
export function extractOrderNumber(text: string): string | null {
    if (!text) return null;
    const match = text.match(ORDER_NUMBER_PATTERN);
    return match ? match[0].replace('#', '') : null;
}

// --- メイン処理関数 ---
export async function handleWebhook(payload: ChannelioWebhookPayload) {
    // --- デバッグ用ログ追加 ---
    console.log(`Received webhook. Event: ${payload.event}, Type: ${payload.type}, Entity PersonType: ${payload.entity?.personType}, PersonId: ${payload.entity?.personId}, ChatId: ${payload.entity?.chatId}`);
    // --- デバッグ用ログここまで ---

    // 正しい場所から情報を抽出 - chatIdの抽出元を明確にする
    const query = payload.entity?.plainText;
    const customerName = payload.refers?.user?.name;
    // Channelioのチャットへのリンクはペイロードから直接生成は難しいことが多い
    // 例: const chatLink = `https://<your-channelio-domain>.channel.io/user-chats/${payload.refers?.userChat?.id}`;
    const chatLink = undefined; // 必要ならドメイン等を設定して生成
    const senderPersonId = payload.entity?.personId;
    const senderPersonType = payload.entity?.personType;
    const channelioChatId = payload.entity?.chatId;

    let step = "Initialization"; // 現在の処理ステップを追跡
    let orderInfo: LogilessOrderInfo | null = null;

    try {
        // --- Botメッセージの早期処理 ---
        if (senderPersonType === 'bot') {
            step = "HandleBotMessage";
            // --- デバッグ用ログ追加 ---
            console.log(`[${step}] Condition senderPersonType === 'bot' is TRUE. Entering bot handling block.`);
            // --- デバッグ用ログここまで ---
            console.log(`[${step}] Received message from bot (${senderPersonId}). Skipping AI processing.`);

            if (!channelioChatId) {
                console.warn(`[${step}] Missing chatId for bot message. Cannot post to thread.`);
                return; // chatIdがないとスレッド投稿できない
            }
            if (!query) {
                console.warn(`[${step}] Missing plainText for bot message.`);
                return; // メッセージ内容がない
            }

            // 既存のスレッドを探す
            const existingThreadTs = await getActiveThreadTs(channelioChatId);

            if (!existingThreadTs) {
                // botからのメッセージがスレッドの起点になることは通常想定しない
                // もしスレッドが存在しない場合、botメッセージは無視するか、エラー通知するか検討
                console.warn(`[${step}] No active thread found for chatId ${channelioChatId}. Ignoring bot message.`);
                return;
            }

            // Slackにbotのメッセージを投稿
            const botMessageText = `[Bot]: ${query}`;
            const fallbackText = `[Bot]: ${query.substring(0, 50)}...`;
            const postedTs = await postToSlack(SLACK_CHANNEL_ID, fallbackText, [{ type: "section", text: { type: "mrkdwn", text: botMessageText } }], existingThreadTs);

            if (postedTs) {
                console.log(`[${step}] Posted bot message to thread ${existingThreadTs}`);
                // スレッドの有効期限を更新
                await saveThreadTs(channelioChatId, existingThreadTs);
            }

            // --- デバッグ用ログ追加 ---
            console.log(`[${step}] Finishing bot handling block. Returning early.`);
            // --- デバッグ用ログここまで ---
            // botメッセージの処理はここで完了
            return;
        }
        // --- Botメッセージ処理ここまで ---

        // --- 以下、ユーザー/マネージャーからのメッセージ処理 ---
        step = "HandleUserMessage"; // ステップ名を変更

        // channelioChatId の存在チェックを追加
        if (!channelioChatId) {
            console.warn("Missing 'entity.chatId' in payload. Cannot manage thread.", payload);
            // スレッド管理できないが、通知自体は試みるか、エラーにするか検討。
            // ここでは警告ログのみとし、処理を続ける (スレッド化はされない)
            // return; // もしchatIdがない場合は処理を中断するならコメント解除
        }

        // query の存在チェックを修正
        if (!query || typeof query !== 'string' || query.trim() === '') {
            const error = new Error("Missing or invalid 'plainText' in request body entity.");
            console.error("Missing or invalid 'plainText' in request body entity:", payload);
            await notifyError(step, error, { query, userId: channelioChatId });
            throw error;
        }

        // 必須環境変数のチェック
        // --- デバッグログ追加 ---
        console.log(`Checking env vars before validation: LOGILESS_API_KEY=${Deno.env.get("LOGILESS_API_KEY")}, CHANNELIO_ACCESS_KEY=${Deno.env.get("CHANNELIO_ACCESS_KEY")}, CHANNELIO_ACCESS_SECRET=${Deno.env.get("CHANNELIO_ACCESS_SECRET")}`);
        // --- デバッグログ追加ここまで ---
        if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID || !SLACK_ERROR_CHANNEL_ID || !LOGILESS_API_KEY || !CHANNELIO_ACCESS_KEY || !CHANNELIO_ACCESS_SECRET) {
            const missingVars = [
                !OPENAI_API_KEY && "OPENAI_API_KEY",
                !SUPABASE_URL && "SUPABASE_URL",
                !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY", // Check for service role key
                !SLACK_BOT_TOKEN && "SLACK_BOT_TOKEN",
                !SLACK_CHANNEL_ID && "SLACK_CHANNEL_ID",
                !SLACK_ERROR_CHANNEL_ID && "SLACK_ERROR_CHANNEL_ID",
                !LOGILESS_API_KEY && "LOGILESS_API_KEY",
                !CHANNELIO_ACCESS_KEY && "CHANNELIO_ACCESS_KEY",
                !CHANNELIO_ACCESS_SECRET && "CHANNELIO_ACCESS_SECRET",
            ].filter(Boolean).join(", ");
            const error = new Error(`Missing required environment variables: ${missingVars}. Please check Supabase Function Secrets.`);
            await notifyError(step, error, { query, userId: channelioChatId }); // userIdとしてchatIdを使用
            throw error;
        }

        // 注文番号の抽出
        step = "OrderNumberExtraction";
        const extractedOrderNumber = extractOrderNumber(query);
        console.log(`[${step}] 抽出された注文番号: ${extractedOrderNumber ?? 'なし'}`);

        // 注文情報の取得とプライベートメッセージの送信
        if (extractedOrderNumber && channelioChatId) {
            step = "LogilessAPI";
            console.log(`[${step}] Logiless APIを呼び出し中...`);
            orderInfo = await getLogilessOrderInfo(extractedOrderNumber, LOGILESS_API_KEY);

            if (orderInfo?.url) {
                step = "ChannelioAPI";
                console.log(`[${step}] Channel.io APIを呼び出し中...`);
                const message = `注文情報が見つかりました。\n注文番号: ${extractedOrderNumber}\n注文ステータス: ${orderInfo.status ?? '不明'}\n注文詳細: ${orderInfo.url}`;
                
                const success = await sendChannelioPrivateMessage(
                    channelioChatId, 
                    message, 
                    { accessKey: CHANNELIO_ACCESS_KEY, accessSecret: CHANNELIO_ACCESS_SECRET }
                );
                if (!success) {
                    console.error(`[${step}] プライベートメッセージの送信に失敗しました`);
                }
            }
        }

        // --- ここから変更: 既存スレッドの確認 ---
        step = "CheckExistingThread";
        let existingThreadTs: string | null = null;
        if (channelioChatId) {
             console.log(`[${step}] Checking for active thread for chatId: ${channelioChatId}...`);
             existingThreadTs = await getActiveThreadTs(channelioChatId);
             if (existingThreadTs) {
                 console.log(`[${step}] Found active thread ts: ${existingThreadTs}`);
             } else {
                 console.log(`[${step}] No active thread found. A new thread will be started.`);
             }
        } else {
            console.log(`[${step}] Skipping thread check due to missing chatId.`);
        }
        // --- ここまで変更 ---

        // 4. ベクトル化
        step = "Vectorization";
        console.log(`[${step}] Generating embedding for query: "${query}"`);
        const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                input: query,
                model: EMBEDDING_MODEL,
            }),
        });

        if (!embeddingResponse.ok) {
            const errorData = await embeddingResponse.json();
            console.error(`[${step}] OpenAI Embeddings API Error (${embeddingResponse.status}):`, JSON.stringify(errorData));
            throw new Error(`OpenAI Embeddings API request failed: ${embeddingResponse.status} ${embeddingResponse.statusText}`);
        }

        const embeddingData = await embeddingResponse.json();
        // APIレスポンスの構造が変わる可能性を考慮
        if (!embeddingData.data || !embeddingData.data[0] || !embeddingData.data[0].embedding) {
             console.error(`[${step}] Unexpected OpenAI Embeddings API response structure:`, embeddingData);
             throw new Error("Failed to extract embedding from OpenAI API response.");
        }
        const queryEmbedding = embeddingData.data[0].embedding;
        console.log(`[${step}] Embedding generated successfully.`);

        // 5. ベクトル検索 (RAG - Retrieval)
        step = "VectorSearch";
        console.log(`[${step}] Searching related documents using RPC: ${RPC_FUNCTION_NAME}...`);
        const { data: documents, error: rpcError } = await supabase.rpc(RPC_FUNCTION_NAME, {
            query_embedding: queryEmbedding,
            match_threshold: MATCH_THRESHOLD,
            match_count: MATCH_COUNT,
        });

        if (rpcError) {
            console.error(`[${step}] Supabase RPC Error:`, rpcError);
            // RPCエラーに関する詳細情報をエラーメッセージに含める
            throw new Error(`Supabase RPC (${RPC_FUNCTION_NAME}) failed: ${rpcError.message} (Code: ${rpcError.code}, Details: ${rpcError.details}, Hint: ${rpcError.hint})`);
        }

        // Supabase RPCは成功したがデータがnull/undefinedのケースも考慮
        const retrievedDocs = documents && Array.isArray(documents) ? documents as Document[] : [];
        console.log(`[${step}] Found ${retrievedDocs.length} related documents.`);

        // 6. AI回答生成 (RAG - Generation)
        step = "AICreation";
        console.log(`[${step}] Generating AI response with model ${COMPLETION_MODEL}...`);
        
        // 検索結果を整形
        const referenceInfo = retrievedDocs.length > 0
            ? retrievedDocs.map((doc, index) => {
                // FAQの場合は質問と回答をセットで表示
                if (doc.source_type === 'faq' && doc.question) {
                    return `Q: ${doc.question}\nA: ${doc.content}`;
                }
                // それ以外は通常通り
                return `${doc.source_type ? `[${doc.source_type}] ` : ''}${doc.content}`;
            }).join("\n\n")
            : "参考情報なし";

        const prompt = `
# あなたの役割
あなたは「yeniカスタマーサポート」の優秀なアシスタントAIです。Channelioに届いたお客様からのお問い合わせに対し、迅速かつ的確な一次回答案を作成し、オペレーター (\${operator_name}) の業務を支援します。親切、丁寧、正確、共感を大切にし、お客様に寄り添う対応を心がけてください。ブランドイメージに合った、柔らかく丁寧な言葉遣いを徹底してください。

# 顧客情報・コンテキスト (システム側で設定)
顧客名: \${customer_name}
メールアドレス: \${customer_email}
購入履歴（直近の注文番号、商品、日付など）: \${order_history}
現在の問い合わせチャネル: \${channel_type} (例: Web, LINE, Instagram)
問い合わせ概要（システムによる分類）: \${inquiry_category} (例: サイズ相談, 返品希望, 在庫確認, 配送, アカウント, 不良品, その他)

# 実行手順
1.  以下の「お客様からの問い合わせ内容」と上記の「顧客情報・コンテキスト」を正確に把握してください。
2.  問い合わせ内容から、お客様の主な要望や質問が何かを特定してください（例: サイズ交換、返品手順、在庫有無、商品仕様など）。
3.  以下の「対応ガイドライン」と「参考情報」**のみ**を使用して、問い合わせに対する回答案を日本語で生成してください。**参考情報に記載のない事実や、あなたの推測に基づく回答は絶対に含めないでください。**
4.  回答の構成は、以下を基本とし、問い合わせ内容に応じて調整してください。
    *   **挨拶と呼びかけ:** まず「\${customer_name} 様」と呼びかけ、丁寧な挨拶（例: 「お問い合わせいただき、誠にありがとうございます。」「ご連絡いただき、ありがとうございます。」）から始めてください。
    *   **自己紹介:** 次に「yeniカスタマーサポートでございます。」と名乗ってください。
    *   **状況確認（必要に応じて）:** 注文に関する問い合わせの場合、顧客情報や問い合わせ内容から関連する注文番号 (\${order_number} など) に触れ、状況を把握していることを示してください。（例: 「ご注文番号 \${order_number} の件についてですね。」「お問い合わせいただきました〇〇の件について、確認いたしました。」）
    *   **共感・謝罪:** お客様が困っている状況（サイズが合わない、商品不備、返信遅延など）がうかがえる場合は、「ご不便をおかけし申し訳ございません。」「ご心配をおかけしております。」といった共感やお詫びの言葉を適切に含めてください。
    *   **本題への回答（対応ガイドライン参照）:** 特定された要望・質問に対し、以下のガイドラインに従って回答してください。
    *   **ヒアリング（必要に応じて）:** 回答に必要な情報が不足している場合は、お客様が答えやすい具体的な質問をしてください。（例: サイズ相談で体感が不明な場合「フィットしなかった具体的な理由（アンダーがきつい、カップが大きいなど）を詳しくお聞かせいただけますでしょうか？」）**ただし、AIでの判断が難しい、または複数回のやり取りが必要そうな場合は、無理に回答せずオペレーターへ引き継いでください。**
    *   **言葉遣い:** 常に丁寧な敬語（ですます調）を使用し、お客様の問題解決に寄り添う姿勢を示してください。絵文字は使用しません。
    *   **結び:** 最後に「どうぞよろしくお願い申し上げます。」や「引き続きyeniをご愛顧いただけますと幸いです。」などで締めくくってください。
5.  **最重要:**
    *   回答は**必ず「参考情報」セクションに基づいて**作成してください。サイズ提案は「サイズ表」、返品・交換・送料ルールは「返品・交換ポリシー」「送料規定」、在庫・再販は「在庫・再販ポリシー」、その他FAQは「FAQ・その他情報」を参照してください。
    *   情報がない、またはAIで判断できない場合は、正直に「申し訳ございませんが、確認いたしますので少々お待ちいただけますでしょうか。」「担当オペレーターに対応を引き継ぎます。」のように伝え、無理に回答を生成しないでください。その際は、回答案の末尾に \`[NEEDS_OPERATOR_CHECK: 確認が必要な理由や事項]\` の形式でタグを追加してください。
    *   **スパム/詐欺の可能性があるメッセージ**（例: Meta/Facebook/Instagramを騙るアカウント警告、不審なURL、儲け話など）には**絶対に応答せず**、回答として \`[SPAM]\` とだけ出力してください。
    *   **PR/営業/協業依頼/メディア取材のメッセージ**には応答せず、回答として \`[SALES_LEAD]\` とだけ出力してください。（取材依頼の連絡先はFAQ参照）

# 対応ガイドライン（問い合わせ種別ごと）

*   **サイズ相談:**
    *   お客様の情報（普段のサイズ、購入サイズ、実測値、体感）と「サイズ表」を照合し、基本的な推奨サイズや考え方を提示。
    *   体感（きつい、ゆるい、カップが合わない等）が明確なら、「サイズ表」に基づき代替サイズ（アンダー上下、カップ上下）を理由と共に提案。（例: 「アンダーに締め付けを感じられるとのこと、アンダーを一つ上げた〇〇サイズがございます。ただし、カップの形状も若干変わる可能性がございます。」「カップが小さいとのことですので、カップを一つ上げた〇〇サイズですと、よりバストを包み込むかと存じます。」）
    *   体感が不明確、または情報が不足しているなら、具体的なヒアリングを優先。「よろしければ、フィットしなかった具体的な理由（例: アンダーがきつい・緩い、カップが小さい・大きい、脇高が当たるなど）を詳しくお聞かせいただけますでしょうか？」
    *   最終的な判断はお客様に委ねる姿勢を示す。「お客様のお好みもございますので、ご参考になりましたら幸いです。」
*   **返品希望:**
    *   まず「返品・交換ポリシー」に基づき、返品可能か（**単品ブラか、セット商品ではないか、到着後7日以内か**など）を確認。
    *   返品可能な場合（**単品ブラのお客様都合返品のみAIで案内可**）: 返品手順（返送先住所、送料負担は**元払い**であること、返送方法の推奨、同梱物）を案内。返送後の連絡（配送会社、伝票番号）を依頼。返金額は**商品代金のみ**（発送時送料除く）である旨も伝える。
    *   上記以外（セット商品、ショーツ等）の返品希望や、不良品疑い、判断に迷う場合は、「返品のご希望について承知いたしました。担当オペレーターにて詳細を確認し、改めてご連絡いたします。」と伝え、\`[NEEDS_OPERATOR_CHECK: 返品可否・手順の詳細確認]\` タグを追加。
    *   FAQリンク (\`https://yeni.jp/apps/help-center#bbf329188da3fa98ecdde21f472a7185f0369e5e\`) を提示。
*   **交換希望:**
    *   まず「返品・交換ポリシー」に基づき、交換可能か（**単品ブラか、セット商品ではないか、到着後7日以内か、初回交換か**など）を確認。
    *   交換可能な場合（**単品ブラの初回サイズ交換のみAIで案内可**）: 交換希望サイズ・カラーの在庫状況を「在庫情報」で確認（※要システム連携）。
        *   在庫がある場合: 交換手順（返送先住所、送料負担は**着払い**、返送方法の推奨、同梱物）を案内。返送後の連絡（配送会社、伝票番号）を依頼。
        *   在庫がない場合: 丁寧にお詫びし、「申し訳ございませんが、ご希望の〇〇（サイズ/カラー）は現在在庫切れでございます。よろしければ、ご返金にて対応させていただくことも可能ですが、いかがなさいますでしょうか？」と返金対応を提案する。または再入荷通知を案内。
    *   上記以外（セット商品、2回目以降、不良品疑い、ショーツ等）の交換希望や、判断に迷う場合は、「交換のご希望について承知いたしました。担当オペレーターにて在庫状況と合わせて詳細を確認し、改めてご連絡いたします。」と伝え、\`[NEEDS_OPERATOR_CHECK: 交換可否・在庫・手順の詳細確認]\` タグを追加。
    *   FAQリンク (\`https://yeni.jp/apps/help-center#bbf329188da3fa98ecdde21f472a7185f0369e5e\`) と交換リクエストページリンク (\`https://yeni.app.recustomer.me/\`) を提示。
*   **在庫確認・再販予定:**
    *   「在庫・再販ポリシー」に基づき、「現在のところ再販予定は未定でございます。」と丁寧に伝える。具体的な時期に関する問い合わせには回答しない。
    *   再販時の通知方法として、Instagram (\`@yeni_tokyo\`) と商品ページの「LINEで再販通知する」機能を案内する。
*   **配送関連（住所不備、未達、長期不在など）:**
    *   基本的にはオペレーター対応とする。AIは「配送状況について確認いたしますので、少々お待ちいただけますでしょうか。」のように応答し、\`[NEEDS_OPERATOR_CHECK: 配送関連（具体的な状況記載）]\` タグを追加してエスカレーション。
    *   顧客から正しい住所の連絡があった場合は、「ご連絡ありがとうございます。お知らせいただいたご住所を担当者が確認し、修正手続きを行います。少々お待ちくださいませ。」と応答し、同様にエスカレーション。
*   **アカウント関連（退会、パスワード、クーポン等）:**
    *   退会希望: 「参考情報」の定型文を使用し、手続き完了を伝える（※オペレーターが実際に処理した後、AIがこの定型文で応答するフローを想定）。
    *   パスワード忘れ: パスワード再設定ページの案内、メールが届かない場合の対処法（アカウント登録有無確認依頼、迷惑メール確認依頼）を案内。アカウント未登録が疑われる場合はオペレーターに確認を促す。
    *   クーポン未達/不具合: 「クーポンの件、ご不便をおかけし申し訳ございません。担当者が状況を確認し、改めてご連絡いたします。」と伝え、\`[NEEDS_OPERATOR_CHECK: クーポン不具合確認]\` タグを追加。
*   **商品仕様（素材、アレルギー、授乳利用など）:**
    *   「FAQ・その他情報」や「商品情報」に基づいて回答。金属使用有無、授乳専用ではない旨などを正直に伝える。不明な場合は「詳細を確認いたしますので少々お待ちください」と伝え、\`[NEEDS_OPERATOR_CHECK: 商品仕様確認（具体的な質問内容）]\` タグを追加。
*   **クレーム・返金関連:**
    *   **送料クレーム（1万円以上購入）:** 注文履歴を確認し、事実に基づいて「10,000円(税込)以上のご購入の場合、送料は無料となります。システム上、一時的に送料が表示される場合がございますが、最終的なご請求額では調整されます（または、送料分を返金処理いたします）のでご安心ください。」と説明。もし誤請求の可能性がある場合は「念のため確認いたします」とし、\`[NEEDS_OPERATOR_CHECK: 送料誤請求確認]\` タグを追加。
    *   **返金タイミング:** 「ご返金は、弊社での手続き完了後、ご利用のカード会社（またはPaidy）経由で行われます。そのため、実際の反映までにはお時間がかかる場合がございます（カード会社様によっては最大2ヶ月程度）。詳細なタイミングにつきましては、恐れ入りますがご利用のカード会社（またはPaidy）へ直接お問い合わせいただけますでしょうか。」と案内。
    *   その他のクレームは「ご不快な思いをさせてしまい申し訳ございません。担当者より改めてご連絡いたします。」とし、\`[NEEDS_OPERATOR_CHECK: クレーム対応（具体的な内容）]\` タグを追加。
*   **その他の問い合わせ:**
    *   「FAQ・その他情報」に基づいて回答を試みる。情報がない場合は正直に「申し訳ございませんが、お問い合わせの件につきましては、担当者が確認して改めてご連絡いたします。」と伝え、\`[NEEDS_OPERATOR_CHECK: その他問い合わせ（具体的な内容）]\` タグを追加。

# 参考情報 (システム側で設定)
---
${referenceInfo}
---
# お客様からの問い合わせ内容 (システム側で設定)
${query}
---
# 回答案:
`.trim();

        const completionResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: COMPLETION_MODEL,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3, // 少し創造性を抑える方向に調整
                // max_tokens: 500, // 必要に応じて最大トークン数を設定
            }),
        });

        if (!completionResponse.ok) {
            const errorData = await completionResponse.json();
            console.error(`[${step}] OpenAI Completions API Error (${completionResponse.status}):`, JSON.stringify(errorData));
            throw new Error(`OpenAI Completions API request failed: ${completionResponse.status} ${completionResponse.statusText}`);
        }

        const completionData = await completionResponse.json();
        // APIレスポンスの構造が変わる可能性を考慮
        const aiResponse = completionData.choices?.[0]?.message?.content?.trim();
        if (!aiResponse) {
            console.error(`[${step}] Unexpected OpenAI Completions API response structure or empty content:`, completionData);
            throw new Error("Failed to extract AI response from OpenAI API.");
        }
        console.log(`[${step}] AI response generated successfully.`);

        // 7. Channel.ioへAI回答案をプライベートメッセージとして投稿 (Phase 2)
        step = "ChannelioDraftPost";
        if (channelioChatId && CHANNELIO_ACCESS_KEY && CHANNELIO_ACCESS_SECRET) {
            console.log(`[${step}] Posting AI draft to Channel.io chat ${channelioChatId}...`);
            try {
                const messageToChannelio = `【AI回答案】\n${aiResponse}`;
                const postSuccess = await sendChannelioPrivateMessage(
                    channelioChatId,
                    messageToChannelio,
                    { accessKey: CHANNELIO_ACCESS_KEY, accessSecret: CHANNELIO_ACCESS_SECRET }, 
                    CHANNELIO_BOT_PERSON_ID // Pass the optional Bot Person ID
                );
                if (postSuccess) {
                    console.log(`[${step}] AI回答案をプライベートメッセージとして正常に投稿しました。`);
                } else {
                    // Don't throw error here, just log a warning, error might be logged in the helper
                    console.warn(`[${step}] AI回答案のプライベートメッセージ投稿に失敗しました (詳細ログはヘルパー関数内を確認)。`);
                    // Optionally notify error channel if needed, but avoid duplicate notifications if helper already logs/notifies
                    // await notifyError(step, new Error("Failed to post AI draft to Channel.io"), { query, userId });
                }
            } catch (postError) {
                 // Catch errors specifically from the posting step
                 console.error(`[${step}] Error posting AI draft to Channel.io:`, postError);
                 // Notify error here as it's an unexpected exception during the call
                 await notifyError(step, postError, { query, userId: channelioChatId });
                 // Depending on requirements, you might want to continue or re-throw
            }
        } else {
            console.warn(`[${step}] Skipping Channel.io post due to missing chatId (${channelioChatId}), Access Key (${!CHANNELIO_ACCESS_KEY}) or Access Secret (${!CHANNELIO_ACCESS_SECRET}).`);
        }

        // 8. Slack通知 (オペレーター確認用) - Renumbered from 7
        step = "SlackNotify";
        console.log(`[${step}] Sending notification to Slack channel ${SLACK_CHANNEL_ID}...`);
        const blocks = [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": ":loudspeaker: 新しい問い合わせがありました",
                    "emoji": true
                }
            },
            {
                "type": "section",
                "fields": [
                    { "type": "mrkdwn", "text": `*顧客名:*\n${customerName || '不明'}` },
                    { "type": "mrkdwn", "text": `*Channelioリンク:*\n${chatLink ? `<${chatLink}|リンクを開く>` : '不明'}` }
                ]
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `*問い合わせ内容:*\n\`\`\`${query}\`\`\``
                }
            },
            ...(orderInfo?.url ? [{
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `*注文情報:*\n注文番号: ${orderInfo.orderNumber}\n注文ステータス: ${orderInfo.status ?? '不明'}\n注文詳細: <${orderInfo.url}|Logilessで確認>`
                }
            }] : []),
            {
                "type": "divider"
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `*AIによる回答案:*\n\`\`\`${aiResponse}\`\`\``
                }
            }
        ];
        const fallbackText = `新規問い合わせ: ${customerName ?? '不明'} - ${query.substring(0, 50)}...`;

        // --- ここから変更: postToSlackにthreadTsを渡し、戻り値のtsを保存 --- 
        // 既存のスレッドTS (existingThreadTs) を postToSlack に渡す
        const newTs = await postToSlack(SLACK_CHANNEL_ID, fallbackText, blocks, existingThreadTs ?? undefined);

        // 新しいメッセージで、Slackへの投稿が成功した場合のみ、tsを保存/更新
        if (!existingThreadTs && newTs && channelioChatId) {
            console.log(`[${step}] Saving new thread ts ${newTs} for chatId ${channelioChatId}...`);
            await saveThreadTs(channelioChatId, newTs);
        } else if (existingThreadTs && newTs && channelioChatId) {
            // オプション: 既存スレッドへの返信成功時にも有効期限を更新するならsaveを呼ぶ
             console.log(`[${step}] Optionally update expiration for existing thread ${existingThreadTs} for chatId ${channelioChatId}...`);
             await saveThreadTs(channelioChatId, existingThreadTs); // tsは既存のものを使い、expires_atを更新
        }
        // --- ここまで変更 ---

        console.log(`[${step}] Notification sent successfully.`);

    } catch (error) {
        console.error(`Error during step ${step}:`, error);
        // 9. エラーハンドリングと通知 - Renumbered from 8
        // ここで notifyError を呼ぶことで、処理中のどのステップでエラーが起きても Slack に通知される
        await notifyError(step, error, { query, userId: channelioChatId });
        // エラーが発生した場合、これ以上の処理は行わない
        throw error;
    }
}

// --- Deno Serve エントリーポイント ---
serve(async (req: Request) => {
    // OPTIONSメソッド（プリフライトリクエスト）への対応
     if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders }); // 204 No Content を返すのが一般的
    }

    // 1. リクエスト受信と検証
    if (req.method !== "POST") {
         console.warn(`Received non-POST request: ${req.method}`);
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }
    const contentType = req.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) {
         console.warn(`Received invalid Content-Type: ${contentType}`);
        return new Response("Unsupported Media Type: Expected application/json", { status: 415, headers: corsHeaders });
    }

    // TODO: Channelio Webhook署名検証
    // const signature = req.headers.get("X-Channel-Signature"); // 実際のヘッダー名を確認
    // const secret = Deno.env.get("CHANNELIO_WEBHOOK_SECRET");
    // if (!signature || !secret) {
    //     console.warn("Webhook signature or secret is missing. Skipping verification.");
    //     // 検証を必須にする場合は 403 Forbidden を返す
    //     // return new Response("Forbidden: Missing signature or secret", { status: 403, headers: corsHeaders });
    // } else {
    //     try {
    //          // ボディをテキストとして読み込み、署名検証関数に渡す
    //          const rawBody = await req.text();
    //          // const isValid = await verifyChannelioSignature(rawBody, signature, secret);
    //          // if (!isValid) {
    //          //    console.error("Invalid webhook signature.");
    //          //    return new Response("Forbidden: Invalid signature", { status: 403, headers: corsHeaders });
    //          // }
             // 検証成功後、再度JSONとしてパースする必要がある
    //          // payload = JSON.parse(rawBody);
    //      } catch (error) {
    //          console.error("Error during signature verification:", error);
    //          return new Response("Internal Server Error during verification", { status: 500, headers: corsHeaders });
    //      }
    // }

    let payload: ChannelioWebhookPayload;
    let rawBodyText: string | undefined; // 署名検証のために保持
    try {
        // 署名検証のためにテキストも保持しておく（検証実装時に必要）
        rawBodyText = await req.text();
        payload = JSON.parse(rawBodyText);
    } catch (error) {
        console.error("Failed to parse request body:", error);
        return new Response("Bad Request: Invalid JSON format", { status: 400, headers: corsHeaders });
    }

    // 2. 情報抽出 (ここでのチェックはhandleWebhook内に移動したので簡略化)
    const queryForEarlyCheck = payload.entity?.plainText;
    const userIdForEarlyCheck = payload.entity?.personId;
    const chatIdForEarlyCheck = payload.entity?.chatId;

    // 3. 早期レスポンスと非同期処理の開始
    handleWebhook(payload).catch(e => {
        console.error("Unhandled background error in handleWebhook:", e);
        // エラー通知時の情報も更新 - chatIdもコンテキストに含める
        notifyError("UnhandledWebhookError", e, { query: queryForEarlyCheck, userId: chatIdForEarlyCheck ?? userIdForEarlyCheck }).catch(ne => {
            console.error("CRITICAL: Failed to send unhandled error notification:", ne);
        });
    });

    // Channelio にはすぐに 200 OK を返す
    console.log("Webhook received successfully. Processing in background.");
    return new Response(JSON.stringify({ message: "Webhook received successfully. Processing in background." }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
});

console.log("Channelio webhook handler function started. Listening for requests..."); 