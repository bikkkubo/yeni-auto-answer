// deno-lint-ignore-file no-explicit-any no-unused-vars
// ↑ Deno/リンターエラー(誤検知)を抑制するためのコメント。不要なら削除可。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
// Base64エンコードはリフレッシュトークンフローでは通常不要

// --- 定数定義 ---
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
const SLACK_CHANNEL_ID = Deno.env.get("SLACK_CHANNEL_ID");
const SLACK_ERROR_CHANNEL_ID = Deno.env.get("SLACK_ERROR_CHANNEL_ID");
const LOGILESS_CLIENT_ID = Deno.env.get("LOGILESS_CLIENT_ID");
const LOGILESS_CLIENT_SECRET = Deno.env.get("LOGILESS_CLIENT_SECRET");
const LOGILESS_REFRESH_TOKEN = Deno.env.get("LOGILESS_REFRESH_TOKEN"); // ★ リフレッシュトークン
const LOGILESS_TOKEN_ENDPOINT = Deno.env.get("LOGILESS_TOKEN_ENDPOINT") || "https://app2.logiless.com/api/oauth2/token"; // ★★ TODO: 要確認 ★★
const LOGILESS_MERCHANT_ID = Deno.env.get("LOGILESS_MERCHANT_ID"); // ★★ TODO: 必要なら設定 ★★

const EMBEDDING_MODEL = "text-embedding-3-small";
const COMPLETION_MODEL = "gpt-4o-mini";
const MATCH_THRESHOLD = 0.7;
const MATCH_COUNT = 3;
const RPC_FUNCTION_NAME = "match_documents";

// フィルタリング用定数
const OPERATOR_PERSON_TYPES: Set<string> = new Set(['manager']);
const BOT_PERSON_TYPE = 'bot';
const IGNORED_BOT_MESSAGES: Set<string> = new Set([ /* ... リストは省略 ... */ ]);

// --- 型定義 ---
interface ChannelioEntity { plainText: string; personType?: string; personId?: string; chatId?: string; workflowButton?: boolean; options?: string[]; }
interface ChannelioUser { name?: string; }
interface ChannelioRefers { user?: ChannelioUser; }
interface ChannelioWebhookPayload { event?: string; type?: string; entity: ChannelioEntity; refers?: ChannelioRefers; }
interface Document { content: string; source_type?: string; question?: string; }
// ★★ TODO: ロジレスAPIレスポンスに合わせて修正 ★★
interface LogilessOrderData { code?: string; order_date?: string; items?: { name: string; quantity: number; }[]; status?: string; details_url?: string; }
interface LogilessTokenResponse { access_token: string; token_type: string; expires_in: number; refresh_token?: string; }

// --- ヘルパー関数: Slack通知 ---
async function postToSlack(channel: string, text: string, blocks?: any[]) {
    if (!SLACK_BOT_TOKEN) { console.error("SLACK_BOT_TOKEN is not set."); return; }
    try {
        const payload: { channel: string; text: string; blocks?: any[] } = { channel: channel, text: text };
        if (blocks) { payload.blocks = blocks; }
        const response = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8", "Authorization": `Bearer ${SLACK_BOT_TOKEN}` },
            body: JSON.stringify(payload),
        });
        if (!response.ok) { const errorData = await response.json(); console.error(`Failed to post message to Slack channel ${channel}: ${response.status}`, errorData); }
        else { const data = await response.json(); if (!data.ok) { console.error(`Slack API Error: ${data.error}`); } }
    } catch (error) { console.error(`Error posting to Slack channel ${channel}:`, error); }
}

// --- ヘルパー関数: エラー通知 ---
async function notifyError(step: string, error: any, context: { query?: string; userId?: string; orderNumber?: string | null; }) {
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const fallbackText = `:warning: Channelio 自動応答エラー発生 (${step})`;

    if (SLACK_ERROR_CHANNEL_ID) {
        const errorBlocks = [
            { "type": "header", "text": { "type": "plain_text", "text": ":warning: Channelio 自動応答エラー", "emoji": true } },
            { "type": "section", "fields": [
                { "type": "mrkdwn", "text": `*発生日時:*\n${new Date().toLocaleString('ja-JP')}` },
                { "type": "mrkdwn", "text": `*発生箇所:*\n${step}` }
            ] },
            { "type": "section", "text": { "type": "mrkdwn", "text": `*エラーメッセージ:*\n\\\`\\\`\\\`${errorMessage}\\\`\\\`\\\`` } }, // ★エスケープ済★
            ...(stack ? [{ "type": "section", "text": { "type": "mrkdwn", "text": `*スタックトレース:*\n\\\`\\\`\\\`${stack}\\\`\\\`\\\`` } }] : []), // ★エスケープ済★
            { "type": "section", "fields": [
                 { "type": "mrkdwn", "text": `*Query:*\n${context.query ?? 'N/A'}` },
                 { "type": "mrkdwn", "text": `*UserID:*\n${context.userId ?? 'N/A'}` },
                 { "type": "mrkdwn", "text": `*Order#:*\n${context.orderNumber ?? 'N/A'}` }
            ] },
             { "type": "divider" }
        ];
        await postToSlack(SLACK_ERROR_CHANNEL_ID, fallbackText, errorBlocks);
    } else {
        const logMessage = `\nError Timestamp: ${timestamp}\nError Step: ${step}\nError Message: ${errorMessage}\nStack Trace: ${stack ?? 'N/A'}\nQuery: ${context.query ?? 'N/A'}\nUserID: ${context.userId ?? 'N/A'}\nOrder#: ${context.orderNumber ?? 'N/A'}\n`;
        console.error("SLACK_ERROR_CHANNEL_ID is not set. Error details:", logMessage);
    }
}

