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

// OpenAI/RAG Constants (Updated for Hybrid Search)
const EMBEDDING_MODEL = "text-embedding-3-small";
const COMPLETION_MODEL = "o4-mini-2025-04-16"; // または利用したいモデル
// const MATCH_THRESHOLD = 0.7; // <- Old constant, remove or comment out
// const MATCH_COUNT = 3; // <- Old constant, remove or comment out
// const RPC_FUNCTION_NAME = "match_documents"; // <- Old constant, remove or comment out
const HYBRID_RPC_FUNCTION_NAME = "hybrid_search_faq_chunks"; // <- New RPC function name
// const MATCH_THRESHOLD_VECTOR = 0.7; // ベクトル類似度の閾値 <- Remove
// const MATCH_THRESHOLD_TRIGRAM = 0.1; // pg_trgm類似度の閾値 (低めに設定) <- Remove
// const WEIGHT_VECTOR = 0.6; // ベクトルスコアの重み <- Remove
// const WEIGHT_TRIGRAM = 0.4; // pg_trgmスコアの重み <- Remove

// ───────── Hybrid‑Search Constants (env‑driven) ─────────
// Note: dotenv/load.ts is often better loaded at the very top if possible
// but placing it here to be close to usage based on the snippet.
// Ensure .env exists in the project root or adjust path.
import "https://deno.land/std@0.210.0/dotenv/load.ts";

const env = Deno.env.toObject();             // .env.* を取り込む

const SEARCH_K          = Number(env.SEARCH_K          ?? 3);    // Default to 3 if not set
const THRESH_VEC        = Number(env.THRESHOLD_VECTOR  ?? 0.7);
const THRESH_TRI        = Number(env.THRESHOLD_TRIGRAM ?? 0.1);
const WEIGHT_VEC        = Number(env.WEIGHT_VECTOR     ?? 0.6);
const WEIGHT_TRI        = Number(env.WEIGHT_TRIGRAM    ?? 0.4);

