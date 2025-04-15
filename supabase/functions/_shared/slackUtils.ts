// deno-lint-ignore-file no-explicit-any
import { getServiceRoleClient } from './supabaseClient.ts';

// --- Constants --- (Consider moving SLACK_BOT_TOKEN here if used only by Slack functions)
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
const THREAD_EXPIRATION_HOURS = 24; // ★ 24時間に戻す ★ スレッドを有効とみなす時間

// --- DB Helper Functions ---

/**
 * Retrieves the active thread timestamp for a given chat ID from the database.
 * @param chatId The Channel.io chat ID.
 * @returns The thread timestamp (ts) if an active thread exists, otherwise null.
 */
export async function getActiveThreadTs(chatId: string): Promise<string | null> {
  if (!chatId) return null;
  const supabase = getServiceRoleClient();
  const nowISO = new Date().toISOString(); // Get current time as ISO string for comparison

  try {
    const { data, error } = await supabase
      .from('slack_thread_store')
      .select('slack_thread_ts') // Select only the thread timestamp
      .eq('channelio_chat_id', chatId) // Match the chat ID
      .gt('expires_at', nowISO) // ★★★ Check if expiration time is in the future ★★★
      .order('last_updated_at', { ascending: false }) // Get the latest record just in case (though ideally only one active)
      .limit(1)
      .maybeSingle(); // Expect at most one result

    if (error) {
      console.error(`[DB] Error fetching thread TS for chatId ${chatId}:`, error);
      return null;
    }
    // Log the fetched data (for debugging)
    console.log(`[DB] Found active thread data for ${chatId} (expires_at > now):`, data);
    // Return the thread_ts if data is found, otherwise null
    return data?.slack_thread_ts || null;
  } catch (dbError) {
     console.error(`[DB] Unexpected error fetching thread TS for chatId ${chatId}:`, dbError);
     return null;
  }
}

/**
 * Saves or updates the thread timestamp and expiration for a given chat ID.
 * @param chatId The Channel.io chat ID.
 * @param threadTs The Slack message timestamp (ts) to save as the thread identifier.
 */
export async function saveThreadTs(chatId: string, threadTs: string): Promise<void> {
  if (!chatId || !threadTs) return;
  const supabase = getServiceRoleClient();
  const now = new Date(); // Get current time as Date object
  const expiresAt = new Date(now.getTime() + THREAD_EXPIRATION_HOURS * 60 * 60 * 1000); // Calculate expiration time

  try {
    const { error } = await supabase
      .from('slack_thread_store')
      .upsert(
        {
          channelio_chat_id: chatId,
          slack_thread_ts: threadTs,
          last_updated_at: now.toISOString(), // Save current time as ISO string
          expires_at: expiresAt.toISOString(),  // ★ Save calculated expiration time ★
        },
        { onConflict: 'channelio_chat_id' } // Update if channelio_chat_id already exists
      );

    if (error) {
      // Log the detailed error, including the potential NOT NULL violation hint
      console.error(`[DB] Error saving thread TS for chatId ${chatId}:`, error);
    } else {
      console.log(`[DB] Saved/Updated thread TS ${threadTs} for chatId ${chatId}`);
    }
  } catch (dbError) {
    console.error(`[DB] Unexpected error saving thread TS for chatId ${chatId}:`, dbError);
  }
}

// --- Slack API Helper Function ---

/**
 * Posts a message to a Slack channel, optionally replying to a thread.
 * @param channel The Slack channel ID.
 * @param text Fallback text for the notification.
 * @param blocks Optional Block Kit UI elements.
 * @param thread_ts Optional timestamp of a parent message to reply in a thread.
 * @returns The timestamp (ts) of the posted message if successful, otherwise null.
 */
export async function postToSlack(channel: string, text: string, blocks?: any[], thread_ts?: string): Promise<string | null> {
    if (!SLACK_BOT_TOKEN) { console.error("[Slack] SLACK_BOT_TOKEN is not set."); return null; }
    try {
        const payload: { channel: string; text: string; blocks?: any[]; thread_ts?: string } = {
            channel: channel,
            text: text,
        };
        if (blocks) { payload.blocks = blocks; }
        if (thread_ts) { payload.thread_ts = thread_ts; }

        const response = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error(`[Slack] Failed to post message to ${channel}. Status: ${response.status} ${response.statusText}. Response: ${errorData.substring(0, 500)}`);
            return null;
        }

        const data = await response.json();
        if (!data.ok) {
            console.error(`[Slack] API Error posting to ${channel}: ${data.error}`);
            return null;
        }

        console.log(`[Slack] Message posted successfully. Channel: ${channel}, Thread TS: ${thread_ts || 'N/A'}, Message TS: ${data.ts}`);
        return data.ts || null; // Return the message timestamp (ts)

    } catch (error) {
        console.error(`[Slack] Error during fetch to Slack channel ${channel}:`, error);
        return null;
    }
} 