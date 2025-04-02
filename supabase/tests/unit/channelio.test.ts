import { assertEquals, assertRejects } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { sendChannelioPrivateMessage } from "../../functions/_shared/channelio.ts";

// テスト用のモックデータ
const mockAuth = {
  accessKey: "test_access_key",
  accessSecret: "test_access_secret"
};

const mockChatId = "test_chat_id";
const mockMessage = "テストメッセージ";

Deno.test("Channel.io API - 正常系", async (t) => {
  await t.step("基本的なプライベートメッセージ送信", async () => {
    const result = await sendChannelioPrivateMessage(mockChatId, mockMessage, mockAuth);
    assertEquals(result, true);
  });

  await t.step("personIdを指定したメッセージ送信", async () => {
    const result = await sendChannelioPrivateMessage(
      mockChatId,
      mockMessage,
      mockAuth,
      { personId: "test_person_id" }
    );
    assertEquals(result, true);
  });
});

Deno.test("Channel.io API - 異常系", async (t) => {
  await t.step("認証情報なし", async () => {
    const result = await sendChannelioPrivateMessage(mockChatId, mockMessage, undefined);
    assertEquals(result, false);
  });

  await t.step("不完全な認証情報", async () => {
    const result = await sendChannelioPrivateMessage(
      mockChatId,
      mockMessage,
      { accessKey: "test_key", accessSecret: undefined as unknown as string }
    );
    assertEquals(result, false);
  });

  await t.step("無効なchatId", async () => {
    const result = await sendChannelioPrivateMessage("invalid_chat_id", mockMessage, mockAuth);
    assertEquals(result, false);
  });

  await t.step("空のメッセージ", async () => {
    const result = await sendChannelioPrivateMessage(mockChatId, "", mockAuth);
    assertEquals(result, false);
  });
});

// 実際のAPIコールをモックするためのヘルパー関数
async function mockFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  const url = input.toString();
  const options = init || {};

  // APIエンドポイントの検証
  if (!url.includes("/user-chats/")) {
    throw new Error("Invalid API endpoint");
  }

  // chatIdの検証
  if (url.includes("invalid_chat_id")) {
    return new Response(JSON.stringify({ error: "Invalid chat ID" }), { status: 404 });
  }

  // 認証ヘッダーの検証
  const headers = options.headers as Record<string, string>;
  const authHeader = headers?.Authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // リクエストボディの検証
  const body = JSON.parse(options.body as string);
  if (!body.message || !body.options?.includes("private")) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  // 成功レスポンス
  return new Response(JSON.stringify({ success: true }), { status: 200 });
}

// グローバルなfetchをモックに置き換え
globalThis.fetch = mockFetch as typeof fetch; 