// --- Logilessアクセストークン取得ヘルパー関数 (リフレッシュトークン版) ---
async function getLogilessAccessToken(): Promise<string | null> {
    const step = "LogilessAuthToken";
    if (!LOGILESS_CLIENT_ID || !LOGILESS_CLIENT_SECRET || !LOGILESS_REFRESH_TOKEN) {
        console.error(`[${step}] Logiless client credentials or refresh token is not set.`);
        throw new Error("Logiless refresh token or client credentials are not configured.");
    }
    try {
        console.log(`[${step}] Requesting Logiless access token using refresh token from ${LOGILESS_TOKEN_ENDPOINT}...`);
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: LOGILESS_REFRESH_TOKEN,
            client_id: LOGILESS_CLIENT_ID,
            client_secret: LOGILESS_CLIENT_SECRET // ★★ TODO: Basic認証が必要な場合は削除 ★★
        });
        const response = await fetch(LOGILESS_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                // ★★ TODO: Basic認証が必要な場合はコメント解除 ★★
                // 'Authorization': `Basic ${btoa(`${LOGILESS_CLIENT_ID}:${LOGILESS_CLIENT_SECRET}`)}`
            },
            body: body.toString()
        });
        if (!response.ok) {
             const errorStatus = response.status;
             const errorText = await response.text();
             let detailedErrorMessage = `Logiless token request failed with status ${errorStatus}: ${errorText.substring(0, 200)}`;
             if (errorText.toLowerCase().includes("invalid_grant")) { detailedErrorMessage += "\nPOSSIBLE CAUSE: Refresh token invalid/expired/revoked."; }
             else if (errorText.toLowerCase().includes("invalid_client")) { detailedErrorMessage += "\nPOSSIBLE CAUSE: Client ID/Secret incorrect."; }
             else if (errorText.toLowerCase().includes("unsupported_grant_type")) { detailedErrorMessage += "\nPOSSIBLE CAUSE: 'refresh_token' grant type not supported."; }
             console.error(`[${step}] Failed to get Logiless access token. Response:`, errorText);
             throw new Error(detailedErrorMessage);
        }
        const tokenData: LogilessTokenResponse = await response.json();
        if (!tokenData.access_token) { throw new Error("Logiless token response did not contain access_token."); }
        console.log(`[${step}] Logiless access token obtained successfully.`);
        return tokenData.access_token;
    } catch (error) { console.error(`[${step}] Unexpected error getting Logiless access token:`, error); throw error; }
}

