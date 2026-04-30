import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client — lazily instantiated so the studio still loads if env
 * vars aren't set (e.g. during local dev before keys are configured).
 *
 * The save flow checks `isConfigured()` first and falls back to localStorage
 * (with a warning) when credentials are missing. That keeps the editor
 * functional in development without leaking errors into the user-facing UI.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const SUPABASE_DESIGNS_BUCKET =
  (import.meta.env.VITE_SUPABASE_DESIGNS_BUCKET as string | undefined) ??
  "design-previews";

export const SHOPIFY_FINALIZE_URL =
  (import.meta.env.VITE_SHOPIFY_FINALIZE_URL as string | undefined) ??
  "https://trims.in/pages/finalize";

let _client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!_client) _client = createClient(url!, anonKey!);
  return _client;
}
