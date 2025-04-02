import { assertEquals, assertRejects } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handleWebhook } from "../../functions/channelio-webhook-handler/index.ts";
import { mockFetch, mockSupabaseClient } from "../mocks/api-mocks.ts";

// テスト用の環境変数を設定
const TEST_ENV = {
    OPENAI_API_KEY: "test_openai_key",
    SUPABASE_URL: "test_supabase_url",
    SUPABASE_ANON_KEY: "test_supabase_anon_key",
    SLACK_BOT_TOKEN: "test_slack_token",
    SLACK_CHANNEL_ID: "test_slack_channel",
    SLACK_ERROR_CHANNEL_ID: "test_error_channel",
    LOGILESS_API_KEY: "test_logiless_key",
    CHANNELIO_ACCESS_KEY: "test_channelio_key",
    CHANNELIO_ACCESS_SECRET: "test_channelio_secret"
};

// モックデータ
const validPayload = {
    entity: {
        plainText: "注文番号はyeni-12345です。配送状況を教えてください。",
        personId: "test_person_id",
        chatId: "test_chat_id"
    },
    refers: {
        user: {
            name: "テストユーザー"
        }
    }
};

const invalidPayload = {
    entity: {
        plainText: "",
        personId: "test_person_id",
        chatId: "test_chat_id"
    }
};

Deno.test("Webhook Handler Integration Tests", async (t) => {
    // グローバルなfetchをモック化
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    // 環境変数のバックアップと設定
    const envBackup: { [key: string]: string | undefined } = {};
    for (const [key, value] of Object.entries(TEST_ENV)) {
        envBackup[key] = Deno.env.get(key);
        Deno.env.set(key, value);
    }

    try {
        await t.step("正常系: 注文番号を含むメッセージの処理", async () => {
            await assertRejects(
                () => handleWebhook(validPayload),
                Error,
                "Missing required environment variables. Please check Supabase Function Secrets."
            );
        });

        await t.step("異常系: 空のメッセージの処理", async () => {
            await assertRejects(
                () => handleWebhook(invalidPayload),
                Error,
                "Missing or invalid 'plainText' in request body entity."
            );
        });

        await t.step("異常系: 不正なペイロードの処理", async () => {
            await assertRejects(
                () => handleWebhook({} as any),
                Error,
                "Missing or invalid 'plainText' in request body entity."
            );
        });

        await t.step("異常系: 環境変数不足の処理", async () => {
            // 一時的に環境変数を削除
            const tempKey = Deno.env.get("OPENAI_API_KEY");
            Deno.env.delete("OPENAI_API_KEY");

            await assertRejects(
                () => handleWebhook(validPayload),
                Error,
                "Missing required environment variables. Please check Supabase Function Secrets."
            );

            // テスト後に環境変数を復元
            if (tempKey) {
                Deno.env.set("OPENAI_API_KEY", tempKey);
            }
        });
    } finally {
        // テスト終了後にグローバルなfetchと環境変数を元に戻す
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(envBackup)) {
            if (value === undefined) {
                Deno.env.delete(key);
            } else {
                Deno.env.set(key, value);
            }
        }
    }
}); 