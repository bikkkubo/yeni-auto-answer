export async function sendChannelioPrivateMessage(
  chatId: string,
  message: string,
  auth: { accessKey: string | undefined; accessSecret: string | undefined },
  personId?: string
): Promise<boolean> {
  console.log(`[Channel.io] メッセージ送信開始 (Chat ID: ${chatId})`);
  
  if (!auth?.accessKey || !auth?.accessSecret) {
    console.error("[Channel.io] Access Key または Access Secret が不足しています");
    return false;
  }

  try {
    const response = await fetch(`https://api.channel.io/open/v5/user-chats/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-key': auth.accessKey,
        'x-access-secret': auth.accessSecret,
      },
      body: JSON.stringify({
        message: message,
        options: ["private"],
        personId: personId,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Channel.io] APIエラー: ${response.status} ${response.statusText}`, errorBody);
      return false;
    }

    console.log(`[Channel.io] プライベートメッセージ送信成功: ${message.substring(0, 50)}...`);
    return true;

  } catch (error) {
    console.error(`[Channel.io] メッセージ送信中に予期せぬエラーが発生しました:`, error);
    return false;
  }
} 