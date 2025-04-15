/// <reference types="npm:@supabase/functions-js/dist/edge-runtime.d.ts" />
// deno-lint-ignore-file no-explicit-any no-unused-vars
// ↑ Deno/リンターエラー(誤検知)を抑制するためのコメント。不要なら削除可。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// ★ スレッド化用のヘルパー関数をインポート (パスは実際の構成に合わせる) ★
import { getActiveThreadTs, saveThreadTs } from '../_shared/slackUtils.ts';
// ★ postToSlack も slackUtils.ts に移動したと仮定してインポート ★
import { postToSlack } from '../_shared/slackUtils.ts';
// ★ Service Role Client を使う場合 (DB操作関数内で使われているはず) ★
import { getServiceRoleClient } from '../_shared/supabaseClient.ts';

// --- Constants Definition ---
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN"); // postToSlack内で使用される
const SLACK_CHANNEL_ID = Deno.env.get("SLACK_CHANNEL_ID");
const SLACK_ERROR_CHANNEL_ID = Deno.env.get("SLACK_ERROR_CHANNEL_ID");
// Logiless Constants
const LOGILESS_CLIENT_ID = Deno.env.get("LOGILESS_CLIENT_ID");
const LOGILESS_CLIENT_SECRET = Deno.env.get("LOGILESS_CLIENT_SECRET");
const LOGILESS_REFRESH_TOKEN = Deno.env.get("LOGILESS_REFRESH_TOKEN");
const LOGILESS_TOKEN_ENDPOINT = Deno.env.get("LOGILESS_TOKEN_ENDPOINT") || "https://app2.logiless.com/oauth2/token"; // 正しいURL
const LOGILESS_MERCHANT_ID = Deno.env.get("LOGILESS_MERCHANT_ID"); // ★ 要設定 ★

// OpenAI/RAG Constants
const EMBEDDING_MODEL = "text-embedding-3-small";
const COMPLETION_MODEL = "gpt-4o-mini";
const MATCH_THRESHOLD = 0.7;
const MATCH_COUNT = 3;
const RPC_FUNCTION_NAME = "match_documents";

// Filtering Constants
const OPERATOR_PERSON_TYPES: Set<string> = new Set(['manager']);
const BOT_PERSON_TYPE = 'bot';
const IGNORED_BOT_MESSAGES: Set<string> = new Set([ /* 必要なら追加 */ ]);
// ★★★ Specific Bot Greeting to Ignore ★★★
const INITIAL_BOT_GREETING = `こんにちは。yeniカスタマーサポートです👩‍💻
お問い合わせ内容をお選びください。

🕙営業時間：平日10:00-18:00
※休業期間中や土日祝日などの営業時間外にはお返事を差し上げることができませんのでご注意ください。🙅‍♀️`.trim(); // Use trim to match the already trimmed messageText

// ★★★ NGキーワードリスト ★★★
const IGNORED_KEYWORDS: string[] = [
    "【新生活応援キャンペーン】",
    "ランドリーポーチ",
    // 他に通知を止めたいキーワードがあれば追加
];

// ★★★ Notify Only Messages (No AI/Logiless) ★★★
const NOTIFY_ONLY_MESSAGES: Set<string> = new Set([
    "以下の項目をお選びください👩‍💻",
    "FAQをご覧いただいても解決しない場合は「カスタマーサポートへ問い合わせる」を選択し、お困りの内容をお知らせください👩‍💻",
    "以下の情報をお知らせください💭\n-------------------------------\nアカウントの登録メールアドレス：\n-------------------------------",
    "スムーズなお問合せ対応のために連絡先をご入力ください。オフラインの際にSMSとメールに返信通知を送信します。\n\n(取得した個人情報はチャットに返信があったことを通知するためにのみ利用され、削除を要請するまで保有されます。入力しない場合は返信通知を受けることができません。)",
    "大変恐れ入りますが、現在営業時間外のためお返事を差し上げることができかねます。\n営業再開後に順次回答をお送りしておりますのでお待ちくださいませ。\n※カスタマーサポートの営業時間は以下でございます。\n🕙平日 10時〜18時",
    "最後にお悩みごとや気になること、ご相談したい内容をお知らせください💭\n専門の担当者が商品をご紹介いたします✨",
    "まずはご希望のアイテムをお選びいただけますでしょうか👩‍💻",
    "ストーリーズに返信しました",
    "ストーリーズであなたをメンションしました",
    "よくあるご質問"
].map(s => s.trim())); // Trim each message for consistency

