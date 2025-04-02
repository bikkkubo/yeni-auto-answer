export interface ChannelioMessageOptions {
  personId?: string;
  isPrivate?: boolean;
}

interface ChannelioAuth {
  accessKey: string;
  accessSecret: string;
}

export async function sendChannelioPrivateMessage(
  chatId: string,
  message: string,
  auth: ChannelioAuth | undefined,
  options: ChannelioMessageOptions = { isPrivate: true }
): Promise<boolean> {
  console.log(`[Channel.io] メッセージ送信開始 (Chat ID: ${chatId})`);
  
  if (!auth?.accessKey || !auth?.accessSecret) {
    console.error("[Channel.io] 認証情報が不足しています");
    return false;
  }

  try {
    // Basic認証用のトークンを生成
    const authToken = btoa(`${auth.accessKey}:${auth.accessSecret}`);

    const response = await fetch(`https://api.channel.io/open/v5/user-chats/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: message,
        options: ["private"], // プライベートメッセージとして送信
        personId: options.personId, // オプショナル
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // レスポンスの検証
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid API response format');
    }

    console.log(`[Channel.io] メッセージ送信成功: ${message}`);
    return true;

  } catch (error) {
    console.error(`[Channel.io] メッセージ送信エラー:`, error);
    return false;
  }
} 