// @deno-types=npm:@types/node
// ^^^ This comment helps some editors/linters recognize Deno types, but might not fully resolve all issues.
// NOTE: Linter errors regarding 'Deno' object or 'https://...' imports are likely false positives
// due to the linter environment not fully recognizing the Deno runtime. The code should execute correctly in Supabase Functions.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { getLogilessOrderInfo, type LogilessOrderInfo } from "../_shared/logiless.ts";
import { sendChannelioPrivateMessage } from "../_shared/channelio.ts";
import { encode } from "https://deno.land/std@0.177.0/encoding/base64.ts";

// --- 定数定義 ---
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
const SLACK_CHANNEL_ID = Deno.env.get("SLACK_CHANNEL_ID");
const SLACK_ERROR_CHANNEL_ID = Deno.env.get("SLACK_ERROR_CHANNEL_ID");
const LOGILESS_CLIENT_ID = Deno.env.get("LOGILESS_CLIENT_ID");
const LOGILESS_CLIENT_SECRET = Deno.env.get("LOGILESS_CLIENT_SECRET");
const LOGILESS_REFRESH_TOKEN = Deno.env.get("LOGILESS_REFRESH_TOKEN");
const LOGILESS_TOKEN_ENDPOINT = Deno.env.get("LOGILESS_TOKEN_ENDPOINT") || "https://app2.logiless.com/api/oauth2/token";
const CHANNELIO_ACCESS_KEY = Deno.env.get("CHANNELIO_ACCESS_KEY");
const CHANNELIO_ACCESS_SECRET = Deno.env.get("CHANNELIO_ACCESS_SECRET");
const CHANNELIO_BOT_PERSON_ID = Deno.env.get("CHANNELIO_BOT_PERSON_ID");
const SLACK_THREAD_EXPIRY_HOURS = 48;

// 注文番号抽出用の正規表現
const ORDER_NUMBER_PATTERN = /(?:#)?yeni-\d+/i;

const EMBEDDING_MODEL = "text-embedding-3-small";
const COMPLETION_MODEL = "gpt-4o-mini";
const MATCH_THRESHOLD = 0.7;
const MATCH_COUNT = 3;
const RPC_FUNCTION_NAME = "match_documents";

// フィルタリング用定数
const OPERATOR_PERSON_TYPES: Set<string> = new Set(['manager']);
const BOT_PERSON_TYPE = 'bot';
const IGNORED_BOT_MESSAGES: Set<string> = new Set([ /* ... (前回のリストを維持) ... */ ]);

// --- 型定義 ---
interface ChannelioEntity {
    plainText: string;
    personId?: string;
    personType?: 'user' | 'manager' | 'bot';
    chatId?: string;
    id?: string;
    workflowButton?: boolean;
    options?: string[];
}

interface ChannelioUserChat {
    id: string;
    state?: 'opened' | 'closed';
    userId?: string;
}

interface ChannelioUser {
    id: string;
    name?: string;
}

interface ChannelioRefers {
    userChat?: ChannelioUserChat;
    user?: ChannelioUser;
}

interface ChannelioWebhookPayload {
    entity: ChannelioEntity;
    refers?: ChannelioRefers;
    event?: string;
    type?: string;
}

interface SlackThreadInfo {
  channelio_chat_id: string;
  slack_thread_ts: string;
  expires_at: string;
}

interface Document {
    content: string;
    source_type?: string;
    question?: string;
}

interface LogilessOrderData {
    order_date?: string;
    items?: { name: string; quantity: number; }[];
    status?: string;
    customer_name?: string;
    details_url?: string;
    code?: string;
}

interface LogilessTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
}

// --- Supabase クライアント初期化 ---
let supabase: SupabaseClient;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }, });
    console.log("Supabase client initialized with Service Role Key.");
} else {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY. Supabase client could not be initialized.");
}