console.log("Hybrid Search Params:", { SEARCH_K, THRESH_VEC, THRESH_TRI, WEIGHT_VEC, WEIGHT_TRI }); // Log loaded params

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
    "【4/14（月）先行予約販売開始】ノンワイヤーブラ、ショーツ再入荷と新サイズ登場✨️",
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
// New type for hybrid search results
interface HybridSearchResult {
  id: string; // uuid
  question: string;
  content: string;
  similarity_vector: number;
  similarity_trigram: number;
  final_score: number;
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

// --- Helper Function: Detect Bra Sizing Query ---
function isBraSizingQuery(query: string): boolean {
    const lowerQuery = query.toLowerCase();
    const keywords = ["サイズ", "カップ", "アンダー", "トップ", "大きい", "小さい", "きつい", "ゆるい", "ブラ", "ブラジャー", "測り方", "選び方", "g80", "c75"];
    const sizePattern = /[a-zA-Z]+[0-9]+/;

    const keywordMatch = keywords.some(kw => lowerQuery.includes(kw));
    const patternMatch = sizePattern.test(lowerQuery);

    console.log(`[isBraSizingQuery Debug] lowerQuery: ${lowerQuery.substring(0,100)}...`); // Log first 100 chars
    console.log(`[isBraSizingQuery Debug] keywordMatch: ${keywordMatch}`);
    console.log(`[isBraSizingQuery Debug] patternMatch: ${patternMatch}`);

    return keywordMatch || patternMatch;
}

// --- Helper Function: Extract Bra Size Info ---
interface ExtractedBraInfo {
    under?: number;
    top?: number;
    cup?: string;
}

function extractBraSizeInfo(query: string): ExtractedBraInfo {
    const info: ExtractedBraInfo = {};

    // Extract numbers preceded by アンダー or under (e.g., アンダー80)
    const underMatch = query.match(/(?:アンダー|under)\s*[:：]?\s*(\d{2,3})/i);
    if (underMatch?.[1]) {
        info.under = parseInt(underMatch[1], 10);
    }

    // Extract numbers preceded by トップ or top (e.g., トップ107)
    const topMatch = query.match(/(?:トップ|top)\s*[:：]?\s*(\d{2,3})/i);
    if (topMatch?.[1]) {
        info.top = parseInt(topMatch[1], 10);
    }

    // Extract cup size (e.g., G80 -> G, Gカップ -> G) - prioritize standard format first
    const standardSizeMatch = query.match(/([a-zA-Z]+)\s*(\d{2,3})/i);
     if (standardSizeMatch?.[1] && standardSizeMatch?.[2]) {
        info.cup = standardSizeMatch[1].toUpperCase();
        // If under wasn't extracted specifically, try getting it from standard size
        if (!info.under) {
            info.under = parseInt(standardSizeMatch[2], 10);
        }
    } else {
        // Try matching "Gカップ" format
        const cupLetterMatch = query.match(/([a-jA-J])\s*カップ/i);
        if (cupLetterMatch?.[1]) {
            info.cup = cupLetterMatch[1].toUpperCase();
        }
    }
     // Simple extraction for "普段G80" - Overwrite if more specific matches found above
    const usualSizeMatch = query.match(/普段\s*([a-zA-Z]+)(\d{2,3})/i);
     if (usualSizeMatch?.[1] && !info.cup) {
         info.cup = usualSizeMatch[1].toUpperCase();
     }
     if (usualSizeMatch?.[2] && !info.under) {
         info.under = parseInt(usualSizeMatch[2], 10);
     }


    console.log("[extractBraSizeInfo] Extracted:", info);
    return info;
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
    let retrievedDocs: HybridSearchResult[] = []; // <- Use new type
    let referenceInfo: string = "関連ドキュメントは見つかりませんでした。";
    let aiResponse: string | null = null;
    let isSizingQuery = false;
    let extractedInfo: ExtractedBraInfo = {};
    let recommendedYeniSize: string | null = null;
    let sizeNote: string | null = null;

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

            // 5. Search Documents (RAG Retrieval using Hybrid Search)
            step = "HybridSearch";
            if (!supabase) throw new Error("Supabase client not initialized for Hybrid Search.");
            if (!queryEmbedding) throw new Error("Query embedding not generated.");
            console.log(`[${step}] Calling RPC: ${HYBRID_RPC_FUNCTION_NAME}`);
            const { data: documentsData, error: rpcError } = await supabase.rpc(
                HYBRID_RPC_FUNCTION_NAME, // <- Use new RPC name
                {
                    // Pass all required arguments
                    query_embedding: queryEmbedding,
                    query_text: query, // Pass original query text
                    match_threshold_vector: THRESH_VEC,
                    match_threshold_trigram: THRESH_TRI,
                    match_count: SEARCH_K,
                    weight_vector: WEIGHT_VEC,
                    weight_trigram: WEIGHT_TRI
                }
            );
            if (rpcError) { throw new Error(`Hybrid search RPC error: ${rpcError.message}`); }
            // Use the new type for casting
            retrievedDocs = (documentsData as HybridSearchResult[]) || [];
            // referenceInfo logic remains similar, using doc.content
            referenceInfo = retrievedDocs.length > 0 ? retrievedDocs.map(doc => `- ${doc.content} (Score: ${doc.final_score.toFixed(3)})`).join('\n') : '関連ドキュメントは見つかりませんでした。';
            console.log(`[${step}] Hybrid search completed. Found ${retrievedDocs.length} documents.`);
            // Log scores for debugging if needed
            // if(retrievedDocs.length > 0) { console.log("Search Results:", retrievedDocs.map(d => ({ score: d.final_score, content: d.content.substring(0, 50) + '...' }))); }

            // 6. Generate AI Response (RAG Generation - Prompt uses referenceInfo)
            step = "AICreation";
            const prompt = `
# あなたの役割
顧客からの問い合わせに対し、提供された情報を元に親切丁寧な回答案を作成するカスタマーサポートAIです。

# Yeni製品に関する基本情報 ★★★★★重要★★★★★
*   現在、主に「ノンワイヤーブラ」と「レースノンワイヤーブラ」の2種類のブラを提供しています。
*   これら2種類のブラは、基本的な形状とサイズ感は共通です。
*   「フルカップ」や「3/4カップ」といった他のカップ形状のブラは提供していません。

# 顧客情報・コンテキスト
顧客名: ${customerName || '不明'}
（他に必要なコンテキストがあれば追加）

--- ロジレス連携情報 ---
注文番号: ${orderNumber || '抽出できず'}
ロジレス情報: ${logilessOrderInfo || '連携なし/失敗'}
-------------------------

# 実行手順
1.  お客様の問い合わせ内容と、提供された情報をよく読んでください。
2.  問い合わせ内容がサイズに関する相談の場合、以下の「サイズに関するガイドライン」に従って回答を生成してください。
3.  その他の問い合わせの場合は、「一般的な対応ガイドライン」に従ってください。
4.  常に丁寧で、共感的な言葉遣いを心がけてください。

# サイズに関するガイドライン ★★★★★重要★★★★★
1.  **測定値/現在サイズの特定:** お客様の問い合わせから、アンダーバスト、トップバスト、または現在着用しているブラのサイズ（例: G80）を特定します。
2.  **参考情報の参照:** 提供されている「参考情報」の中から、yeniのサイズ表やサイズに関する推奨事項が**明確に記載されている箇所**を探します。
3.  **yeniサイズへのマッピング:** 特定した測定値や標準サイズに**対応するyeni独自のサイズ表記（例: S1, M2, L3, L4など）が参考情報内に明確に見つかるか**を確認します。
    **重要:** 参考情報の中に、お客様のサイズ（測定値または標準サイズ）に対応する**具体的なyeniサイズ表記が見つからない場合は、サイズを推定したり、存在しないサイズコード（例: L5）を作り出したりしないでください。** **以下の「サイズ推奨不可の場合の回答」に従ってください。**
4.  **回答の構成 (yeniサイズが見つかった場合):**
    *   まず、お客様の状況（測定値、悩み）に共感を示します。
    *   次に、**参考情報から見つけたyeniのサイズ表記（例: L4）を明確に提示**し、「L4（アンダーバスト75cm〜80cm／G〜Hカップ）をおすすめいたします。」のように、対応する説明も（参考情報にあれば）添えて推奨します。データベースからの推奨であることを伝えても構いません。
    *   **注意:** 回答文の中で、最終的な推奨サイズとして一般的なサイズ表記（G80など）は**使用しないでください**。必ずyeniのサイズ表記を使ってください。
    *   **製品に関する言及:** ブラ本体以外の製品（パッド、アクセサリー等）について言及する場合は、**必ず「参考情報」セクションにその製品に関する記述がある場合に限定してください。** 参考情報に記載のない製品名を提案したり、存在しない製品（例：「専用パッド」）を示唆したりしてはいけません。左右差の調整についてパッドに言及する場合は、「お手持ちのパッド」「薄手のパッド」といった一般的な表現に留めてください。（参考情報があれば、それに従ってください）
    *   必要に応じて、サイズ交換に関する情報（参考情報にあれば）も付け加えます。
    *   最後は、お客様を気遣う言葉で締めくくります。

# サイズ推奨不可の場合の回答 ★★★★★重要★★★★★
1.  まず、お問い合わせいただいたことへの感謝と、お客様の状況への共感を伝えます。
2.  次に、「申し訳ございませんが、いただいた情報だけでは明確なサイズをおすすめすることができません。」のように、**推奨できない旨を正直に伝えてください。**
3.  続けて、**以下のように追加情報をお尋ねください。**
    *   「よろしければ、ご検討中のブラの種類（ノンワイヤーブラ、またはレースノンワイヤーブラ）と、ご希望のフィット感（例：ゆったりめ、しっかりホールド）を教えていただけますでしょうか？」
    *   **注意:** この際、yeniで提供していないブラのタイプ（例: フルカップ、3/4カップ）には**絶対に言及しないでください。** また、ノンワイヤーブラとレースノンワイヤーブラの形状が大きく異なると示唆するような表現も避けてください。
4.  最後は、お客様を気遣う言葉で締めくくります。

# 一般的な対応ガイドライン
（省略 - 既存のガイドラインがあればここに記述）

---
# 参考情報 (FAQ検索結果 - サイズ以外の補足情報として利用):
${referenceInfo}
---
# お客様からの問い合わせ内容
\`\`\`
${query}
\`\`\`
回答案:
            `.trim();
            const completionPayload = { model: COMPLETION_MODEL, messages: [{ role: "user", content: prompt }] };
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

        // ★★★ Unescape backslashes and newlines for proper Slack mrkdwn rendering ★★★
        // Replace literal \n with newline character
        // Replace literal \\ with single \
        const unescapedQuery = query.replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
        const unescapedAiResponse = aiResponse ? aiResponse.replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : null;

        // Base blocks (Header, Customer Info, Logiless, Query)
        const baseBlocks = [
            { "type": "header", "text": { "type": "plain_text", "text": ":loudspeaker: 新しい問い合わせがありました", "emoji": true } },
            { "type": "section", "fields": [
                 { "type": "mrkdwn", "text": `*顧客名:* ${customerName || '不明'}` },
                 // { "type": "mrkdwn", "text": `*UserID:* ${userId || '不明'}` }, // UserIDは一旦省略
                 { "type": "mrkdwn", "text": `*Channelioリンク:* ${chatId ? `<https://desk.channel.io/#/channels/96452/user_chats/${chatId}|チャットを開く>` : '不明'}` } // Use new URL format
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
            { "type": "section", "text": { "type": "mrkdwn", "text": `\`\`\`\n${unescapedQuery}\n\`\`\`` } }
            // AI Section is added conditionally below
        ];

        let finalBlocks = [...baseBlocks];

        // Conditionally add AI section
        if (!skipAiProcessing && unescapedAiResponse) {
             finalBlocks.push(
                { "type": "divider" },
                { "type": "section", "text": { "type": "mrkdwn", "text": "*AIによる回答案:*" } },
                { "type": "section", "text": { "type": "mrkdwn", "text": `\`\`\`\n${unescapedAiResponse}\n\`\`\`` } }
            );
        } else if (!skipAiProcessing && !unescapedAiResponse) {
            // Handle case where AI processing was intended but failed/returned empty
             finalBlocks.push(
                { "type": "divider" },
                { "type": "section", "text": { "type": "mrkdwn", "text": "*AIによる回答案:*" } },
                { "type": "section", "text": { "type": "mrkdwn", "text": "_(AI処理スキップまたは応答生成失敗)_" } }
             );
        }
        // If skipAiProcessing is true, no AI section is added.

        const fallbackText = `新規問い合わせ: ${unescapedQuery.substring(0, 50)}... (顧客: ${customerName || '不明'})`;

        // ★★★ アクションボタンを追加 ★★★
        // valueにはJSON文字列を埋め込む (文字数制限に注意)
        // threadTsはこの時点では確定していない可能性があるため、ハンドラ側で取得する前提とする
        const feedbackContextValue = JSON.stringify({
            originalQuery: unescapedQuery,
            chatId: chatId
            // threadTs は slack-interactive-handler 側で payload から取得する
        });

        // ボタンは skipAiProcessing フラグに関わらず表示する
        finalBlocks.push(
            { "type": "divider" },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "今後AIの回答を生成しない",
                            "emoji": true
                        },
                        "action_id": "ignore_ai_button",
                        "value": feedbackContextValue.substring(0, 2000) // Ensure value is within limit
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "今後通知不要",
                            "emoji": true
                        },
                        "action_id": "ignore_notification_button",
                        "style": "danger",
                        "value": feedbackContextValue.substring(0, 2000) // Ensure value is within limit
                    }
                ]
            }
        );

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

        // 3. Filter Requests (Revised) - Add detailed logging
        const entity = payload.entity;
        const personType = entity?.personType;
        const messageText = entity?.plainText?.trim();
        const eventType = payload.event;
        const messageType = payload.type;

        let skipReason: string | null = null;
        let triggerNotificationOnly = false; // Flag for notify-only messages

        console.log("[Filter Debug] Start filtering..."); // Add start log

        if (eventType !== 'push' || messageType !== 'message') {
            skipReason = `Not a message push event (event: ${eventType}, type: ${messageType})`;
            console.log(`[Filter Debug] ${skipReason}`); // Log reason
        } else if (!messageText) {
            skipReason = "empty message";
            console.log(`[Filter Debug] ${skipReason}`); // Log reason
        } else if (entity?.options?.includes("private")) {
            skipReason = "private message";
            console.log(`[Filter Debug] ${skipReason}`); // Log reason
        } else if (personType && OPERATOR_PERSON_TYPES.has(personType)) {
            skipReason = `operator message (type: ${personType})`;
            console.log(`[Filter Debug] ${skipReason}`); // Log reason
        } else if (messageText === INITIAL_BOT_GREETING) {
            skipReason = "initial bot greeting";
            console.log(`[Filter Debug] ${skipReason}`); // Log reason
        } else if (personType === BOT_PERSON_TYPE && messageText && IGNORED_BOT_MESSAGES.has(messageText)) {
            skipReason = "ignored bot message";
            console.log(`[Filter Debug] ${skipReason}`); // Log reason
        } else if (entity?.workflowButton) {
            skipReason = "workflow button";
            console.log(`[Filter Debug] ${skipReason}`); // Log reason
        } else if (messageText && IGNORED_KEYWORDS.some(keyword => messageText.includes(keyword))) {
            const foundKeyword = IGNORED_KEYWORDS.find(keyword => messageText.includes(keyword));
            skipReason = `ignored keyword: ${foundKeyword}`;
            console.log(`[Filter Debug] ${skipReason}`); // Log reason
        } else if (messageText && NOTIFY_ONLY_MESSAGES.has(messageText)) {
            triggerNotificationOnly = true;
            console.log(`[Filter Debug] Identified as notify-only message: "${messageText.substring(0, 50)}..."`);
            // Not setting skipReason here, as we want to proceed to background processing
        }

        console.log(`[Filter Debug] Filtering complete. skipReason: ${skipReason}, triggerNotificationOnly: ${triggerNotificationOnly}`); // Add end log

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