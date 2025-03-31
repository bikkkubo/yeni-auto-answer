// Common CORS headers for Supabase Functions
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // Allow requests from any origin (adjust if needed)
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', // Allow specific headers
  'Access-Control-Allow-Methods': 'POST, OPTIONS', // Allow POST and OPTIONS methods
}; 