// --- ヘルパー関数: Slack通知 ---
async function postToSlack(channel: string, text: string, blocks?: any[], threadTs?: string): Promise<string | undefined> {
    if (!SLACK_BOT_TOKEN) {
        console.error("SLACK_BOT_TOKEN is not set.");
        return undefined;
    }
    try {
        const payload: { channel: string; text: string; blocks?: any[] } = {
            channel: channel,
            text: text,
        };
        if (blocks) {
            payload.blocks = blocks;
        }

        if (threadTs) {
            (payload as any).thread_ts = threadTs;
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
            return undefined;
        } else {
            const data = await response.json();
            if (!data.ok) {
                 console.error(`Slack API Error: ${data.error}`);
                 return undefined;
            } else {
                 console.log(`Message posted successfully to ${channel}${threadTs ? ` (thread: ${threadTs})` : ''}. ts: ${data.ts}`);
                 return data.ts as string;
            }
        }
    } catch (error) {
        console.error(`Error posting to Slack channel ${channel}:`, error);
        await notifyError("PostToSlack", error, { userId: `Channel: ${channel}` });
        return undefined;
    }
}

// --- ヘルパー関数: エラー通知 ---
async function notifyError(step: string, error: any, context: { query?: string; userId?: string; orderNumber?: string | null; }) {
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    const fallbackText = `:warning: Channelio 自動応答エラー発生 (${step})`;

    if (SLACK_ERROR_CHANNEL_ID) {
        try {
            const errorBlocks = [
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
                        "text": `*エラーメッセージ:*\\n\\\`\\\`\\\`${errorMessage.substring(0, 1000)}\\\`\\\`\\\``
                    }
                },
                ...(stack ? [{
                    "type": "section",
                    "text": { "type": "mrkdwn", "text": `*スタックトレース:*\\n\\\`\\\`\\\`${stack.substring(0, 1000)}\\\`\\\`\\\`` }
                }] : []),
                {
                    "type": "section",
                    "fields": [
                         { "type": "mrkdwn", "text": `*Query:*\n${context.query ?? 'N/A'}` },
                         { "type": "mrkdwn", "text": `*UserID:*\n${context.userId ?? 'N/A'}` },
                         { "type": "mrkdwn", "text": `*Order#:*\n${context.orderNumber ?? 'N/A'}` }
                    ]
                },
                 { "type": "divider" }
            ];
            await postToSlack(SLACK_ERROR_CHANNEL_ID, fallbackText, errorBlocks);
        } catch (slackError) {
             console.error(`[${step}] Error sending Slack notification:`, slackError);
             await notifyError(step, slackError, { query, userId, orderNumber });
        }
    } else {
        const logMessage = `\nError Timestamp: ${timestamp}\nError Step: ${step}\nError Message: ${errorMessage}\nStack Trace: ${stack ?? 'N/A'}\nQuery: ${context.query ?? 'N/A'}\nUserID: ${context.userId ?? 'N/A'}\nOrder#: ${context.orderNumber ?? 'N/A'}\n`;
        console.error("SLACK_ERROR_CHANNEL_ID is not set. Error details:", logMessage);
    }
}

// 注文番号抽出関数
export function extractOrderNumber(text: string): string | null {
    if (!text) return null;
    const match = text.match(ORDER_NUMBER_PATTERN);
    return match ? match[0].replace('#', '') : null;
}

