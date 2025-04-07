// deno-lint-ignore-file no-explicit-any no-unused-vars
// ↑ Deno/リンターエラー(誤検知)を抑制するためのコメント。不要なら削除可。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
// Import js-base64 for Basic Auth encoding
import { Base64 } from 'npm:js-base64@^3.7.7'; // js-base64 パッケージをインポート

// --- Constants Definition ---
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY"); // Use ANON key for client, SERVICE_ROLE for admin tasks if needed elsewhere
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
const SLACK_CHANNEL_ID = Deno.env.get("SLACK_CHANNEL_ID");
const SLACK_ERROR_CHANNEL_ID = Deno.env.get("SLACK_ERROR_CHANNEL_ID");
// Logiless Constants (Ensure these are set in Supabase Secrets)
const LOGILESS_CLIENT_ID = Deno.env.get("LOGILESS_CLIENT_ID");
const LOGILESS_CLIENT_SECRET = Deno.env.get("LOGILESS_CLIENT_SECRET");
const LOGILESS_REFRESH_TOKEN = Deno.env.get("LOGILESS_REFRESH_TOKEN");
const LOGILESS_TOKEN_ENDPOINT = Deno.env.get("LOGILESS_TOKEN_ENDPOINT") || "https://app2.logiless.com/api/oauth2/token"; // ★★ TODO: Verify this URL ★★
const LOGILESS_MERCHANT_ID = Deno.env.get("LOGILESS_MERCHANT_ID"); // ★★ TODO: Set if needed for detail URL ★★

const EMBEDDING_MODEL = "text-embedding-3-small";
const COMPLETION_MODEL = "gpt-4o-mini"; // Or your preferred model
const MATCH_THRESHOLD = 0.7;
const MATCH_COUNT = 3;
const RPC_FUNCTION_NAME = "match_documents"; // Assumed RPC function for vector search

// Filtering Constants
const OPERATOR_PERSON_TYPES: Set<string> = new Set(['manager']); // Add other operator types if any
const BOT_PERSON_TYPE = 'bot';
const IGNORED_BOT_MESSAGES: Set<string> = new Set([
    /* Add specific bot message texts to ignore, e.g., auto-replies */
]);

// --- Type Definitions ---
interface ChannelioEntity {
    plainText: string;
    personType?: string;
    personId?: string;
    chatId?: string;
    workflowButton?: boolean;
    options?: string[]; // Ensure this exists for private message check
}
interface ChannelioUser { name?: string; }
interface ChannelioRefers { user?: ChannelioUser; }
interface ChannelioWebhookPayload { event?: string; type?: string; entity: ChannelioEntity; refers?: ChannelioRefers; }
interface Document { content: string; source_type?: string; question?: string; }
// Logiless Types (Adjust fields based on actual API response)
// ★★ TODO: Verify Logiless API response structure and update these types ★★
interface LogilessOrderData {
    code?: string; // The #yeni-xxxxx number
    order_date?: string;
    items?: { name: string; quantity: number; }[];
    status?: string;
    details_url?: string; // Direct URL if provided by API
    // Add other relevant fields
}
interface LogilessTokenResponse {
    access_token: string;
    token_type: string; // Usually "Bearer"
    expires_in: number; // Validity duration in seconds
    refresh_token?: string; // May or may not be returned on refresh
}

// --- Helper Function: Post to Slack ---
async function postToSlack(channel: string, text: string, blocks?: any[]) {
    if (!SLACK_BOT_TOKEN) {
        console.error("SLACK_BOT_TOKEN is not set.");
        return; // Don't throw, just log and exit
    }
    try {
        const payload: { channel: string; text: string; blocks?: any[] } = {
            channel: channel,
            text: text, // Fallback text for notifications
        };
        if (blocks) {
            payload.blocks = blocks; // Rich Block Kit message
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
            const errorData = await response.text(); // Read as text first for more details
            console.error(`Failed to post message to Slack channel ${channel}: ${response.status} ${response.statusText}. Response: ${errorData.substring(0, 500)}`);
        } else {
            const data = await response.json();
            if (!data.ok) {
                console.error(`Slack API Error posting to ${channel}: ${data.error}`);
            }
        }
    } catch (error) {
        console.error(`Error posting to Slack channel ${channel}:`, error);
    }
}