// --- Type Definitions ---
interface ChannelioEntity { plainText: string; personType?: string; personId?: string; chatId?: string; workflowButton?: boolean; options?: string[]; }
interface ChannelioUser { name?: string; }
interface ChannelioRefers { user?: ChannelioUser; }
interface ChannelioWebhookPayload { event?: string; type?: string; entity: ChannelioEntity; refers?: ChannelioRefers; }
interface Document { content: string; source_type?: string; question?: string; }
// ★★ TODO: 実際のレスポンスを確認してフィールド名を最終確定 ★★
interface LogilessOrderData {
    id?: number | string;       // ★ 内部ID
    code?: string;              // 受注コード
    document_date?: string;   // ★ 注文日 (仮)
    posting_date?: string;
    status?: string;            // ★ ステータス (仮)
    delivery_status?: string;
    // lines?: any[]; // 商品リストはこのAPIレスポンスに含まれない可能性が高い
    // 他のレスポンスに含まれるフィールドがあれば追加 (要テスト確認)
}
interface LogilessTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
}

// --- Helper Function: Notify Error to Slack ---
async function notifyError(step: string, error: any, context: { query?: string; userId?: string; orderNumber?: string | null; chatId?: string | null }) { // ★ chatId を追加 ★
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const fallbackText = `:warning: Channelio Handler Error (${step})`;

    console.error(`[${step}] Error: ${errorMessage}`, context, stack);

    if (SLACK_ERROR_CHANNEL_ID) {
        const errorBlocks = [
            { "type": "header", "text": { "type": "plain_text", "text": ":warning: Channelio Webhook Handler Error", "emoji": true } },
            { "type": "section", "fields": [
                { "type": "mrkdwn", "text": `*Timestamp (UTC):*\\n${timestamp}` },
                { "type": "mrkdwn", "text": `*Failed Step:*\\n${step}` }
            ] },
            { "type": "section", "text": { "type": "mrkdwn", "text": `*Error Message:*\\n\\\`\\\`\\\`${errorMessage}\\\`\\\`\\\`` } }, // ★ エスケープ済 ★
            ...(stack ? [{ "type": "section", "text": { "type": "mrkdwn", "text": `*Stack Trace:*\\n\\\`\\\`\\\`${stack}\\\`\\\`\\\`` } }] : []), // ★ エスケープ済 ★
            { "type": "section", "text": { "type": "mrkdwn", "text": "*Context:*" } },
            { "type": "section", "fields": [
                 { "type": "mrkdwn", "text": `*Query:*\\n${context.query ?? 'N/A'}` },
                 { "type": "mrkdwn", "text": `*UserID:*\\n${context.userId ?? 'N/A'}` },
                 { "type": "mrkdwn", "text": `*Order#:*\n${context.orderNumber ?? 'N/A'}` },
                 { "type": "mrkdwn", "text": `*ChatID:*\\n${context.chatId ?? 'N/A'}` } // ★ chatId を追加 ★
            ] },
             { "type": "divider" }
        ];
        // Use the imported postToSlack (no thread needed for errors)
        await postToSlack(SLACK_ERROR_CHANNEL_ID, fallbackText, errorBlocks); // thread_ts は渡さない
    } else {
        const logMessage = `SLACK_ERROR_CHANNEL_ID not set. Error Details:\nTimestamp: ${timestamp}\nStep: ${step}\nError: ${errorMessage}\nStack: ${stack ?? 'N/A'}\nQuery: ${context.query ?? 'N/A'}\nUserID: ${context.userId ?? 'N/A'}\nOrder#: ${context.orderNumber ?? 'N/A'}\nChatID: ${context.chatId ?? 'N/A'}\n`; // ★ chatId を追加 ★
        console.error(logMessage);
    }
}