// --- 新しいヘルパー関数: Logilessアクセストークン取得 ---
async function getLogilessAccessToken(): Promise<string | null> {
    const step = "LogilessAuthToken";
    if (!LOGILESS_CLIENT_ID || !LOGILESS_CLIENT_SECRET || !LOGILESS_REFRESH_TOKEN) {
        console.error(`[${step}] Logiless client credentials or refresh token is not set in environment variables.`);
        throw new Error("Logiless refresh token or client credentials are not configured.");
    }

    try {
        console.log(`[${step}] Requesting Logiless access token using refresh token from ${LOGILESS_TOKEN_ENDPOINT}...`);

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: LOGILESS_REFRESH_TOKEN,
            client_id: LOGILESS_CLIENT_ID,
            client_secret: LOGILESS_CLIENT_SECRET
        });

        const response = await fetch(LOGILESS_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString()
        });

        if (!response.ok) {
            const errorStatus = response.status;
            const errorText = await response.text();
            let detailedErrorMessage = `Logiless token request failed with status ${errorStatus}: ${errorText.substring(0, 200)}`;

            if (errorText.toLowerCase().includes("invalid_grant")) {
                detailedErrorMessage += "\nPOSSIBLE CAUSE: The refresh token might be invalid, expired, or revoked. Manual re-authentication might be required.";
                console.error(`[${step}] Logiless 'invalid_grant' error detected. Refresh token likely needs update.`);
            } else if (errorText.toLowerCase().includes("invalid_client")) {
                detailedErrorMessage += "\nPOSSIBLE CAUSE: Client ID or Secret might be incorrect.";
                console.error(`[${step}] Logiless 'invalid_client' error detected. Check client credentials.`);
            } else if (errorText.toLowerCase().includes("unsupported_grant_type")) {
                 detailedErrorMessage += "\nPOSSIBLE CAUSE: The 'refresh_token' grant type might not be supported or configured correctly for this client.";
                 console.error(`[${step}] Logiless 'unsupported_grant_type' error detected. Check if refresh token flow is enabled.`);
            }

            console.error(`[${step}] Failed to get Logiless access token. Response:`, errorText);
            throw new Error(detailedErrorMessage);
        }

        const tokenData: LogilessTokenResponse = await response.json();
        if (!tokenData.access_token) {
             console.error(`[${step}] Invalid token response structure:`, tokenData);
             throw new Error("Logiless token response did not contain access_token.");
        }

        console.log(`[${step}] Logiless access token obtained successfully.`);
        return tokenData.access_token;

    } catch (error) {
        console.error(`[${step}] Unexpected error getting Logiless access token:`, error);
        throw error;
    }
}