// --- メインのバックグラウンド処理関数 ---
async function processUserQuery(payload: ChannelioWebhookPayload) {
    const query = payload.entity.plainText.trim();
    const customerName = payload.refers?.user?.name;
    const userId = payload.entity.personId;
    let logilessOrderInfo: string | null = null;
    let logilessOrderUrl: string | null = null;
    let orderNumber: string | null = null;
    let logilessAccessToken: string | null = null;
    let step = "Initialization";

    try {
        // ★ 注文番号の抽出 ★
        const orderNumberMatch = query.match(/#yeni-(\d+)/);
        orderNumber = orderNumberMatch ? orderNumberMatch[0] : null;
        const orderId = orderNumberMatch ? orderNumberMatch[1] : null;

        // ★ ロジレス処理 ★
        if (orderNumber && orderId) {
            step = "LogilessAuthToken";
            try { logilessAccessToken = await getLogilessAccessToken(); }
            catch (tokenError) { await notifyError(step, tokenError, { query, userId, orderNumber }); logilessAccessToken = null; logilessOrderInfo = "ロジレス認証失敗"; }

            if (logilessAccessToken) {
                step = "LogilessAPICall";
                try {
                    // ★★ TODO: エンドポイントURLとパラメータを確認・設定 ★★
                    const logilessApiUrl = `https://app2.logiless.com/api/v1/merchant/orders?code=${encodeURIComponent(orderNumber)}`;
                    const response = await fetch(logilessApiUrl, {
                        method: 'GET', // ★★ TODO: 要確認 ★★
                        headers: { 'Authorization': `Bearer ${logilessAccessToken}`, 'Accept': 'application/json' }
                    });
                    if (response.ok) {
                        const data: LogilessOrderData[] = await response.json(); // ★★ TODO: レスポンスが配列か確認 ★★
                        // ★★ TODO: 該当データ特定条件を確認 ★★
                        const orderData = data.find(d => d.code === orderNumber);
                        if (orderData) {
                            // ★★ TODO: 情報抽出 (フィールド名は仮定) ★★
                            const itemsText = orderData.items?.map(item => `${item.name}(${item.quantity})`).join(', ') || '商品情報なし';
                            logilessOrderInfo = `注文日: ${orderData.order_date || '不明'}, 商品: ${itemsText}, ステータス: ${orderData.status || '不明'}`;
                            // ★★ TODO: 詳細URL取得/組み立て ★★
                            logilessOrderUrl = orderData.details_url || (LOGILESS_MERCHANT_ID && orderId ? `https://app2.logiless.com/merchant/${LOGILESS_MERCHANT_ID}/sales_orders/${orderId}` : null);
                        } else { logilessOrderInfo = `注文番号 ${orderNumber} のデータが見つかりませんでした。`; }
                    } else if (response.status === 401 || response.status === 403) { logilessOrderInfo = "ロジレスAPI権限エラー"; throw new Error(`Logiless API auth error: ${response.status}`); }
                      else if (response.status === 404) { logilessOrderInfo = `注文番号 ${orderNumber} はロジレスで見つかりませんでした。`; }
                      else { logilessOrderInfo = "ロジレスAPIエラー"; throw new Error(`Logiless API request failed: ${response.status}`); }
                } catch (apiError) { await notifyError(step, apiError, { query, userId, orderNumber }); if (!logilessOrderInfo) logilessOrderInfo = "ロジレス情報取得エラー"; }
            }
        } else { console.log("[Logiless] No order number found."); }

        // --- 必須環境変数チェック ---
        if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID || !SLACK_ERROR_CHANNEL_ID) { throw new Error("Missing required environment variables."); }
        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }, });

        // --- 4. ベクトル化 ---
        step = "Vectorization"; /* ... */ const queryEmbedding = /* ... */;

        // --- 5. ベクトル検索 ---
        step = "VectorSearch"; /* ... */ const { data: documents, error: rpcError } = /* ... */; const retrievedDocs = /* ... */; const referenceInfo = /* ... */;

        // --- 6. AI回答生成 ---
        step = "AICreation";
        const prompt = `
            あなたの役割
            （省略）

            顧客情報・コンテキスト
            顧客名: ${customerName || '不明'}
            （省略）
            --- ロジレス連携情報 ---
            注文番号: ${orderNumber || '抽出できず'}
            ロジレス情報: ${logilessOrderInfo || '連携なし/失敗'}
            実行手順
            （省略）

            対応ガイドライン
            （省略）
            参考情報
            ${referenceInfo}
            お客様からの問い合わせ内容
            ${query}
            回答案:
        `.trim(); // ★ エスケープ済みのプロンプト内容をここに含める（長いため省略）
        const completionResponse = await fetch(/* ... */);
        /* ... */ const aiResponse = /* ... */;

        // --- 7. Slack通知 ---
        step = "SlackNotify";
        const blocks = [
            /* ... ヘッダー、顧客情報 ... */
            { "type": "section", "text": { "type": "mrkdwn", "text": `*問い合わせ内容:*\n\\\`\\\`\\\`${query}\\\`\\\`\\\`` } }, // ★エスケープ済★
            { "type": "divider" },
            { "type": "section", "fields": [ /* ... ロジレス情報 ... */ ] },
            (logilessOrderUrl ? { "type": "actions", "elements": [ /* ... ボタン ... */ ] } : { "type": "context", "elements": [ /* ... URLなし ... */ ] }),
            { "type": "divider" },
            { "type": "section", "text": { "type": "mrkdwn", "text": `*AIによる回答案:*` } },
            { "type": "section", "text": { "type": "mrkdwn", "text": `\\\`\\\`\\\`${aiResponse}\\\`\\\`\\\`` } } // ★エスケープ済★
        ];
        const fallbackText = /* ... */;
        await postToSlack(SLACK_CHANNEL_ID, fallbackText, blocks);
        console.log(`[${step}] Notification sent successfully.`);

    } catch (error) { console.error(`Error during step ${step}:`, error); throw error; }
}

// --- Deno Serve エントリーポイント ---
serve(async (req: Request) => {
    /* ... (フィルタリングロジック等、前回同様) ... */
    processUserQuery(payload).catch(async (e) => {
        console.error("Unhandled background error in processUserQuery:", e);
        const queryFromPayload = payload.entity?.plainText;
        const userIdFromPayload = payload.entity?.personId;
        await notifyError("UnhandledProcessError", e, { query: queryFromPayload, userId: userIdFromPayload, orderNumber: null }).catch(/* ... */);
    });
    /* ... (即時応答) ... */
});

console.log("Channelio webhook handler function started (with Logiless Refresh Token Auth). Listening for requests...");
```
*(注: 上記コードでは、見やすさのため一部の既存コードブロックを `/* ... */` で省略しています。全体を置き換える際は、省略されていない完全なコードを使用してください。)*
*(注2: プロンプト文字列 (`prompt`) とSlack通知ブロック (`blocks`) 内のバッククォートエスケープ (`\\\`\\\`\\\``) が正しく行われていることを確認してください。)*