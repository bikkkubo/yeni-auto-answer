export interface LogilessOrderInfo {
  url: string | null;
  status?: string;
  orderNumber: string;
  // 必要に応じて後で他のフィールドを追加
}

export async function getLogilessOrderInfo(orderNumber: string, apiKey: string | undefined): Promise<LogilessOrderInfo | null> {
  console.log(`[Logiless] 注文番号で検索: ${orderNumber}`);
  
  if (!apiKey) {
    console.error("[Logiless] APIキーがありません");
    return null;
  }

  try {
    const response = await fetch(`https://api.logiless.com/v1/orders/${orderNumber}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.error(`[Logiless] 注文が見つかりません: ${orderNumber}`);
        return null;
      }
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // APIレスポンスの型安全な検証
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid API response format');
    }

    // 注文情報の抽出
    const orderInfo: LogilessOrderInfo = {
      url: `https://admin.logiless.com/orders/${orderNumber}`, // 管理画面URL
      status: data.status || 'unknown',
      orderNumber: orderNumber
    };

    console.log(`[Logiless] 注文情報取得成功: ${JSON.stringify(orderInfo)}`);
    return orderInfo;

  } catch (error) {
    console.error(`[Logiless] API呼び出しエラー:`, error);
    return null;
  }
} 