// --- メインのバックグラウンド処理関数 (ロジレス連携を追加) ---
async function processUserQuery(payload: ChannelioWebhookPayload) {
    const query = payload.entity.plainText?.trim();
    const customerName = payload.refers?.user?.name;
    const userId = payload.entity.personId;

    let logilessOrderInfo: string | null = null;
    let logilessOrderUrl: string | null = null;
    let orderNumber: string | null = null;
    let logilessAccessToken: string | null = null;
    let referenceInfo = "関連ナレッジなし";
    let orderId: string | null = null;

    let step = "Initialization";

    if (!query) {
        console.log("[Initialization] Empty query received. Skipping processing.");
        return;
    }

    try {
        step = "OrderNumberExtraction";
        const orderNumberMatch = query.match(/#yeni-(\d+)/i);
        orderNumber = orderNumberMatch ? orderNumberMatch[0] : null;
        orderId = orderNumberMatch ? orderNumberMatch[1] : null;
        console.log(`[${step}] Extracted Order Number: ${orderNumber}, Order ID: ${orderId}`);

        if (orderNumber && orderId) {
            step = "LogilessAuthToken";
            try {
                logilessAccessToken = await getLogilessAccessToken();
            } catch (tokenError) {
                console.error(`[${step}] Failed to obtain Logiless token:`, tokenError);
                logilessOrderInfo = "ロジレス認証トークンの取得に失敗しました。";
                await notifyError(step, tokenError, { query, userId, orderNumber });
                logilessAccessToken = null;
            }

            if (logilessAccessToken) {
                step = "LogilessAPICall";
                console.log(`[${step}] Calling Logiless API with access token...`);
                try {
                    const logilessApiUrl = `https://app2.logiless.com/api/v1/merchant/orders?code=${encodeURIComponent(orderNumber)}`;
                    console.log(`[${step}] Calling Logiless Order API URL: ${logilessApiUrl}`);

                    const response = await fetch(logilessApiUrl, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${logilessAccessToken}`,
                            'Accept': 'application/json'
                        }
                    });
                    console.log(`[${step}] Logiless API Response Status: ${response.status}`);

                    if (response.ok) {
                        const data: LogilessOrderData | LogilessOrderData[] = await response.json();
                         console.log(`[${step}] Logiless API Raw Response Data:`, JSON.stringify(data, null, 2));
                        const orderData = Array.isArray(data)
                            ? data.find(d => d.code === orderNumber)
                            : data;

                        if (orderData) {
                             console.log(`[${step}] Logiless API Success. Found order data.`);
                             const itemsText = orderData.items?.map(item => `${item.name}(${item.quantity})`).join(', ') || '商品情報なし';
                             logilessOrderInfo = `注文日: ${orderData.order_date || '不明'}, 商品: ${itemsText}, ステータス: ${orderData.status || '不明'}`;
                             console.log(`[${step}] Extracted Logiless Info: ${logilessOrderInfo}`);

                             logilessOrderUrl = orderData.details_url ?? null;

                             if (!logilessOrderUrl) {
                                 const merchantId = Deno.env.get("LOGILESS_MERCHANT_ID");
                                 if (merchantId && orderId) {
                                      logilessOrderUrl = `https://app2.logiless.com/merchant/${merchantId}/sales_orders/${orderId}`;
                                      console.log(`[${step}] Constructed Logiless URL: ${logilessOrderUrl}`);
                                 } else {
                                      console.warn(`[${step}] Cannot construct Logiless URL. Missing merchantId or orderId.`);
                                 }
                             } else {
                                  console.log(`[${step}] Using Logiless URL from response: ${logilessOrderUrl}`);
                             }
                        } else {
                             console.log(`[${step}] Order ${orderNumber} data not found in Logiless response structure.`);
                             logilessOrderInfo = `注文番号 ${orderNumber} はロジレスで見つかりませんでした。`;
                        }

                    } else if (response.status === 401 || response.status === 403) {
                         const errorText = await response.text();
                         console.warn(`[${step}] Logiless API Auth Error (${response.status}): ${errorText}. Access token might be expired or invalid.`);
                         logilessOrderInfo = "ロジレスAPIへのアクセス権限がないか、トークンが無効です。";
                         throw new Error(`Logiless API auth error: ${response.status}`);
                    } else if (response.status === 404) {
                         console.log(`[${step}] Order ${orderNumber} not found via Logiless API (404).`);
                         logilessOrderInfo = `注文番号 ${orderNumber} はロジレスで見つかりませんでした。`;
                     } else {
                         const errorText = await response.text();
                         console.error(`[${step}] Logiless API Error (${response.status}): ${errorText}`);
                         logilessOrderInfo = "ロジレス情報の取得に失敗しました。";
                         throw new Error(`Logiless API request failed: ${response.status}`);
                    }
                } catch (apiError) {
                     console.error(`[${step}] Error during Logiless API call:`, apiError);
                     if (!logilessOrderInfo) {
                        logilessOrderInfo = "ロジレス情報の取得中にエラーが発生しました。";
                     }
                     await notifyError(step, apiError, { query, userId, orderNumber });
                }
            }
        } else {
             console.log("[Logiless] No order number found. Skipping Logiless integration.");
        }

        step = "SupabaseInit";
        let supabase: SupabaseClient;
        try {
             if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
                 throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY is missing.");
             }
             supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                 global: { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
                 auth: { persistSession: false, autoRefreshToken: false }
             });
             console.log(`[${step}] Supabase client initialized.`);
        } catch (initError) {
             console.error(`[${step}] Failed to initialize Supabase client:`, initError);
             await notifyError(step, initError, { query, userId, orderNumber });
             throw initError;
        }

        step = "Vectorization";
        let queryEmbedding: number[];
        try {
            if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing for vectorization.");
            console.log(`[${step}] Generating embedding for query with model ${EMBEDDING_MODEL}...`);
            const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", { /* ... */ });
             if (!embeddingResponse.ok) { throw new Error("OpenAI Embedding API request failed"); }
            const embeddingData = await embeddingResponse.json();
            queryEmbedding = embeddingData.data[0].embedding;
             console.log(`[${step}] Embedding generated successfully.`);
        } catch(embedError) {
             console.error(`[${step}] Error during vectorization:`, embedError);
             await notifyError(step, embedError, { query, userId, orderNumber });
             throw embedError;
        }

        step = "VectorSearch";
        try {
            console.log(`[${step}] Searching related documents using RPC: ${RPC_FUNCTION_NAME}...`);
            const { data: documents, error: rpcError } = await supabase.rpc(RPC_FUNCTION_NAME, {
                query_embedding: queryEmbedding,
                match_threshold: MATCH_THRESHOLD,
                match_count: MATCH_COUNT,
            });

            if (rpcError) {
                 console.error(`[${step}] Supabase RPC Error:`, rpcError);
                 await notifyError(step, rpcError, { query, userId, orderNumber });
                 referenceInfo = "データベース検索中にエラーが発生しました。";
            } else {
                const retrievedDocs = documents && Array.isArray(documents) ? documents as Document[] : [];
                console.log(`[${step}] Found ${retrievedDocs.length} related documents.`);
                referenceInfo = retrievedDocs.length > 0
                    ? retrievedDocs.map((doc, index) => `[${index+1}] ${doc.content}`).join("\n\n")
                    : "関連ナレッジなし";
            }
        } catch (searchError) {
             console.error(`[${step}] Unexpected error during vector search:`, searchError);
             await notifyError(step, searchError, { query, userId, orderNumber });
             referenceInfo = "データベース検索中に予期せぬエラーが発生しました。";
        }

        step = "AICreation";
        let aiResponse = "AIによる回答生成中にエラーが発生しました。";
        try {
            if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing for AI completion.");
            console.log(`[${step}] Generating AI response with model ${COMPLETION_MODEL}...`);
            const prompt = \`
# あなたの役割
あなたは「yeniカスタマーサポート」の優秀なAIアシスタントです。Channelio経由でのお客様からの問い合わせに対し、以下の情報を元に、迅速かつ的確な一次回答案を作成してください。オペレーターの確認・編集を前提とし、**回答の品質と正確性を最優先**します。

# 重要な前提
*   回答案はSlackに投稿され、**必ずオペレーターが内容を確認・編集してから**お客様に送信されます。
*   不明な点、判断に迷う点、複雑なケース、クレームは**無理に回答せず**、オペレーターに対応を促すメモを残してください。
*   常に親切、丁寧、正確、共感を心がけ、ブランドイメージに合った柔らかい言葉遣いを徹底してください。（敬語、ですます調）

# 提供情報
## 1. 顧客からの問い合わせ内容
\\\`\\\`\\\`
${query}
\\\`\\\`\\\`

## 2. 顧客情報 (判明している場合)
*   顧客名: ${customerName || '不明'}
*   UserID: ${userId || '不明'}

## 3. 注文情報 (問い合わせ内容から抽出・Logiless連携結果)
${orderNumber ? \`*   問い合わせ内の注文番号: \${orderNumber}\` : '*   問い合わせ内に注文番号なし'}
*   Logiless連携結果: \${logilessOrderInfo || (orderNumber ? (logilessAccessToken === null && !logilessOrderInfo.includes("認証") ? 'ロジレス認証失敗のため未検索' : '該当注文に関する情報なし/取得失敗') : '注文番号がないため未検索')}
${logilessOrderUrl ? \`*   Logiless注文詳細URL: <\${logilessOrderUrl}|Logilessで確認>\` : ''}

## 4. 関連する可能性のある社内ナレッジ (ベクトル検索結果)
${referenceInfo}

# 回答案生成手順
1.  **問い合わせ内容の分析:** お客様の主な質問、要望、状況（困りごと、疑問点など）を正確に把握します。
2.  **情報照合:** 問い合わせ内容と、「3. 注文情報」「4. 関連ナレッジ」を照合し、回答に必要な情報を特定します。
3.  **回答案の生成:** 以下の「回答ガイドライン」に従って、日本語で回答案を作成します。
    *   **構成:**
        *   挨拶: 「お問い合わせありがとうございます。」など。顧客名が分かれば「${customerName || ''}様、お問い合わせありがとうございます。」のように呼びかけ。
        *   共感/謝罪(必要な場合): 「ご不便をおかけし申し訳ございません。」など。
        *   本題: 問い合わせに対する回答。関連ナレッジや注文情報があれば活用。
        *   不足情報確認(必要な場合): 回答に必要な情報が足りなければ、具体的な質問を追加。
        *   オペレーターへの引継ぎ指示(必要な場合): AIで回答不能、または要確認事項がある場合は、回答案の末尾に \`[要オペレーター確認: (理由)]\` の形式で明確に記載。
        *   結び: 「よろしくお願いいたします。」など。
    *   **最重要ルール:**
        *   **関連ナレッジや注文情報に基づいて回答**してください。**情報がない場合や不明な場合は、推測せず**、「確認します」旨を伝え、オペレーターへの確認指示を記載してください。
        *   **個人情報**（住所、電話番号、カード情報など）の入力を促す内容は**絶対に含めない**でください。
        *   **スパム/詐欺/営業メッセージ**への回答は **\`[SPAM]\`** または **\`[SALES]\`** とだけ出力してください。

# 回答ガイドライン (主要ケース)
*   **注文に関する質問 (ステータス、内容確認など):**
    *   Logiless情報 (${logilessOrderInfo}) があれば、それを元に回答。「ご注文${orderNumber}について、${logilessOrderInfo}」のように具体的に。URL (${logilessOrderUrl}) があれば提示。
    *   情報がない/不明な場合 (${!logilessOrderInfo}) や認証失敗時は、「ご注文${orderNumber}について確認いたします。」とし、\`[要オペレーター確認: Logilessでの${orderNumber}の詳細確認 (${logilessOrderInfo || '認証失敗/情報なし'})]\` を追加。
*   **FAQ的な質問 (商品仕様、返品交換ポリシーなど):**
    *   関連ナレッジに合致する情報があれば、それを分かりやすく要約して回答。
    *   ナレッジがない/不十分/検索エラーの場合は、「お問い合わせの件について確認します。」とし、\`[要オペレーター確認: ${query}に関するナレッジ確認 (${referenceInfo})]\` を追加。
*   **複雑な相談、クレーム、判断が必要な依頼:**
    *   AIでの回答は避け、「担当者が確認し、改めてご連絡いたします。」のように伝え、\`[要オペレーター確認: (具体的な理由、例: 複雑な返品相談)]\` を追加。

# 出力
回答案のみを以下に出力してください。
---
\\\`.trim();

            const completionResponse = await fetch("https://api.openai.com/v1/chat/completions", {
                 method: "POST",
                 headers: { /* ... */ },
                 body: JSON.stringify({
                     model: COMPLETION_MODEL,
                     messages: [{ role: "user", content: prompt }],
                     temperature: 0.2,
                 }),
             });
             if (!completionResponse.ok) { throw new Error("OpenAI Completion API request failed"); }
            const completionData = await completionResponse.json();
            const extractedResponse = completionData.choices?.[0]?.message?.content?.trim();
            if (!extractedResponse) { throw new Error("Failed to extract AI response from OpenAI API."); }
            aiResponse = extractedResponse;
            console.log(`[${step}] AI response generated successfully.`);

        } catch (aiError) {
             console.error(`[${step}] Error during AI response generation:`, aiError);
             await notifyError(step, aiError, { query, userId, orderNumber });
        }

        step = "SlackNotify";
        try {
            if (!SLACK_CHANNEL_ID || !SLACK_BOT_TOKEN) {
                 throw new Error("Slack Channel ID or Bot Token is missing.");
            }
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
                        { "type": "mrkdwn", "text": `*Channelioリンク:*\n${chatLink ? \`<${chatLink}|リンクを開く>\` : '不明'}` }
                    ]
                },
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": `*問い合わせ内容:*\n\\\`\\\`\\\`${query}\\\`\\\`\\\``
                    }
                },
                ...(logilessOrderInfo || logilessOrderUrl ? [
                    { "type": "divider" },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": `*Logiless関連情報 (${orderNumber || '番号不明'}):*\\n${logilessOrderInfo || '情報なし'}${logilessOrderUrl ? \`\\n<${logilessOrderUrl}|Logilessで詳細確認>\` : ''}`
                         }
                    }
                ] : (orderNumber ? [
                     { "type": "divider" },
                     {
                         "type": "section",
                         "text": { "type": "mrkdwn", "text": `*Logiless関連情報 (${orderNumber}):*\\n${logilessOrderInfo || (logilessAccessToken === null ? '認証失敗' : '情報取得失敗/見つかりません')}` }
                     }
                 ] : [])),
                { "type": "divider" },
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": `*AIによる回答案:*\n\\\`\\\`\\\`${aiResponse}\\\`\\\`\\\``
                    }
                }
            ];
             const fallbackText = \`新規問い合わせ (\${customerName || '不明'}): \${query.substring(0, 50)}...\`;
             await postToSlack(SLACK_CHANNEL_ID, fallbackText, blocks);
            console.log(`[${step}] Notification sent successfully.`);
        } catch (slackError) {
             console.error(`[${step}] Error sending Slack notification:`, slackError);
             await notifyError(step, slackError, { query, userId, orderNumber });
        }

    } catch (error) {
        console.error(`Error during step ${step}:`, error);
         if (step !== "LogilessAuthToken" && step !== "LogilessAPICall" && step !== "AICreation" && step !== "SlackNotify") {
            await notifyError(step, error, { query, userId, orderNumber });
         }
        throw error;
    }
}

// --- Deno Serve エントリーポイント ---
serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== "POST") {
         console.warn(`Received non-POST request: ${req.method}`);
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }
    const contentType = req.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) {
         console.warn(`Received invalid Content-Type: ${contentType}`);
        return new Response("Unsupported Media Type: Expected application/json", { status: 415, headers: corsHeaders });
    }

    let payload: ChannelioWebhookPayload;
    let rawBodyText: string | undefined;
    try {
        rawBodyText = await req.text();
        payload = JSON.parse(rawBodyText);
    } catch (error) {
        console.error("Failed to parse request body:", error);
        return new Response("Bad Request: Invalid JSON format", { status: 400, headers: corsHeaders });
    }

    const queryForEarlyCheck = payload.entity?.plainText;
    const userIdForEarlyCheck = payload.entity?.personId;
    const chatIdForEarlyCheck = payload.entity?.chatId;

    processUserQuery(payload).catch(async (e) => {
        console.error("Unhandled background error in processUserQuery:", e);
        const queryFromPayload = payload.entity?.plainText;
        const userIdFromPayload = payload.entity?.personId;
        await notifyError("UnhandledProcessError", e, { query: queryFromPayload, userId: userIdFromPayload, orderNumber: null }).catch(ne => {
            console.error("CRITICAL: Failed to send final unhandled error notification:", ne);
        });
    });

    console.log("Webhook received successfully. Processing in background.");
    return new Response(JSON.stringify({ message: "Webhook received successfully. Processing in background." }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
});

console.log("Channelio webhook handler function started. Listening for requests..."); 