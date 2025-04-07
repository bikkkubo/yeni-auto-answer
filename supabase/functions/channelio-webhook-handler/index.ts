// deno-lint-ignore-file no-explicit-any no-unused-vars
// ↑ Deno/リンターエラー(誤検知)を抑制するためのコメント。不要なら削除可。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts"; // {1}
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2"; // {2}
import { corsHeaders } from "../_shared/cors.ts"; // {3}
// Import js-base64 for Basic Auth encoding
// import { Base64 } from 'npm:js-base64@^3.7.7'; // js-base64 パッケージをインポート // {4}

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
const LOGILESS_TOKEN_ENDPOINT = Deno.env.get("LOGILESS_TOKEN_ENDPOINT") || "https://app2.logiless.com/oauth2/token";
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

// ★★★ NGキーワードリスト (これらの単語が含まれていたらスキップ) ★★★
const IGNORED_KEYWORDS: string[] = [
    "【新生活応援キャンペーン】", // 画像の例
    "ランドリーポーチ",         // 画像の例から推測
    // 他に通知を止めたいキーワードがあれば追加
    // "特定のプロモーション名",
    // "アンケート回答"
];

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
// ★★ LogilessOrderData 型定義修正 ★★
interface LogilessOrderData {
    id?: number | string;       // ★ 内部ID (数値か文字列か要確認)
    code?: string;              // 受注コード
    document_date?: string;   // ★ 注文日 (仮)
    posting_date?: string; // 転記日?
    status?: string;            // ★ ステータス (仮)
    delivery_status?: string; // 配送ステータス?
    lines?: any[]; // ★ 商品リスト (中身の構造は不明なためany[]) - 詳細取得が必要な可能性あり
    // 他のレスポンスに含まれるフィールドがあれば追加
}
// LogilessAPIレスポンス全体の型を追加
interface LogilessSearchResponse {
    data: LogilessOrderData[];
}

// --- Helper Function: Post to Slack ---
async function postToSlack(channel: string, text: string, blocks?: any[]) { // {5}
    if (!SLACK_BOT_TOKEN) { // {6}
        console.error("SLACK_BOT_TOKEN is not set.");
        return;
    } // {6}
    try { // {7}
        const payload: { channel: string; text: string; blocks?: any[] } = { // {8}
            channel: channel,
            text: text, // Fallback text for notifications
        }; // {8}
        if (blocks) { // {9}
            payload.blocks = blocks; // Rich Block Kit message
        } // {9}

        const response = await fetch("https://slack.com/api/chat.postMessage", { // {10}
            method: "POST",
            headers: { // {11}
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
            }, // {11}
            body: JSON.stringify(payload),
        }); // {10}

        if (!response.ok) { // {12}
            const errorData = await response.text(); // Read as text first for more details
            console.error(`Failed to post message to Slack channel ${channel}: ${response.status} ${response.statusText}. Response: ${errorData.substring(0, 500)}`);
        } else { // {12}
            const data = await response.json();
            if (!data.ok) { // {13}
                console.error(`Slack API Error posting to ${channel}: ${data.error}`);
            } // {13}
        } // {12}
    } catch (error) { // {7}
        console.error(`Error posting to Slack channel ${channel}:`, error);
    } // {7}
} // {5}

// --- Helper Function: Notify Error to Slack ---
async function notifyError(step: string, error: any, context: { query?: string; userId?: string; orderNumber?: string | null; }) { // {14}
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const fallbackText = `:warning: Channelio Handler Error (${step})`;

    console.error(`[${step}] Error: ${errorMessage}`, context, stack);

    if (SLACK_ERROR_CHANNEL_ID) { // {15}
        const errorBlocks = [ // {16}
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
        ]; // {16}
        // Use the postToSlack helper
        await postToSlack(SLACK_ERROR_CHANNEL_ID, fallbackText, errorBlocks);
    } else { // {15}
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
    } // {15}
} // {14}