// ★★★ Logiless Access Token Helper (DB Refresh Token Update Version) ★★★
async function getLogilessAccessToken(): Promise<string | null> {
    const step = "LogilessAuthToken";
    const supabase = getServiceRoleClient(); // ★ Service Role Client を使用 ★

    if (!LOGILESS_CLIENT_ID || !LOGILESS_CLIENT_SECRET) { // Refresh token check removed from here
        console.error(`[${step}] Logiless client ID or secret is not set.`);
        throw new Error("Logiless client credentials are not configured.");
    }

    // 1. DBから現在のリフレッシュトークンを取得 ★★★
    let currentRefreshToken: string | null = null;
    try {
        const { data: tokenRow, error: selectError } = await supabase
            .from('logiless_auth')
            .select('refresh_token')
            .eq('id', 1) // 固定ID=1の行を想定
            .single();

        // PGRST116: No rows found - Treat as error because token should exist
        if (selectError) {
            throw selectError;
        }
        if (!tokenRow?.refresh_token) {
            throw new Error("Refresh token not found or is null in the database (id=1).");
        }
        currentRefreshToken = tokenRow.refresh_token;
        console.log(`[${step}] Retrieved current refresh token from DB.`);
    } catch (dbError) {
        console.error(`[${step}] Failed to retrieve refresh token from DB:`, dbError);
        // DBから取得できないのは致命的エラーとして扱う
        await notifyError(step, dbError, { query: 'N/A', userId: 'System', orderNumber: null, chatId: null });
        throw new Error(`Failed to retrieve refresh token from DB: ${dbError.message}`);
    }

    // 2. トークン発行API呼び出し (Method A: secret in body) ★★★
    try {
        console.log(`[${step}] Requesting Logiless access token using refresh token (secret in body) from ${LOGILESS_TOKEN_ENDPOINT}...`);
        const bodyA = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: currentRefreshToken, // ★ DBから取得したトークンを使用 ★
            client_id: LOGILESS_CLIENT_ID,
            client_secret: LOGILESS_CLIENT_SECRET
        });
        const responseA = await fetch(LOGILESS_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: bodyA.toString()
        });

        if (responseA.ok) {
            const tokenData: LogilessTokenResponse = await responseA.json();
            if (tokenData.access_token) {
                console.log(`[${step}] Token obtained successfully.`);

                // 3. 新しいリフレッシュトークンをDBに保存 ★★★
                if (tokenData.refresh_token && tokenData.refresh_token !== currentRefreshToken) {
                    try {
                        const { error: updateError } = await supabase
                            .from('logiless_auth')
                            .update({ refresh_token: tokenData.refresh_token, updated_at: new Date().toISOString() })
                            .eq('id', 1); // id=1 の行を更新
                        if (updateError) { throw updateError; }
                        console.log(`[${step}] Successfully updated refresh token in DB.`);
                    } catch (updateDbError) {
                        console.error(`[${step}] Failed to update refresh token in DB:`, updateDbError);
                        // DB更新失敗をエラー通知するが、処理は続行（アクセストークンは取得済み）
                        await notifyError("RefreshTokenUpdateFailed", updateDbError, { query: 'N/A', userId: 'System', orderNumber: null, chatId: null });
                    }
                } else {
                     console.log(`[${step}] No new refresh token received or it's the same. DB not updated.`);
                }

                return tokenData.access_token; // ★ アクセストークンを返す ★
            } else {
                 throw new Error("Method A: Invalid token response structure (missing access_token).");
            }
        } else {
            // Method A failed
            const errorStatusA = responseA.status;
            const errorTextA = await responseA.text();
            let detailedErrorMessage = `Logiless token request failed with status ${errorStatusA}: ${errorTextA.substring(0, 200)}`;
            if (errorTextA.toLowerCase().includes("invalid_grant")) { detailedErrorMessage += "\\nPOSSIBLE CAUSE: Refresh token in DB invalid/expired/revoked."; }
            else if (errorTextA.toLowerCase().includes("invalid_client")) { detailedErrorMessage += "\\nPOSSIBLE CAUSE: Client ID/Secret incorrect."; }
            else if (errorTextA.toLowerCase().includes("unsupported_grant_type")) { detailedErrorMessage += "\\nPOSSIBLE CAUSE: 'refresh_token' grant type not supported."; }
            console.error(`[${step}] Failed to get Logiless access token. Response:`, errorTextA);
            throw new Error(detailedErrorMessage);
        }
    } catch (error) { // Catch errors from fetch or explicit throws
        console.error(`[${step}] Unexpected error getting Logiless access token:`, error);
        // Throw a final error indicating failure
        throw new Error(`Failed to obtain Logiless token. Error: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// --- Main Background Processing Function ---
// Add skipAiProcessing parameter
async function processUserQuery(payload: ChannelioWebhookPayload, skipAiProcessing: boolean = false) {
    const query = payload.entity.plainText.trim();
    const customerName = payload.refers?.user?.name;
    const userId = payload.entity.personId;
    const chatId = payload.entity.chatId; // ★ chatId を取得 ★
    let existingThreadTs: string | null = null; // ★ スレッドTS用変数 ★
    let logilessOrderInfo: string | null = null;
    let logilessOrderUrl: string | null = null;
    let orderNumber: string | null = null;
    let orderId: string | null = null; // orderId も抽出するように修正
    let step = "Initialization";
    let supabase: SupabaseClient | null = null;
    let queryEmbedding: number[] | null = null;
    let retrievedDocs: Document[] = [];
    let referenceInfo: string = "関連ドキュメントは見つかりませんでした。";
    let aiResponse: string | null = null;

    try {
        // ★ スレッドID取得を追加 ★
        if (chatId) {
            step = "GetSlackThread";
            existingThreadTs = await getActiveThreadTs(chatId); // DBから取得試行
            console.log(`[${step}] Active thread for chatId ${chatId}: ${existingThreadTs || 'None found'}`);
        } else {
             console.warn("[GetSlackThread] Chat ID is missing, cannot manage thread.");
        }

        // 1. Extract Order Number (修正版)
        step = "OrderNumberExtraction";
        const orderNumberMatch = query.match(/yeni-(\d+-\d+)/i) || query.match(/yeni-(\d+)/i); // -n 付きも考慮
        orderNumber = orderNumberMatch ? orderNumberMatch[0].toLowerCase().replace(/^#/, '') : null;
        orderId = orderNumberMatch ? orderNumberMatch[1].split('-')[0] : null; // 詳細URL組み立てには使わないが抽出
        console.log(`[${step}] Extracted Order Number (for code param): ${orderNumber}, Potential internal ID part: ${orderId}`);

        // 2. Logiless API Interaction (if orderNumber found)
        if (orderNumber) { // orderIdチェックは不要
            let logilessAccessToken: string | null = null;
            // 2a. Get Access Token
            step = "LogilessAuthToken";
            try {
                logilessAccessToken = await getLogilessAccessToken();
            } catch (tokenError) {
                await notifyError(step, tokenError, { query, userId, orderNumber, chatId }); // ★ chatId 追加 ★
                logilessAccessToken = null;
                logilessOrderInfo = "ロジレス認証失敗";
            }

            // 2b. Call Logiless Order API using GET (if token obtained)
            if (logilessAccessToken) {
                step = "LogilessAPICall";
                try {
                    if (!LOGILESS_MERCHANT_ID) {
                        console.error(`[${step}] LOGILESS_MERCHANT_ID is not set.`);
                        logilessOrderInfo = "設定エラー: マーチャントID未設定";
                    } else {
                        // ★★★ GETメソッドと正しいエンドポイント、クエリパラメータを使用 ★★★
                        const logilessApiUrl = `https://app2.logiless.com/api/v1/merchant/${LOGILESS_MERCHANT_ID}/sales_orders?code=${encodeURIComponent(orderNumber)}`; // ★ /api/ 付き ★
                        console.log(`[${step}] Calling Logiless GET API: ${logilessApiUrl}`);

                        const response = await fetch(logilessApiUrl, {
                            method: 'GET',
                            headers: {
                                'Authorization': `Bearer ${logilessAccessToken}`,
                                'Accept': 'application/json'
                            }
                        });

                        if (response.ok) {
                            // ★★ TODO: レスポンスJSONをログ出力してフィールド名を確認 ★★
                            const data: LogilessOrderData[] | LogilessOrderData = await response.json();
                            console.log("[LogilessAPICall] Received Logiless API Response:", JSON.stringify(data, null, 2)); // ★ レスポンスログ追加 ★
                            let orderData: LogilessOrderData | undefined;

                            if (Array.isArray(data)) {
                                orderData = data.find(d => d.code?.toLowerCase() === orderNumber?.toLowerCase());
                            } else if (typeof data === 'object' && data !== null) {
                                if (data.code?.toLowerCase() === orderNumber?.toLowerCase()) {
                                     orderData = data;
                                } else {
                                    console.warn(`[${step}] Single object response code mismatch? Expected: ${orderNumber}, Got: ${data.code}. Assuming it's the correct one.`);
                                    orderData = data;
                                }
                            } else {
                                 console.warn(`[${step}] Unexpected Logiless response format:`, data);
                            }

                            if (orderData) {
                                 console.log(`[${step}] Logiless API Success. Found order data.`);
                                // ★★ TODO: 実際のフィールド名に合わせて修正 ★★
                                logilessOrderInfo = `注文日: ${orderData.document_date || '不明'}, ステータス: ${orderData.status || '不明'}`;
                                // ★★ 詳細URL組み立て (内部ID 'id' を使用 - 要フィールド名確認) ★★
                                const logilessInternalId = orderData.id; // ★ 要フィールド名確認 ★
                                if (logilessInternalId) {
                                    logilessOrderUrl = `https://app2.logiless.com/merchant/${LOGILESS_MERCHANT_ID}/sales_orders/${logilessInternalId}`;
                                } else {
                                    console.warn(`[${step}] Could not find internal Logiless order ID ('id' field - assumed) in the response.`);
                                    logilessOrderUrl = null;
                                }
                                console.log(`[${step}] Logiless Info: ${logilessOrderInfo}, URL: ${logilessOrderUrl}`);
                            } else {
                                logilessOrderInfo = `注文番号 ${orderNumber} のデータが見つかりませんでした。`;
                                console.log(`[${step}] Logiless API Success, but no matching order data found for ${orderNumber}.`);
                            }
                        } else if (response.status === 401 || response.status === 403) {
                             logilessOrderInfo = "ロジレスAPI権限エラー";
                             console.error(`[${step}] Logiless API auth error: ${response.status}`);
                             await notifyError(step, new Error(`Logiless API auth error: ${response.status}`), { query, userId, orderNumber, chatId });
                        } else if (response.status === 404) {
                            logilessOrderInfo = `注文番号 ${orderNumber} が見つからないか、APIパスが不正です(404)`;
                            console.error(`[${step}] Logiless GET API returned 404. URL: ${logilessApiUrl}`);
                            await notifyError(step, new Error(`Logiless GET API returned 404`), { query, userId, orderNumber, chatId });
                        } else {
                            logilessOrderInfo = "ロジレスAPIエラー";
                            const errorText = await response.text();
                            console.error(`[${step}] Logiless API request failed: ${response.status}, Response: ${errorText.substring(0, 500)}`);
                            await notifyError(step, new Error(`Logiless API request failed: ${response.status}`), { query, userId, orderNumber, chatId });
                        }
                    } // else ブロック終了 (マーチャントIDあり)
                } catch (apiError) {
                    if (!logilessOrderInfo) logilessOrderInfo = "ロジレス情報取得エラー";
                    await notifyError(step, apiError, { query, userId, orderNumber, chatId });
                }
            } // if (logilessAccessToken) 終了
        } else {
            console.log(`[LogilessProcessing] No valid order number found in query.`);
        }

        // Conditionally skip AI-related steps
        if (!skipAiProcessing) {
            // 3. Initialize Supabase Client (Anon Key)
            step = "InitializationSupabase";
            if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SLACK_CHANNEL_ID || !SLACK_ERROR_CHANNEL_ID) { throw new Error("Missing required environment variables."); }
            supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } } });
            console.log(`[${step}] Supabase client initialized.`);

            // 4. Vectorize Query
            step = "Vectorization";
            const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify({ input: query, model: EMBEDDING_MODEL }), });
            if (!embeddingResponse.ok) { const errorText = await embeddingResponse.text(); throw new Error(`OpenAI Embedding API request failed: ${embeddingResponse.status} ${errorText.substring(0, 200)}`); }
            const embeddingData = await embeddingResponse.json();
            queryEmbedding = embeddingData.data?.[0]?.embedding;
            if (!queryEmbedding) { throw new Error("Failed to generate embedding."); }
            console.log(`[${step}] Query vectorized.`);

            // 5. Search Documents (RAG Retrieval)
            step = "VectorSearch";
            if (!supabase) throw new Error("Supabase client not initialized for Vector Search.");
            const { data: documentsData, error: rpcError } = await supabase.rpc(RPC_FUNCTION_NAME, { query_embedding: queryEmbedding, match_threshold: MATCH_THRESHOLD, match_count: MATCH_COUNT });
            if (rpcError) { throw new Error(`Vector search RPC error: ${rpcError.message}`); }
            retrievedDocs = (documentsData as Document[]) || [];
            referenceInfo = retrievedDocs.length > 0 ? retrievedDocs.map(doc => `- ${doc.content}`).join('\n') : '関連ドキュメントは見つかりませんでした。';
            console.log(`[${step}] Vector search completed. Found ${retrievedDocs.length} documents.`);

            // 6. Generate AI Response (RAG Generation)
            step = "AICreation";
            const prompt = `
# あなたの役割
（省略）
# 顧客情報・コンテキスト
（省略）
--- ロジレス連携情報 ---
注文番号: ${orderNumber || '抽出できず'}
ロジレス情報: ${logilessOrderInfo || '連携なし/失敗'}
-------------------------
# 実行手順
（省略）
# 対応ガイドライン
（省略）
---
# 参考情報 (社内ドキュメントより):
${referenceInfo}
---
# お客様からの問い合わせ内容
\\\`\\\`\\\`
${query}
\\\`\\\`\\\`
回答案:
            `.trim();
            const completionPayload = { model: COMPLETION_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.5 };
            const completionResponse = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(completionPayload) });
            if (!completionResponse.ok) { const errorText = await completionResponse.text(); throw new Error(`OpenAI Chat Completion API request failed: ${completionResponse.status} ${errorText.substring(0, 200)}`); }
            const completionData = await completionResponse.json();
            aiResponse = completionData.choices?.[0]?.message?.content?.trim() || "(AIからの応答が空でした)";
            console.log(`[${step}] AI response generated.`);
        } else {
             console.log("[AIProcessing] Skipping AI steps based on skipAiProcessing flag.");
             // Ensure Supabase is initialized if needed for Slack utils, even if AI is skipped
             // Note: Slack utils currently don't require Supabase client directly, but good practice
             if (!supabase && (SLACK_CHANNEL_ID || SLACK_ERROR_CHANNEL_ID)) { // Check if Slack notification might happen
                 step = "InitializationSupabaseForSlack";
                 if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { console.warn("Missing Supabase URL/Key for potential Slack operations."); }
                 else {
                     supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } } });
                     console.log(`[${step}] Supabase client initialized (minimal for Slack).`);
                 }
             }
        }

        // 7. Post Results to Slack
        step = "SlackNotify";
        // Base blocks (Header, Customer Info, Logiless, Query)
        const baseBlocks = [
            { "type": "header", "text": { "type": "plain_text", "text": ":loudspeaker: 新しい問い合わせがありました", "emoji": true } },
            { "type": "section", "fields": [
                 { "type": "mrkdwn", "text": `*顧客名:* ${customerName || '不明'}` },
                 // { "type": "mrkdwn", "text": `*UserID:* ${userId || '不明'}` }, // UserIDは一旦省略
                 { "type": "mrkdwn", "text": `*Channelioリンク:* ${chatId ? `<https://yeni-beauty.channel.io/user-chats/${chatId}|チャットを開く>` : '不明'}` } // ★ ドメイン修正 ★
            ] },
            // --- Logiless Section ---
            { "type": "divider" },
            { "type": "section", "text": { "type": "mrkdwn", "text": "*<https://app2.logiless.com/|ロジレス連携結果>*" } },
            { "type": "section", "fields": [ { "type": "mrkdwn", "text": `*注文番号:* ${orderNumber || 'N/A'}` }, { "type": "mrkdwn", "text": `*情報ステータス:* ${logilessOrderInfo || '連携なし/失敗'}` } ]},
            (logilessOrderUrl ? { "type": "actions" as const, "elements": [{ "type": "button" as const, "text": { "type": "plain_text" as const, "text": "ロジレスで詳細を確認", "emoji": true }, "url": logilessOrderUrl, "style": "primary" as const, "action_id": "logiless_link_button" }] }
                            : { "type": "context" as const, "elements": [ { "type": "mrkdwn" as const, "text": "ロジレス詳細URL: なし" } ] }),
            // --- End of Logiless Section ---
            { "type": "divider" },
            { "type": "section", "text": { "type": "mrkdwn", "text": `*問い合わせ内容:*` } },
            { "type": "section", "text": { "type": "mrkdwn", "text": `\\\`\\\`\\\`\\n${query}\\n\\\`\\\`\\\`` } }
            // AI Section is added conditionally below
        ];

        let finalBlocks = [...baseBlocks];

        // Conditionally add AI section
        if (!skipAiProcessing && aiResponse) {
             finalBlocks.push(
                { "type": "divider" },
                { "type": "section", "text": { "type": "mrkdwn", "text": "*AIによる回答案:*" } },
                { "type": "section", "text": { "type": "mrkdwn", "text": `\\\`\\\`\\\`\\n${aiResponse}\\n\\\`\\\`\\\`` } }
            );
        } else if (!skipAiProcessing && !aiResponse) {
            // Handle case where AI processing was intended but failed/returned empty
             finalBlocks.push(
                { "type": "divider" },
                { "type": "section", "text": { "type": "mrkdwn", "text": "*AIによる回答案:*" } },
                { "type": "section", "text": { "type": "mrkdwn", "text": "_(AI処理スキップまたは応答生成失敗)_" } }
             );
        }
        // If skipAiProcessing is true, no AI section is added.

        const fallbackText = `新規問い合わせ: ${query.substring(0, 50)}... (顧客: ${customerName || '不明'})`;

        // ★ スレッドIDを渡し、戻り値を受け取る ★
        // Use finalBlocks here
        const newMessageTs = await postToSlack(SLACK_CHANNEL_ID, fallbackText, finalBlocks, existingThreadTs ?? undefined);

        // ★ 新規スレッドならDB保存 ★
        if (chatId && newMessageTs && !existingThreadTs) {
            step = "SaveSlackThread";
            await saveThreadTs(chatId, newMessageTs);
            console.log(`[${step}] New thread saved for chatId ${chatId} with ts ${newMessageTs}`); // ログ修正
        } else if (chatId && newMessageTs && existingThreadTs) { console.log(`[SlackNotify] Posted reply to existing thread ${existingThreadTs}`); }
        else if (!newMessageTs) { console.error(`[SlackNotify] Failed to post message to Slack for chatId ${chatId}.`); } // エラーログ修正
        console.log(`[SlackNotify] Notification process complete.`);

    } catch (error) {
        console.error(`Error during step ${step}:`, error);
        // ★ notifyError に chatId を渡す ★
        await notifyError(`ProcessUserQueryError-${step}`, error, { query, userId, orderNumber, chatId })
            .catch(e => console.error("PANIC: Failed to notify error within processUserQuery catch block:", e));
    }
}