// --- Helper Function: Notify Error to Slack ---
async function notifyError(step: string, error: any, context: { query?: string; userId?: string; orderNumber?: string | null; }) {
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
            { "type": "section", "text": { "type": "mrkdwn", "text": `*Error Message:*\\n\\\`\\\`\\\`${errorMessage}\\\`\\\`\\\`` } }, // Escaped backticks
            ...(stack ? [{ "type": "section", "text": { "type": "mrkdwn", "text": `*Stack Trace:*\\n\\\`\\\`\\\`${stack}\\\`\\\`\\\`` } }] : []), // Escaped backticks
            { "type": "section", "text": { "type": "mrkdwn", "text": "*Context:*" } },
            { "type": "section", "fields": [
                 { "type": "mrkdwn", "text": `*Query:*\\n${context.query ?? 'N/A'}` },
                 { "type": "mrkdwn", "text": `*UserID:*\\n${context.userId ?? 'N/A'}` },
                 { "type": "mrkdwn", "text": `*Order#:*\\n${context.orderNumber ?? 'N/A'}` }
            ] },
             { "type": "divider" }
        ];
        // Use the postToSlack helper
        await postToSlack(SLACK_ERROR_CHANNEL_ID, fallbackText, errorBlocks);
    } else {
        // Log detailed error if Slack channel is not configured
        console.error(
            `SLACK_ERROR_CHANNEL_ID not set. Error Details:\n` +
            `Timestamp: ${timestamp}\n` +
            `Step: ${step}\n` +
            `Error: ${errorMessage}\n` +
            `Stack: ${stack ?? 'N/A'}\n` +
            `Query: ${context.query ?? 'N/A'}\n` +
            `UserID: ${context.userId ?? 'N/A'}\n` +
            `Order#: ${context.orderNumber ?? 'N/A'}`
        );
    }
}

