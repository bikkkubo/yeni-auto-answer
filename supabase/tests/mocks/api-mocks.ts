// OpenAI APIのモック
export const mockOpenAIResponse = {
    data: [{
        embedding: new Array(1536).fill(0.1),
    }],
};

export const mockOpenAICompletionResponse = {
    choices: [{
        message: {
            content: "テストユーザー様\n\nお問い合わせいただき、ありがとうございます。\nyeniカスタマーサポートでございます。\n\nご注文番号yeni-12345の件についてですね。現在確認をさせていただいております。\n\nどうぞよろしくお願い申し上げます。",
        },
    }],
};

// Supabase RPCのモック
export const mockSupabaseResponse = {
    data: [{
        content: "テスト用の参考情報です。",
        source_type: "faq",
        question: "テスト質問",
    }],
    error: null,
};

// Slack APIのモック
export const mockSlackResponse = {
    ok: true,
    channel: "test_channel",
    ts: "1234567890.123456",
};

// Channel.io APIのモック
export const mockChannelioResponse = {
    success: true,
};

// Logiless APIのモック
export const mockLogilessResponse = {
    url: "https://logiless.example.com/orders/yeni-12345",
    status: "発送準備中",
    orderNumber: "yeni-12345",
};

// モックfetch関数
export async function mockFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
    const url = input.toString();
    
    if (url.includes("openai.com/v1/embeddings")) {
        return new Response(JSON.stringify(mockOpenAIResponse), { status: 200 });
    }
    
    if (url.includes("openai.com/v1/chat/completions")) {
        return new Response(JSON.stringify(mockOpenAICompletionResponse), { status: 200 });
    }
    
    if (url.includes("slack.com/api/chat.postMessage")) {
        return new Response(JSON.stringify(mockSlackResponse), { status: 200 });
    }
    
    if (url.includes("user-chats")) {
        return new Response(JSON.stringify(mockChannelioResponse), { status: 200 });
    }
    
    if (url.includes("logiless.com")) {
        return new Response(JSON.stringify(mockLogilessResponse), { status: 200 });
    }
    
    throw new Error(`Unhandled mock URL: ${url}`);
}

// モックSupabaseクライアント
export const mockSupabaseClient = {
    rpc: async () => mockSupabaseResponse,
}; 