// ★★★ Logiless Access Token Helper (Method A - ボディにSecret) ★★★
async function getLogilessAccessToken(): Promise<string | null> { // {17}
    const step = "LogilessAuthToken";
    if (!LOGILESS_CLIENT_ID || !LOGILESS_CLIENT_SECRET || !LOGILESS_REFRESH_TOKEN) { // {18}
        console.error(`[${step}] Logiless client credentials or refresh token is not set.`);
        throw new Error("Logiless refresh token or client credentials are not configured.");
    } // {18}

    // --- Method A (secret in body) ---
    try { // {19}
        console.log(`[${step}] Requesting Logiless access token using refresh token (secret in body) from ${LOGILESS_TOKEN_ENDPOINT}...`);
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

        if (responseA.ok) { // {20}
            const tokenData: LogilessTokenResponse = await responseA.json();
            if (tokenData.access_token) { // {21}
                console.log(`[${step}] Token obtained successfully.`);
                return tokenData.access_token;
            } else { // {21}
                console.error(`[${step}] Invalid token response structure (missing access_token):`, tokenData);
                throw new Error("Method A: Invalid token response structure.");
            } // {21}
        } else { // {20}
            // Method A failed
            const errorStatusA = responseA.status;
            const errorTextA = await responseA.text();
            let detailedErrorMessage = `Logiless token request failed with status ${errorStatusA}: ${errorTextA.substring(0, 200)}`;
            if (errorTextA.toLowerCase().includes("invalid_grant")) { detailedErrorMessage += "\nPOSSIBLE CAUSE: Refresh token invalid/expired/revoked."; }
            else if (errorTextA.toLowerCase().includes("invalid_client")) { detailedErrorMessage += "\nPOSSIBLE CAUSE: Client ID/Secret incorrect."; }
            else if (errorTextA.toLowerCase().includes("unsupported_grant_type")) { detailedErrorMessage += "\nPOSSIBLE CAUSE: 'refresh_token' grant type not supported."; }
            console.error(`[${step}] Failed to get Logiless access token. Response:`, errorTextA);
            throw new Error(detailedErrorMessage);
        }
    } catch (error) { // Catch errors from fetch or explicit throws
        console.error(`[${step}] Unexpected error getting Logiless access token:`, error);
        // Throw a final error indicating failure
        throw new Error(`Failed to obtain Logiless token. Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Method B logic is completely removed
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
    let orderId: string | null = null;
    let step = "Initialization";
    let supabase: SupabaseClient | null = null;
    let queryEmbedding: number[] | null = null;
    let retrievedDocs: Document[] = [];
    let referenceInfo: string = "関連ドキュメントは見つかりませんでした。";
    let aiResponse: string | null = null;

    try {
        // 1. Extract Order Number
        step = "OrderNumberExtraction";
        // "yeni-" (大文字小文字無視) の後に続く数字を抽出
        const orderNumberMatch = query.match(/yeni-(\d+)/i);
        let orderNumber: string | null = null; // マッチした文字列全体 (例: YENI-11316)
        let orderId: string | null = null;     // 数字部分 (例: 11316)

        if (orderNumberMatch) {
            orderNumber = orderNumberMatch[0]; // マッチした部分全体を取得
            orderId = orderNumberMatch[1];     // 数字部分を取得
        } else {
             console.log(`[${step}] No 'yeni-XXXXX' format found in query.`);
             // 必要であれば、数字のみの抽出ロジックをここに追加検討
        }
        console.log(`[${step}] Extracted Order Number: ${orderNumber}, Order ID: ${orderId}`); // IDもログ出力

        // 2. Logiless API Interaction (if orderNumber AND orderId found) // orderIdもチェック
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
                if (!LOGILESS_MERCHANT_ID) { // {33}
                    console.error(`[${step}] LOGILESS_MERCHANT_ID is not set.`);
                    logilessOrderInfo = "設定エラー: マーチャントID未設定";
                    logilessAccessToken = null;
                } else { // {33}
                    try { // {32} - try ブロック開始
                    if (!LOGILESS_MERCHANT_ID) { // {33}
                        console.error(`[${step}] LOGILESS_MERCHANT_ID is not set.`);
                        logilessOrderInfo = "設定エラー: マーチャントID未設定";
                    } else { // {33} - マーチャントIDがある場合
                        const logilessApiUrl = `https://app2.logiless.com/v1/merchant/${LOGILESS_MERCHANT_ID}/sales_orders/search`; // ★ Searchエンドポイント ★
                        const requestBody = { codes: [orderNumber] }; // ★ リクエストボディ ★

                        console.log(`[${step}] Calling Logiless Search API: ${logilessApiUrl}`, requestBody);

                        const response = await fetch(logilessApiUrl, {
                            method: 'POST', // ★ POSTメソッド ★
                            headers: {
                                'Authorization': `Bearer ${logilessAccessToken}`,
                                'Content-Type': 'application/json', // ★ Content-Type ★
                                'Accept': 'application/json'
                            },
                            body: JSON.stringify(requestBody) // ★ ボディをJSON化 ★
                        });

                        if (response.ok) { // {34} - レスポンスOK
                            const responseData: LogilessSearchResponse = await response.json(); // ★ レスポンス全体の型 ★
                            const orders: LogilessOrderData[] = responseData.data || []; // ★ data配列を取得 ★
                            let orderData: LogilessOrderData | undefined;

                            if (orders && orders.length > 0) { // {35} - 結果配列に要素があるか
                                // codeが一致する最初の注文を取得 (念のため)
                                orderData = orders.find(d => d.code?.toLowerCase() === orderNumber?.toLowerCase());

                                if (orderData) { // {36} - 一致する注文が見つかった
                                     console.log(`[${step}] Logiless API Success. Found order data.`);
                                    // ★★ 情報抽出 (フィールド名は仮定、商品情報は lines を見るか別途取得) ★★
                                    logilessOrderInfo = `注文日: ${orderData.document_date || '不明'}, ステータス: ${orderData.status || '不明'}`; // 商品情報を削除

                                    // ★★ 詳細URL組み立て (内部ID 'id' を使用) ★★
                                    const logilessInternalId = orderData.id;
                                    if (logilessInternalId) {
                                        logilessOrderUrl = `https://app2.logiless.com/merchant/${LOGILESS_MERCHANT_ID}/sales_orders/${logilessInternalId}`;
                                    } else {
                                        console.warn(`[${step}] Could not find internal Logiless order ID ('id' field) in the response.`);
                                        logilessOrderUrl = null;
                                    }
                                    console.log(`[${step}] Logiless Info: ${logilessOrderInfo}, URL: ${logilessOrderUrl}`);

                                } else { // {36} - codeが一致するものがなかった場合
                                     logilessOrderInfo = `注文番号 ${orderNumber} に完全に一致するデータが見つかりませんでした。`;
                                     console.log(`[${step}] Logiless API Success, but no exact code match found for ${orderNumber} in response array.`);
                                } // {36}
                            } else { // {35} - 結果配列が空の場合
                                logilessOrderInfo = `注文番号 ${orderNumber} のデータが見つかりませんでした (空の結果)。`;
                                console.log(`[${step}] Logiless API Success, but response data array is empty for code ${orderNumber}.`);
                            } // {35}
                        } else if (response.status === 401 || response.status === 403) { // {34} - 認証エラー
                             logilessOrderInfo = "ロジレスAPI権限エラー";
                             console.error(`[${step}] Logiless API auth error: ${response.status}`);
                             await notifyError(step, new Error(`Logiless API auth error: ${response.status}`), { query, userId, orderNumber });
                        } else if (response.status === 404) { // {34} - エンドポイント自体がない場合など
                             logilessOrderInfo = `ロジレスAPIエンドポイントが見つかりません (404)`;
                             console.error(`[${step}] Logiless Search API endpoint not found (404). URL: ${logilessApiUrl}`);
                             await notifyError(step, new Error(`Logiless API endpoint not found (404)`), { query, userId, orderNumber });
                        } else { // {34} - その他のAPIエラー
                            logilessOrderInfo = "ロジレスAPIエラー";
                            const errorText = await response.text();
                            console.error(`[${step}] Logiless API request failed: ${response.status}, Response: ${errorText.substring(0, 500)}`);
                            await notifyError(step, new Error(`Logiless API request failed: ${response.status}`), { query, userId, orderNumber });
                        } // {34}
                    } // {33} - elseブロックの閉じ
                } catch (apiError) { // {32} - tryブロックの閉じに対応するcatch
                    if (!logilessOrderInfo) logilessOrderInfo = "ロジレス情報取得エラー";
                    await notifyError(step, apiError, { query, userId, orderNumber });
                    } // {32} - catchブロックの閉じ
                } // {33} End of else block
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

        // ★★★ NGキーワードチェックを追加 ★★★
        if (messageText && IGNORED_KEYWORDS.some(keyword => messageText.includes(keyword))) {
            const foundKeyword = IGNORED_KEYWORDS.find(keyword => messageText.includes(keyword)); // どのキーワードでスキップされたかログ用
            console.log(`[Filter] Skipping message containing ignored keyword: "${foundKeyword}"`);
            return new Response(JSON.stringify({ status: "skipped", reason: `ignored keyword: ${foundKeyword}` }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 200,
            });
        }
        // ★★★ ここまで追加 ★★★

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