// --- Deno Serve Entrypoint ---
serve(async (req: Request) => {
    // 1. Handle CORS preflight requests
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        // 2. Parse Incoming Webhook Payload
        const payload: ChannelioWebhookPayload = await req.json();
        // console.log("Received webhook payload:", JSON.stringify(payload, null, 2)); // 必要ならコメント解除

        // 3. Filter Requests (Revised)
        const entity = payload.entity;
        const personType = entity?.personType;
        const messageText = entity?.plainText?.trim();
        const eventType = payload.event;
        const messageType = payload.type;

        let skipReason: string | null = null;
        let triggerNotificationOnly = false; // Flag for notify-only messages

        if (eventType !== 'push' || messageType !== 'message') { skipReason = `Not a message push event (event: ${eventType}, type: ${messageType})`; }
        else if (!messageText) { skipReason = "empty message"; }
        else if (entity?.options?.includes("private")) { skipReason = "private message"; }
        else if (personType && OPERATOR_PERSON_TYPES.has(personType)) { skipReason = `operator message (type: ${personType})`; }
        // ★★★ Add check for the specific initial bot greeting ★★★
        else if (messageText === INITIAL_BOT_GREETING) { skipReason = "initial bot greeting"; }
        // ★★★ End of added check ★★★
        else if (personType === BOT_PERSON_TYPE && messageText && IGNORED_BOT_MESSAGES.has(messageText)) { skipReason = "ignored bot message"; }
        else if (entity?.workflowButton) { skipReason = "workflow button"; }
        else if (messageText && IGNORED_KEYWORDS.some(keyword => messageText.includes(keyword))) {
            const foundKeyword = IGNORED_KEYWORDS.find(keyword => messageText.includes(keyword));
            skipReason = `ignored keyword: ${foundKeyword}`;
        }
        // ★★★ Check for Notify Only Messages AFTER other filters ★★★
        else if (messageText && NOTIFY_ONLY_MESSAGES.has(messageText)) {
            triggerNotificationOnly = true;
            console.log(`[Filter] Identified as notify-only message: "${messageText.substring(0, 50)}..."`);
            // Not setting skipReason here, as we want to proceed to background processing
        }

        if (skipReason) {
            console.log(`[Filter] Skipping webhook processing: ${skipReason}`);
            return new Response(JSON.stringify({ status: "skipped", reason: skipReason }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
        }

        console.log("Webhook payload passed filters. Triggering background processing...");

        // 4. Trigger Background Processing
        globalThis.setTimeout(async () => {
            try {
                // Pass the flag to processUserQuery
                await processUserQuery(payload, triggerNotificationOnly);
            } catch (e) {
                console.error("Unhandled background error during processUserQuery invocation/execution:", e);
                const queryFromPayload = payload?.entity?.plainText;
                const userIdFromPayload = payload?.entity?.personId;
                const chatIdFromPayload = payload?.entity?.chatId;
                const potentialOrderNumberMatch = queryFromPayload?.match(/#?yeni-(\d+-\d+|\d+)/i); // Match yeni-123 or yeni-123-4
                const orderNumberFromPayload = potentialOrderNumberMatch ? potentialOrderNumberMatch[0].toLowerCase().replace(/^#/, '') : null;
                await notifyError("UnhandledBackgroundError", e, { query: queryFromPayload, userId: userIdFromPayload, orderNumber: orderNumberFromPayload, chatId: chatIdFromPayload })
                    .catch(notifyErr => console.error("PANIC: Failed to notify unhandled background error:", notifyErr));
            }
        }, 0);

        // 5. Return Immediate Success Response
        return new Response(JSON.stringify({ status: "received" }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });

    } catch (error) {
        console.error("Error handling initial request:", error);
        await notifyError("InitialRequestError", error, { query: 'Payload Parsing/Filtering Error', userId: 'Unknown', orderNumber: null, chatId: null })
            .catch(notifyErr => console.error("PANIC: Failed to notify initial request error:", notifyErr));
        // Return 500 for server-side errors during initial processing
        return new Response(JSON.stringify({ status: "error", message: "Internal Server Error" }), {
             headers: { ...corsHeaders, "Content-Type": "application/json" },
             status: 500,
        });
    }
}); // ★ serve() の閉じ括弧 ★

console.log("Channelio webhook handler function started (Logiless Refresh Token Auth, Slack Threading). Listening for requests...");
// ファイル終端