// ★★★ Logiless Access Token Helper (Method A/B Trial Version) ★★★
async function getLogilessAccessToken(): Promise<string | null> {
    const step = "LogilessAuthToken";
    if (!LOGILESS_CLIENT_ID || !LOGILESS_CLIENT_SECRET || !LOGILESS_REFRESH_TOKEN) {
        console.error(`[${step}] Logiless client credentials or refresh token is not set.`);
        throw new Error("Logiless refresh token or client credentials are not configured.");
    }

    // --- Method A (secret in body) ---
    try {
        console.log(`[${step}] Attempting method A (secret in body)...`);
        const bodyA = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: LOGILESS_REFRESH_TOKEN,
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
                console.log(`[${step}] Method A Success! Token obtained.`);
                return tokenData.access_token;
            } else { throw new Error("Method A: Invalid token response structure."); }
        } else {
            const errorStatusA = responseA.status;
            const errorTextA = await responseA.text();
            console.warn(`[${step}] Method A Failed (${errorStatusA}): ${errorTextA.substring(0, 200)}`);
            // Try Method B only if Method A failed with a likely auth method error (400/401)
            if (errorStatusA !== 401 && errorStatusA !== 400) {
                 // Throw if it's a server error (5xx) or other non-auth-related client error
                 throw new Error(`Method A failed definitively: ${errorStatusA} - ${errorTextA.substring(0,100)}`);
            }
            // If 400/401, proceed to Method B
        }
    } catch (errorA) {
        // Catch errors from fetch itself or explicit throws within Method A try block
        console.warn(`[${step}] Error during Method A attempt:`, errorA instanceof Error ? errorA.message : String(errorA));
        // If Method A failed definitively, rethrow to prevent trying Method B
        if (errorA instanceof Error && errorA.message.startsWith("Method A failed definitively")) {
            throw errorA;
        }
        // Otherwise, assume it's worth trying Method B
    }

    // --- Method B (Basic Auth) ---
    try {
         console.log(`[${step}] Trying Method B (Basic Auth)...`);
         const bodyB = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: LOGILESS_REFRESH_TOKEN
            // client_id, client_secret are NOT included in the body for Basic Auth
        });
        // Use Base64.encode from js-base64
        const encodedCredentials = Base64.encode(`${LOGILESS_CLIENT_ID}:${LOGILESS_CLIENT_SECRET}`);
        const responseB = await fetch(LOGILESS_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${encodedCredentials}`
            },
            body: bodyB.toString()
        });

        if (responseB.ok) {
            const tokenData: LogilessTokenResponse = await responseB.json();
            if (tokenData.access_token) {
                console.log(`[${step}] Method B Success! Token obtained.`);
                return tokenData.access_token;
            } else { throw new Error("Method B: Invalid token response structure."); }
        } else {
            // Method B failed, report the error definitively
            const errorStatusB = responseB.status;
            const errorTextB = await responseB.text();
            console.error(`[${step}] Method B Failed (${errorStatusB}): ${errorTextB.substring(0, 200)}`);
            throw new Error(`Both Method A and B failed. Method B error: ${errorStatusB} - ${errorTextB.substring(0,100)}`);
        }
    } catch (errorB) {
        // Catch errors from fetch itself or explicit throws within Method B try block
        console.error(`[${step}] Error during Method B attempt:`, errorB instanceof Error ? errorB.message : String(errorB));
        // Throw a final error indicating both methods failed
        throw new Error(`Failed to obtain Logiless token using both methods. Last error: ${errorB instanceof Error ? errorB.message : String(errorB)}`);
    }
}

// --- Main Background Processing Function ---
async function processUserQuery(payload: ChannelioWebhookPayload) {
    // Extract key info early for context
    const query = payload.entity.plainText.trim();
    const customerName = payload.refers?.user?.name;
    const userId = payload.entity.personId;
    const chatId = payload.entity.chatId;

    // Variables to hold results from different steps
    let logilessOrderInfo: string | null = null;
    let logilessOrderUrl: string | null = null;
    let orderNumber: string | null = null;
    let step = "Initialization";
    let supabase: SupabaseClient | null = null;
    let queryEmbedding: number[] | null = null;
    let retrievedDocs: Document[] = [];
    let referenceInfo: string = "関連ドキュメントは見つかりませんでした。";
    let aiResponse: string | null = null;

    try {
        // 1. Extract Order Number
        step = "OrderNumberExtraction";
        const orderNumberMatch = query.match(/#yeni-(\d+)/i); // Case-insensitive match
        orderNumber = orderNumberMatch ? orderNumberMatch[0] : null;
        const orderId = orderNumberMatch ? orderNumberMatch[1] : null;
        console.log(`[${step}] Extracted Order Number: ${orderNumber}`);

        // 2. Logiless API Interaction (if order number found)
        if (orderNumber && orderId) {
            let logilessAccessToken: string | null = null;
            // 2a. Get Access Token
            step = "LogilessAuthToken";
            try {
                logilessAccessToken = await getLogilessAccessToken();
            } catch (tokenError) {
                // Notify error but continue processing if possible (logilessOrderInfo will indicate failure)
                await notifyError(step, tokenError, { query, userId, orderNumber });
                logilessAccessToken = null;
                logilessOrderInfo = "ロジレス認証失敗"; // Set failure status
            }

            // 2b. Call Logiless Order API (if token obtained)
            if (logilessAccessToken) {
                step = "LogilessAPICall";
                try {
                    // ★★ TODO: Verify API endpoint URL and query parameter structure ★★
                    const logilessApiUrl = `https://app2.logiless.com/api/v1/merchant/orders?code=${encodeURIComponent(orderNumber)}`;
                    console.log(`[${step}] Calling Logiless API: ${logilessApiUrl}`);

                    const response = await fetch(logilessApiUrl, {
                        method: 'GET', // ★★ TODO: Verify HTTP method (GET, POST, etc.) ★★
                        headers: {
                            'Authorization': `Bearer ${logilessAccessToken}`, // Use the obtained token
                            'Accept': 'application/json'
                        }
                    });

                    if (response.ok) {
                        // ★★ TODO: Verify if the response is an array or single object ★★
                        const data: LogilessOrderData[] | LogilessOrderData = await response.json();
                        let orderData: LogilessOrderData | undefined;

                        // Find the specific order if response is an array
                        if (Array.isArray(data)) {
                             // ★★ TODO: Verify the condition to find the correct order (e.g., matching code) ★★
                            orderData = data.find(d => d.code === orderNumber);
                        } else {
                            // Assume single object response matches the requested order code
                            orderData = data;
                        }

                        if (orderData) {
                            console.log(`[${step}] Logiless API Success. Found order data.`);
                            // ★★ TODO: Extract relevant information based on actual LogilessOrderData fields ★★
                            const itemsText = orderData.items?.map(item => `${item.name}(${item.quantity})`).join(', ') || '商品情報なし';
                            logilessOrderInfo = `注文日: ${orderData.order_date || '不明'}, 商品: ${itemsText}, ステータス: ${orderData.status || '不明'}`;

                            // ★★ TODO: Determine detail URL - use API field or construct it ★★
                            logilessOrderUrl = orderData.details_url || (LOGILESS_MERCHANT_ID && orderId ? `https://app2.logiless.com/merchant/${LOGILESS_MERCHANT_ID}/sales_orders/${orderId}` : null);
                            console.log(`[${step}] Logiless Info: ${logilessOrderInfo}, URL: ${logilessOrderUrl}`);
                        } else {
                            logilessOrderInfo = `注文番号 ${orderNumber} のデータが見つかりませんでした。`;
                            console.log(`[${step}] Logiless API Success, but order ${orderNumber} not found in response.`);
                        }
                    } else if (response.status === 401 || response.status === 403) {
                        logilessOrderInfo = "ロジレスAPI権限エラー";
                        console.error(`[${step}] Logiless API auth error: ${response.status}`);
                        // Don't throw here, let the process continue with error info
                        await notifyError(step, new Error(`Logiless API auth error: ${response.status}`), { query, userId, orderNumber });
                    } else if (response.status === 404) {
                        logilessOrderInfo = `注文番号 ${orderNumber} はロジレスで見つかりませんでした。`;
                        console.log(`[${step}] Logiless API returned 404 for order ${orderNumber}`);
                    } else {
                        logilessOrderInfo = "ロジレスAPIエラー";
                        const errorText = await response.text();
                        console.error(`[${step}] Logiless API request failed: ${response.status}, Response: ${errorText.substring(0, 500)}`);
                        await notifyError(step, new Error(`Logiless API request failed: ${response.status}`), { query, userId, orderNumber });
                    }
                } catch (apiError) {
                    // Catch unexpected errors during fetch/processing
                    if (!logilessOrderInfo) logilessOrderInfo = "ロジレス情報取得エラー"; // Set generic error if not already set
                    await notifyError(step, apiError, { query, userId, orderNumber });
                }
            }
        } else {
            console.log(`[LogilessProcessing] No valid order number found in query.`);
        }

        // 3. Check Environment Variables & Initialize Supabase Client
        step = "Initialization";
        if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID || !SLACK_ERROR_CHANNEL_ID) {
            throw new Error("Missing required environment variables.");
        }
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
             global: { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
             // Optional: Add fetch options like timeout if needed
        });
        console.log(`[${step}] Environment variables checked, Supabase client initialized.`);

        // 4. Vectorize Query using OpenAI Embeddings API
        step = "Vectorization";
        const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({ input: query, model: EMBEDDING_MODEL }),
        });
        if (!embeddingResponse.ok) {
            const errorText = await embeddingResponse.text();
            throw new Error(`OpenAI Embedding API request failed: ${embeddingResponse.status} ${errorText.substring(0, 200)}`);
        }
        const embeddingData = await embeddingResponse.json();
        queryEmbedding = embeddingData.data?.[0]?.embedding;
        if (!queryEmbedding) {
            throw new Error("Failed to generate embedding for the query.");
        }
        console.log(`[${step}] Query vectorized successfully.`);

        // 5. Search Relevant Documents using Supabase Vector Search (RPC)
        step = "VectorSearch";
        const { data: documentsData, error: rpcError } = await supabase.rpc(RPC_FUNCTION_NAME, {
            query_embedding: queryEmbedding,
            match_threshold: MATCH_THRESHOLD,
            match_count: MATCH_COUNT,
        });
        if (rpcError) {
            throw new Error(`Vector search RPC error: ${rpcError.message}`);
        }
        retrievedDocs = (documentsData as Document[]) || [];
        referenceInfo =
            retrievedDocs.length > 0
                ? retrievedDocs.map(doc => `- ${doc.content}`).join('\n')
                : '関連ドキュメントは見つかりませんでした。';
        console.log(`[${step}] Vector search completed. Found ${retrievedDocs.length} documents.`);

        // 6. Generate AI Response using OpenAI Chat Completions API
        step = "AICreation";
        // Construct the prompt incorporating Logiless info
        const prompt = `
あなたの役割:
あなたはChannel.ioで顧客対応を行うECサイト「Yeni」のオペレーター向けアシスタントです。顧客からの問い合わせ内容と、関連する社内ドキュメント、およびロジレス（在庫・注文管理システム）からの注文情報を基に、オペレーターが顧客に返信するための丁寧で正確な回答案を作成してください。

顧客情報・コンテキスト:
顧客名: ${customerName || '不明'}
問い合わせ内容受信日時: ${new Date().toLocaleString('ja-JP')}
--- ロジレス連携情報 ---
注文番号: ${orderNumber || '抽出できず'}
ロジレス情報: ${logilessOrderInfo || '連携なし/失敗'}

実行手順:
1. 問い合わせ内容と参考情報、ロジレス情報を理解します。
2. 対応ガイドラインに従って、回答案を作成します。
3. 不明な点やオペレーターの判断が必要な場合は、その旨を回答案に含めます。

対応ガイドライン:
- 常に丁寧な言葉遣いを心がけてください（ですます調）。
- 顧客名は適宜使用してください。
- 問い合わせに対する直接的な回答を簡潔に含めてください。
- 参考情報やロジレス情報に基づいて、可能な限り具体的かつ正確な情報を提供してください。
- ロジレス連携でエラーが発生した場合、顧客には直接伝えず、「確認します」といった表現に留め、Slack通知内の情報に基づきオペレーターが判断するように促してください。
- ロジレス情報が見つからない場合も同様に、「確認します」と回答案に記述してください。
- 回答案はオペレーターがそのままコピー＆ペーストできるよう、完成した文章形式で提供してください。
- 解決できない、またはオペレーターの特別な対応が必要な問い合わせについては、その旨を明確に示してください。

参考情報 (社内ドキュメントより):
${referenceInfo}

# お客様からの問い合わせ内容
\\\`\\\`\\\`
${query}
\\\`\\\`\\\`

回答案:
        `.trim();

        const completionPayload = {
            model: COMPLETION_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5, // Adjust creativity/determinism
            // max_tokens: 500, // Optional: Limit response length
        };

        const completionResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify(completionPayload),
        });

        if (!completionResponse.ok) {
            const errorText = await completionResponse.text();
            throw new Error(`OpenAI Chat Completion API request failed: ${completionResponse.status} ${errorText.substring(0, 200)}`);
        }
        const completionData = await completionResponse.json();
        aiResponse = completionData.choices?.[0]?.message?.content?.trim() || null;
        if (!aiResponse) {
            // Handle cases where the response is empty or malformed
            console.warn(`[${step}] AI response was empty or could not be extracted.`, completionData);
            aiResponse = "(AIからの応答が空でした)"; // Provide a fallback message
            // Optionally throw an error if an empty response is critical
            // throw new Error("Failed to get valid AI response content.");
        }
        console.log(`[${step}] AI response generated successfully.`);

        // 7. Post Results to Slack
        step = "SlackNotify";
        const blocks = [
            { "type": "header", "text": { "type": "plain_text", "text": ":loudspeaker: 新しい問い合わせがありました", "emoji": true } },
            { "type": "section", "fields": [
                { "type": "mrkdwn", "text": `*顧客名:*\\n${customerName || '不明'}` },
                { "type": "mrkdwn", "text": `*Channelioリンク:*\\n不明` } // 取得方法がなければ不明のまま
            ] },
            { "type": "section", "text": { "type": "mrkdwn", "text": `*問い合わせ内容:*` } },
            { "type": "section", "text": { "type": "mrkdwn", "text": `\\\`\\\`\\\`${query}\\\`\\\`\\\`` } }, // エスケープ済
            { "type": "divider" }, // ★区切り線★
            { "type": "section", "text": { "type": "mrkdwn", "text": "*<https://app2.logiless.com/|ロジレス連携結果>*" } }, // ★見出し★
            { "type": "section", "fields": [
                { "type": "mrkdwn", "text": `*注文番号:*\\n${orderNumber || 'N/A'}` },
                { "type": "mrkdwn", "text": `*情報ステータス:*\\n${logilessOrderInfo || '連携なし/失敗'}` }
            ]},
            (logilessOrderUrl ? { // ★URLボタン (強調)★
                "type": "actions" as const,
                "elements": [{ 
                    "type": "button" as const,
                    "text": { "type": "plain_text" as const, "text": "ロジレスで詳細を確認", "emoji": true },
                    "url": logilessOrderUrl, 
                    "style": "primary" as const, // ★強調スタイル★
                    "action_id": "logiless_link_button" 
                }]
            } : { // ★URLなしテキスト★
                 "type": "context" as const,
                 "elements": [ { "type": "mrkdwn" as const, "text": "ロジレス詳細URL: なし" } ] 
            }),
            { "type": "divider" }, // ★区切り線★
            { "type": "section", "text": { "type": "mrkdwn", "text": "*AIによる回答案:*" } }, // ★見出し★
        	{ "type": "section", "text": { "type": "mrkdwn", "text": `\\\`\\\`\\\`${aiResponse || '(AI回答生成エラー)'}\\\`\\\`\\\`` } } // エスケープ済
            // 参照ドキュメントの表示は削除
        ];
        const fallbackText = `新規問い合わせ: ${query.substring(0, 50)}... (顧客: ${customerName || '不明'})`;

        await postToSlack(SLACK_CHANNEL_ID, fallbackText, blocks);
        console.log(`[${step}] Notification sent to Slack channel ${SLACK_CHANNEL_ID}.`);

        // --- Optionally: Post AI response back to Channel.io (if needed) ---
        /*
        if (chatId && aiResponse) {
            step = "ChannelioReply";
            try {
                // Assuming a function sendChannelioPrivateMessage exists in _shared/channelio.ts
                // await sendChannelioPrivateMessage(chatId, aiResponse);
                console.log(`[${step}] AI response posted back to Channel.io chat ${chatId}.`);
            } catch (replyError) {
                await notifyError(step, replyError, { query, userId, orderNumber });
            }
        }
        */

    } catch (error) {
        // Catch errors from any step within the main try block
        console.error(`Error during step ${step}:`, error);
        // Notify the error, ensuring context is passed
        await notifyError(`ProcessUserQueryError-${step}`, error, { query, userId, orderNumber })
            .catch(e => console.error("PANIC: Failed to notify error within processUserQuery catch block:", e));
        // Do not re-throw here to allow the background task to finish gracefully after notification
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
        console.log("Received webhook payload:", JSON.stringify(payload, null, 2));

        // 3. Filter Requests
        const entity = payload.entity;
        const personType = entity?.personType;
        const messageText = entity?.plainText?.trim();

        // 3a. Skip private messages (often from bots, including potentially our own replies)
        if (entity?.options?.includes("private")) {
            console.log("[Filter] Skipping private message.");
            return new Response(JSON.stringify({ status: "skipped", reason: "private message" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // 3b. Skip messages from operators/managers
        if (personType && OPERATOR_PERSON_TYPES.has(personType)) {
            console.log(`[Filter] Skipping message from operator type: ${personType}`);
            return new Response(JSON.stringify({ status: "skipped", reason: "operator message" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // 3c. Skip specific ignored bot messages (prevent loops)
        if (personType === BOT_PERSON_TYPE && messageText && IGNORED_BOT_MESSAGES.has(messageText)) {
            console.log("[Filter] Skipping known ignored bot message.");
            return new Response(JSON.stringify({ status: "skipped", reason: "ignored bot message" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // 3d. Skip workflow button responses if they trigger webhooks
        if (entity?.workflowButton) {
            console.log("[Filter] Skipping workflow button response.");
            return new Response(JSON.stringify({ status: "skipped", reason: "workflow button" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // 3e. Skip empty messages
        if (!messageText) {
             console.log("[Filter] Skipping empty message.");
             return new Response(JSON.stringify({ status: "skipped", reason: "empty message" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        console.log("Webhook payload passed filters. Triggering background processing...");

        // 4. Trigger Background Processing (DO NOT await)
        // Use setTimeout to ensure the function runs truly in the background after the response is sent
        globalThis.setTimeout(async () => {
            try {
                await processUserQuery(payload);
            } catch (e) {
                // This catch block handles errors thrown synchronously from processUserQuery
                // or rejects from the promise if processUserQuery itself was async and threw unexpectedly early.
                // Errors *within* processUserQuery's async operations should be caught by its internal try/catch.
                console.error("Unhandled background error during processUserQuery invocation/execution:", e);
                // Attempt to notify this unexpected error
                const queryFromPayload = payload?.entity?.plainText;
                const userIdFromPayload = payload?.entity?.personId;
                const potentialOrderNumberMatch = queryFromPayload?.match(/#yeni-(\d+)/i);
                const orderNumberFromPayload = potentialOrderNumberMatch ? potentialOrderNumberMatch[0] : null;
                await notifyError("UnhandledBackgroundError", e, {
                    query: queryFromPayload,
                    userId: userIdFromPayload,
                    orderNumber: orderNumberFromPayload
                }).catch(notifyErr => console.error("PANIC: Failed to notify unhandled background error:", notifyErr));
            }
        }, 0);

        // 5. Return Immediate Success Response (200 OK)
        // Acknowledge receipt of the webhook immediately
        return new Response(JSON.stringify({ status: "received" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });

    } catch (error) {
        // Handle errors during request parsing, filtering, or synchronous setup before backgrounding
        console.error("Error handling initial request:", error);
        // Attempt to notify this critical error
        await notifyError("InitialRequestError", error, { query: 'Payload Parsing/Filtering Error', userId: 'Unknown', orderNumber: null })
            .catch(notifyErr => console.error("PANIC: Failed to notify initial request error:", notifyErr));

        // Return an error response to the webhook sender
        return new Response(JSON.stringify({ status: "error", message: error.message }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400, // Bad Request or 500 Internal Server Error depending on error type
        });
    }
});

console.log("Channelio webhook handler function started (Logiless Refresh Token Auth). Listening for requests...");