// supabase/functions/slack-interactive-handler/index.ts
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifySlackRequest } from "../_shared/slackVerify.ts"; // Slackリクエスト検証ヘルパー
import { corsHeaders } from "../_shared/cors.ts"; // CORSヘッダー (OPTIONS用に必要かも)

// --- Environment Variables ---
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// --- Type Definitions (from Slack API docs / payload observation) ---
interface SlackAction {
    action_id: string;
    value: string;
    // ... other potential fields
}

interface SlackMessage {
    ts: string;
    thread_ts?: string;
    // ... other potential fields
}

interface SlackChannel {
    id: string;
    name: string;
}

interface SlackUser {
    id: string;
    name: string;
}

interface SlackInteractionPayload {
    type: string; // e.g., 'block_actions'
    actions: SlackAction[];
    message: SlackMessage;
    channel: SlackChannel;
    user: SlackUser;
    // ... other potential fields like trigger_id, response_url etc.
}

// --- Main Handler ---
serve(async (req: Request) => {
    // Handle CORS preflight requests if necessary (though Slack might not send OPTIONS)
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    // --- Environment Variable Check ---
    if (!SLACK_SIGNING_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error("[slack-interactive-handler] Missing required environment variables (SLACK_SIGNING_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).");
        return new Response("Internal Server Configuration Error", { status: 500 });
    }

    // --- Slack Request Verification (CRITICAL) ---
    let rawBody: Uint8Array;
    try {
        // Need the raw body for signature verification
        rawBody = await req.clone().arrayBuffer().then(buffer => new Uint8Array(buffer));
        const valid = await verifySlackRequest(req, rawBody, SLACK_SIGNING_SECRET);
        if (!valid) {
            console.error("[slack-interactive-handler] Invalid Slack signature.");
            return new Response("Unauthorized: Invalid signature", { status: 401 });
        }
    } catch (verificationError) {
         console.error("[slack-interactive-handler] Error during Slack request verification:", verificationError);
         return new Response("Internal Server Error during verification", { status: 500 });
    }

    // --- Process Valid Request ---
    try {
        // Parse the payload from the form data
        const formData = await req.formData();
        const payloadStr = formData.get("payload") as string | null;
        if (!payloadStr) {
            console.warn("[slack-interactive-handler] Received request without payload form data.");
            throw new Error("Missing payload in form data");
        }
        const payload: SlackInteractionPayload = JSON.parse(payloadStr);
        console.log("[slack-interactive-handler] Received interactive payload type:", payload.type); // Log payload type

        // We only care about block actions (button clicks) for now
        if (payload.type !== 'block_actions' || !payload.actions || payload.actions.length === 0) {
             console.log("[slack-interactive-handler] Ignoring non-block_actions payload or empty actions.");
             return new Response(null, { status: 200 }); // Acknowledge but do nothing
        }

        // Extract necessary data
        const action = payload.actions[0];
        const actionId = action.action_id;
        const valueStr = action.value;
        // Use thread_ts if available, otherwise use message ts (ts is the parent message ts in a thread)
        const threadTs = payload.message?.thread_ts || payload.message?.ts;
        const channelId = payload.channel?.id;
        const userId = payload.user?.id; // User who clicked the button

        if (!actionId || !valueStr || !threadTs) {
            console.error("[slack-interactive-handler] Missing required fields in payload action/message.", { actionId, valueStr, threadTs });
            throw new Error("Missing required fields in payload (action_id, value, thread_ts/ts)");
        }

        // Parse the context embedded in the value
        let feedbackContext: { originalQuery?: string; chatId?: string } = {};
        try {
            feedbackContext = JSON.parse(valueStr);
        } catch (parseError) {
            console.error("[slack-interactive-handler] Failed to parse feedbackContext JSON from value:", valueStr, parseError);
            // Proceed without context if parsing fails, but log it
        }

        const originalQuery = feedbackContext.originalQuery || "(Could not parse original query)";
        const channelioChatId = feedbackContext.chatId; // May be undefined if parsing failed

        // Determine feedback type
        let feedbackType = "";
        if (actionId === "ignore_ai_button") {
            feedbackType = "ignore_ai";
        } else if (actionId === "ignore_notification_button") {
            feedbackType = "ignore_notification";
        } else {
            console.warn(`[slack-interactive-handler] Received unknown action_id: ${actionId}`);
            // Acknowledge Slack but don't process unknown actions
            return new Response(null, { status: 200 });
        }

        // --- Database Interaction ---
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
             global: { fetch: fetch }, // Important for Deno environment
             auth: {
                 persistSession: false // No need to persist session for server-side operations
             }
         });

        const { error: insertError } = await supabase
            .from('slack_feedback') // Your feedback table name
            .insert({
                feedback_type: feedbackType,
                message_content: originalQuery,
                channelio_chat_id: channelioChatId, // Can be null
                slack_thread_ts: threadTs,
                // status defaults to 'pending'
            });

        if (insertError) {
            console.error("[slack-interactive-handler] Failed to insert feedback into Supabase:", insertError);
            throw new Error(`Supabase insert error: ${insertError.message}`);
        }

        console.log(`[slack-interactive-handler] Feedback recorded successfully: Type='${feedbackType}', Thread='${threadTs}'`);

        // --- Acknowledge Slack (CRITICAL) ---
        // Respond quickly within 3 seconds
        // Optionally, you could update the original message here using payload.response_url
        // but for simplicity, just send 200 OK for now.
        return new Response(null, { status: 200, headers: corsHeaders });

    } catch (error) {
        console.error("[slack-interactive-handler] Error handling Slack interaction:", error);
        // Consider sending an error notification to your error Slack channel here as well
        return new Response("Internal Server Error", { status: 500 });
    }
});

console.log("Slack interactive handler function started.");
