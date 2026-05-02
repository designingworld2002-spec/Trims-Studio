import { getSupabase, SUPABASE_DESIGNS_BUCKET } from "./supabase";

/**
 * Read-side Supabase helpers used by the "Recent designs" + "Your uploads"
 * UI. Every function gracefully short-circuits when Supabase isn't
 * configured or the user is anonymous — callers can render an empty list
 * without checking.
 */

const ASSETS_BUCKET =
  (import.meta.env.VITE_SUPABASE_ASSETS_BUCKET as string | undefined) ??
  "design-assets";

export interface RecentDesign {
  id: string;
  created_at: string;
  product_title: string | null;
  product_slug: string | null;
  length_mm: number;
  width_mm: number;
  preview_url: string | null;
  fabric_json: any;
}

export async function fetchRecentDesigns(
  customerId: string | null,
  limit = 12
): Promise<RecentDesign[]> {
  const supabase = getSupabase();
  if (!supabase || !customerId) return [];
  const { data, error } = await supabase
    .from("user_designs")
    .select(
      "id, created_at, product_title, product_slug, length_mm, width_mm, preview_url, fabric_json"
    )
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[recent designs] query failed:", error);
    return [];
  }
  return (data ?? []) as RecentDesign[];
}

export interface RecentUpload {
  /** Stable identifier inside the bucket — `customerId/uuid.ext`. */
  path: string;
  name: string;
  url: string;
  createdAt: string | null;
}

export async function fetchRecentUploads(
  customerId: string | null,
  limit = 60
): Promise<RecentUpload[]> {
  const supabase = getSupabase();
  if (!supabase || !customerId) return [];
  const folder = customerId;
  const { data, error } = await supabase.storage
    .from(ASSETS_BUCKET)
    .list(folder, {
      limit,
      sortBy: { column: "created_at", order: "desc" },
    });
  if (error) {
    console.warn("[recent uploads] list failed:", error);
    return [];
  }
  return (data ?? [])
    .filter((f) => f.name && !f.name.startsWith("."))
    .map((f) => {
      const path = `${folder}/${f.name}`;
      const { data: pub } = supabase.storage
        .from(ASSETS_BUCKET)
        .getPublicUrl(path);
      return {
        path,
        name: f.name,
        url: pub?.publicUrl ?? "",
        createdAt: (f as any).created_at ?? null,
      };
    });
}

export async function uploadAsset(
  customerId: string | null,
  file: File
): Promise<RecentUpload | null> {
  const supabase = getSupabase();
  if (!supabase || !customerId) return null;
  const ext =
    file.name.includes(".") ? file.name.split(".").pop() : file.type.split("/").pop();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `${customerId}/${id}.${ext ?? "png"}`;
  const { error } = await supabase.storage
    .from(ASSETS_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) {
    console.warn("[upload asset] failed:", error);
    return null;
  }
  const { data: pub } = supabase.storage.from(ASSETS_BUCKET).getPublicUrl(path);
  return {
    path,
    name: file.name,
    url: pub?.publicUrl ?? "",
    createdAt: new Date().toISOString(),
  };
}

export async function deleteAsset(path: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.storage.from(ASSETS_BUCKET).remove([path]);
  if (error) {
    console.warn("[delete asset] failed:", error);
    return false;
  }
  return true;
}

/**
 * Convenience: load the JSON payload for a single saved design when only
 * the row id is known (e.g. clicking a recent-design tile).
 */
export async function fetchDesign(id: string): Promise<RecentDesign | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_designs")
    .select(
      "id, created_at, product_title, product_slug, length_mm, width_mm, preview_url, fabric_json"
    )
    .eq("id", id)
    .single();
  if (error) {
    console.warn("[fetch design] failed:", error);
    return null;
  }
  return data as RecentDesign;
}

export { ASSETS_BUCKET, SUPABASE_DESIGNS_BUCKET };
